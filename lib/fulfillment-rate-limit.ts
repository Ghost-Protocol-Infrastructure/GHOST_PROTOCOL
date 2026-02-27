import { NextRequest } from "next/server";
import { emitFulfillmentAlert } from "@/lib/fulfillment-observability";

export type FulfillmentRateLimitAction = "ticket" | "capture" | "expire_sweep";

type Bucket = {
  count: number;
  resetAtMs: number;
};

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_LIMITS_PER_WINDOW: Record<FulfillmentRateLimitAction, number> = {
  ticket: 120,
  capture: 180,
  expire_sweep: 30,
};

const buckets = new Map<string, Bucket>();
let lastSweepAtMs = 0;

const parsePositiveInt = (raw: string | undefined, fallback: number): number => {
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const getWindowMs = (): number => {
  const parsed = parsePositiveInt(process.env.GHOST_FULFILLMENT_RATE_LIMIT_WINDOW_MS, DEFAULT_WINDOW_MS);
  return Math.max(1_000, Math.min(10 * 60_000, parsed));
};

const getLimitsPerWindow = (): Record<FulfillmentRateLimitAction, number> => ({
  ticket: parsePositiveInt(
    process.env.GHOST_FULFILLMENT_RATE_LIMIT_TICKET_PER_WINDOW,
    DEFAULT_LIMITS_PER_WINDOW.ticket,
  ),
  capture: parsePositiveInt(
    process.env.GHOST_FULFILLMENT_RATE_LIMIT_CAPTURE_PER_WINDOW,
    DEFAULT_LIMITS_PER_WINDOW.capture,
  ),
  expire_sweep: parsePositiveInt(
    process.env.GHOST_FULFILLMENT_RATE_LIMIT_EXPIRE_SWEEP_PER_WINDOW,
    DEFAULT_LIMITS_PER_WINDOW.expire_sweep,
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

export const consumeFulfillmentRateLimit = (input: {
  request: NextRequest;
  action: FulfillmentRateLimitAction;
  scopeKey?: string | null;
  actorKey?: string | null;
  nowMs?: number;
}): { ok: true } | { ok: false; status: 429; errorCode: "RATE_LIMITED"; error: string; retryAfterSeconds: number } => {
  const nowMs = input.nowMs ?? Date.now();
  const windowMs = getWindowMs();
  const limitsPerWindow = getLimitsPerWindow();
  sweepExpiredBuckets(nowMs, windowMs);

  const ip = getClientIp(input.request).toLowerCase();
  const actorKey = (input.actorKey ?? "anonymous").toLowerCase();
  const scopeKey = (input.scopeKey ?? "global").toLowerCase();
  const key = `${input.action}:${scopeKey}:${actorKey}:${ip}`;

  const limit = limitsPerWindow[input.action];
  const existing = buckets.get(key);
  if (!existing || existing.resetAtMs <= nowMs) {
    buckets.set(key, { count: 1, resetAtMs: nowMs + windowMs });
    return { ok: true };
  }

  if (existing.count >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAtMs - nowMs) / 1000));
    emitFulfillmentAlert({
      route: input.action,
      code: "RATE_LIMITED",
      severity: "warning",
      details: {
        action: input.action,
        scopeKey,
        actorKey,
        ip,
        limit,
        retryAfterSeconds,
      },
    });
    return {
      ok: false,
      status: 429,
      errorCode: "RATE_LIMITED",
      error: `Too many fulfillment ${input.action.replace("_", " ")} requests. Try again in ${retryAfterSeconds}s.`,
      retryAfterSeconds,
    };
  }

  existing.count += 1;
  buckets.set(key, existing);
  return { ok: true };
};

