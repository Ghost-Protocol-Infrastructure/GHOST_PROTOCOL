import { NextRequest } from "next/server";

type X402RateLimitAction = "signer" | "service" | "payer_service";

type Bucket = {
  count: number;
  resetAtMs: number;
};

const DEFAULT_WINDOW_MS = 60 * 60 * 1_000;
const DEFAULT_LIMITS_PER_WINDOW: Record<X402RateLimitAction, number> = {
  signer: 1_000,
  service: 5_000,
  payer_service: 10,
};

const buckets = new Map<string, Bucket>();
let lastSweepAtMs = 0;

const parsePositiveInt = (raw: string | undefined, fallback: number, max = 100_000): number => {
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
};

const getWindowMs = (): number =>
  parsePositiveInt(process.env.GHOST_X402_RATE_LIMIT_WINDOW_MS, DEFAULT_WINDOW_MS, 24 * 60 * 60 * 1_000);

const getLimitsPerWindow = (): Record<X402RateLimitAction, number> => ({
  signer: parsePositiveInt(
    process.env.GHOST_X402_RATE_LIMIT_SIGNER_PER_WINDOW,
    DEFAULT_LIMITS_PER_WINDOW.signer,
  ),
  service: parsePositiveInt(
    process.env.GHOST_X402_RATE_LIMIT_SERVICE_PER_WINDOW,
    DEFAULT_LIMITS_PER_WINDOW.service,
  ),
  payer_service: parsePositiveInt(
    process.env.GHOST_X402_RATE_LIMIT_PAYER_SERVICE_PER_WINDOW,
    DEFAULT_LIMITS_PER_WINDOW.payer_service,
  ),
});

const getClientIp = (request: NextRequest): string => {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  return "unknown";
};

const sweepExpiredBuckets = (nowMs: number, windowMs: number): void => {
  if (nowMs - lastSweepAtMs < windowMs) return;
  lastSweepAtMs = nowMs;
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.resetAtMs <= nowMs) buckets.delete(key);
  }
};

const consumeBucket = (input: {
  action: X402RateLimitAction;
  key: string;
  limit: number;
  windowMs: number;
  nowMs: number;
}): { ok: true } | { ok: false; retryAfterSeconds: number } => {
  const existing = buckets.get(input.key);
  if (!existing || existing.resetAtMs <= input.nowMs) {
    buckets.set(input.key, { count: 1, resetAtMs: input.nowMs + input.windowMs });
    return { ok: true };
  }

  if (existing.count >= input.limit) {
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAtMs - input.nowMs) / 1_000)),
    };
  }

  existing.count += 1;
  buckets.set(input.key, existing);
  return { ok: true };
};

export const consumeX402SettlementRateLimit = (input: {
  request: NextRequest;
  signerAddress: string;
  serviceSlug: string;
  payerIdentity: string;
  nowMs?: number;
}): { ok: true } | { ok: false; status: 429; errorCode: "RATE_LIMITED"; error: string; retryAfterSeconds: number } => {
  const nowMs = input.nowMs ?? Date.now();
  const windowMs = getWindowMs();
  sweepExpiredBuckets(nowMs, windowMs);

  const limitsPerWindow = getLimitsPerWindow();
  const ip = getClientIp(input.request).toLowerCase();
  const signerAddress = input.signerAddress.toLowerCase();
  const serviceSlug = input.serviceSlug.toLowerCase();
  const payerIdentity = input.payerIdentity.toLowerCase();

  const checks: Array<{ action: X402RateLimitAction; key: string; limit: number }> = [
    {
      action: "signer",
      key: `x402:signer:${signerAddress}:${ip}`,
      limit: limitsPerWindow.signer,
    },
    {
      action: "service",
      key: `x402:service:${serviceSlug}`,
      limit: limitsPerWindow.service,
    },
    {
      action: "payer_service",
      key: `x402:payer_service:${serviceSlug}:${payerIdentity}`,
      limit: limitsPerWindow.payer_service,
    },
  ];

  for (const check of checks) {
    const result = consumeBucket({
      action: check.action,
      key: check.key,
      limit: check.limit,
      windowMs,
      nowMs,
    });
    if (!result.ok) {
      return {
        ok: false,
        status: 429,
        errorCode: "RATE_LIMITED",
        error: `Too many x402 settlement reports for ${check.action.replace("_", " ")}. Try again in ${result.retryAfterSeconds}s.`,
        retryAfterSeconds: result.retryAfterSeconds,
      };
    }
  }

  return { ok: true };
};
