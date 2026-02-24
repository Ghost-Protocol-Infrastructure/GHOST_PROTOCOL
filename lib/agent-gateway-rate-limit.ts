import { NextRequest } from "next/server";

type AgentGatewayRateLimitAction = "config" | "verify";

type Bucket = {
  count: number;
  resetAtMs: number;
};

const WINDOW_MS = 60_000;
const LIMITS_PER_WINDOW: Record<AgentGatewayRateLimitAction, number> = {
  config: 10,
  verify: 12,
};

const buckets = new Map<string, Bucket>();
let lastSweepAtMs = 0;

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

const sweepExpiredBuckets = (nowMs: number): void => {
  if (nowMs - lastSweepAtMs < WINDOW_MS) return;
  lastSweepAtMs = nowMs;
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.resetAtMs <= nowMs) buckets.delete(key);
  }
};

export const consumeAgentGatewayRateLimit = (input: {
  request: NextRequest;
  action: AgentGatewayRateLimitAction;
  actorAddress?: string | null;
  agentId?: string | null;
  nowMs?: number;
}): { ok: true } | { ok: false; status: 429; error: string; retryAfterSeconds: number } => {
  const nowMs = input.nowMs ?? Date.now();
  sweepExpiredBuckets(nowMs);

  const ip = getClientIp(input.request).toLowerCase();
  const actor = (input.actorAddress ?? "unknown").toLowerCase();
  const agentId = input.agentId ?? "unknown";
  const key = `${input.action}:${agentId}:${actor}:${ip}`;
  const limit = LIMITS_PER_WINDOW[input.action];

  const existing = buckets.get(key);
  if (!existing || existing.resetAtMs <= nowMs) {
    buckets.set(key, { count: 1, resetAtMs: nowMs + WINDOW_MS });
    return { ok: true };
  }

  if (existing.count >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAtMs - nowMs) / 1000));
    return {
      ok: false,
      status: 429,
      error: `Too many merchant gateway ${input.action} attempts. Try again in ${retryAfterSeconds}s.`,
      retryAfterSeconds,
    };
  }

  existing.count += 1;
  buckets.set(key, existing);
  return { ok: true };
};
