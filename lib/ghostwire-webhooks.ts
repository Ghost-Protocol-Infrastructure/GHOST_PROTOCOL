import { createHmac, timingSafeEqual } from "node:crypto";
import { GHOSTWIRE_WEBHOOK_REPLAY_WINDOW_SECONDS } from "@/lib/ghostwire-config";

export const GHOSTWIRE_WEBHOOK_SIGNATURE_VERSION = "v1";

export const buildGhostWireWebhookSigningPayload = (timestamp: string, rawBody: string): string =>
  `${timestamp}.${rawBody}`;

export const signGhostWireWebhookPayload = (input: {
  secret: string;
  timestamp: string;
  rawBody: string;
}): string => {
  const digest = createHmac("sha256", input.secret)
    .update(buildGhostWireWebhookSigningPayload(input.timestamp, input.rawBody), "utf8")
    .digest("hex");
  return `${GHOSTWIRE_WEBHOOK_SIGNATURE_VERSION}=${digest}`;
};

export const isGhostWireWebhookTimestampFresh = (timestamp: string, nowMs = Date.now()): boolean => {
  if (!/^\d+$/.test(timestamp)) return false;
  const parsed = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return false;
  const ageSeconds = Math.abs(Math.floor(nowMs / 1000) - parsed);
  return ageSeconds <= GHOSTWIRE_WEBHOOK_REPLAY_WINDOW_SECONDS;
};

export const verifyGhostWireWebhookSignature = (input: {
  secret: string;
  timestamp: string;
  rawBody: string;
  signature: string;
  nowMs?: number;
}): boolean => {
  if (!isGhostWireWebhookTimestampFresh(input.timestamp, input.nowMs)) {
    return false;
  }

  const expected = signGhostWireWebhookPayload({
    secret: input.secret,
    timestamp: input.timestamp,
    rawBody: input.rawBody,
  });

  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(input.signature.trim());
  if (expectedBuffer.length !== providedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, providedBuffer);
};

