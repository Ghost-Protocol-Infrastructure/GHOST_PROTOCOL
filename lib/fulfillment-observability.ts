type FulfillmentRouteName = "ticket" | "capture" | "expire_sweep";

type FulfillmentAlertSeverity = "warning" | "critical";

type FulfillmentResponseEventInput = {
  route: FulfillmentRouteName;
  status: number;
  errorCode?: string | null;
  meta?: Record<string, unknown>;
};

const DEFAULT_ALERT_THRESHOLD_PER_MINUTE = 5;
const DEFAULT_ALERT_WINDOW_MS = 60_000;

const CRITICAL_ERROR_CODES = new Set([
  "FULFILLMENT_CAPTURE_FAILED",
  "FULFILLMENT_EXPIRE_SWEEP_FAILED",
  "FULFILLMENT_TICKET_FAILED",
  "PHASE_C_SCHEMA_UNAVAILABLE",
  "FULFILLMENT_SIGNER_NOT_CONFIGURED",
]);

type ErrorBucket = {
  count: number;
  resetAtMs: number;
};

const errorBuckets = new Map<string, ErrorBucket>();
let lastSweepAtMs = 0;

const parsePositiveInt = (raw: string | undefined, fallback: number): number => {
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const getAlertThresholdPerMinute = (): number =>
  parsePositiveInt(process.env.GHOST_FULFILLMENT_ALERT_THRESHOLD_PER_MINUTE, DEFAULT_ALERT_THRESHOLD_PER_MINUTE);

const getAlertWindowMs = (): number => {
  const parsed = parsePositiveInt(process.env.GHOST_FULFILLMENT_ALERT_WINDOW_MS, DEFAULT_ALERT_WINDOW_MS);
  return Math.max(1_000, Math.min(10 * 60_000, parsed));
};

const sweepExpiredBuckets = (nowMs: number, windowMs: number): void => {
  if (nowMs - lastSweepAtMs < windowMs) return;
  lastSweepAtMs = nowMs;
  for (const [key, bucket] of errorBuckets.entries()) {
    if (bucket.resetAtMs <= nowMs) errorBuckets.delete(key);
  }
};

const log = (level: "info" | "warn" | "error", payload: Record<string, unknown>): void => {
  if (level === "error") {
    console.error(payload);
    return;
  }
  if (level === "warn") {
    console.warn(payload);
    return;
  }
  console.info(payload);
};

export const extractFulfillmentErrorCode = (body: unknown): string | null => {
  if (typeof body !== "object" || body == null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const code = record.errorCode;
  return typeof code === "string" && code.trim() ? code.trim() : null;
};

export const emitFulfillmentAlert = (input: {
  route: FulfillmentRouteName;
  code: string;
  severity: FulfillmentAlertSeverity;
  details?: Record<string, unknown>;
}): void => {
  const payload = {
    event: "FULFILLMENT_ALERT",
    severity: input.severity,
    route: input.route,
    code: input.code,
    timestamp: new Date().toISOString(),
    ...(input.details ? { details: input.details } : {}),
  } satisfies Record<string, unknown>;

  log(input.severity === "critical" ? "error" : "warn", payload);
};

export const observeFulfillmentResponseEvent = (input: FulfillmentResponseEventInput): void => {
  const nowMs = Date.now();
  const windowMs = getAlertWindowMs();
  const alertThreshold = getAlertThresholdPerMinute();

  sweepExpiredBuckets(nowMs, windowMs);

  const statusClass = Math.trunc(input.status / 100);
  const level =
    input.status >= 500 ? "error" : input.status >= 400 || input.status === 429 ? "warn" : "info";

  const payload = {
    event: "fulfillment.route.response",
    route: input.route,
    status: input.status,
    statusClass,
    errorCode: input.errorCode ?? null,
    timestamp: new Date(nowMs).toISOString(),
    ...(input.meta ? { meta: input.meta } : {}),
  } satisfies Record<string, unknown>;

  log(level, payload);

  const shouldTrackAsError = input.status >= 400;
  if (!shouldTrackAsError) return;

  const errorCode = input.errorCode ?? "UNKNOWN_ERROR";
  const bucketKey = `${input.route}:${errorCode}`;
  const existing = errorBuckets.get(bucketKey);
  if (!existing || existing.resetAtMs <= nowMs) {
    errorBuckets.set(bucketKey, { count: 1, resetAtMs: nowMs + windowMs });
  } else {
    existing.count += 1;
    errorBuckets.set(bucketKey, existing);
  }

  const count = errorBuckets.get(bucketKey)?.count ?? 1;
  const critical = input.status >= 500 || CRITICAL_ERROR_CODES.has(errorCode);
  const thresholdHit = count >= alertThreshold && count % alertThreshold === 0;

  if (critical || thresholdHit) {
    emitFulfillmentAlert({
      route: input.route,
      code: errorCode,
      severity: critical ? "critical" : "warning",
      details: {
        status: input.status,
        countInWindow: count,
        windowMs,
      },
    });
  }
};

