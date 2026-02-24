export const MERCHANT_GATEWAY_AUTH_SCOPE = "agent_gateway";
export const MERCHANT_GATEWAY_AUTH_VERSION = "1";
export const MERCHANT_GATEWAY_AUTH_MAX_AGE_SECONDS = 300;

export type MerchantGatewayAuthAction = "config" | "verify";

export type MerchantGatewayAuthPayload = {
  scope: typeof MERCHANT_GATEWAY_AUTH_SCOPE;
  version: typeof MERCHANT_GATEWAY_AUTH_VERSION;
  action: MerchantGatewayAuthAction;
  agentId: string;
  ownerAddress: string;
  actorAddress: string;
  serviceSlug: string;
  nonce: string;
  issuedAt: number;
};

const isPrintableAscii = (value: string): boolean => /^[\x20-\x7E]+$/.test(value);
const isHexAddressLower = (value: string): boolean => /^0x[a-f0-9]{40}$/.test(value);

const normalizeStringField = (value: unknown, maxLen: number): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLen || !isPrintableAscii(trimmed)) return null;
  return trimmed;
};

export const normalizeMerchantGatewayAuthPayload = (value: unknown): MerchantGatewayAuthPayload | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  if (record.scope !== MERCHANT_GATEWAY_AUTH_SCOPE) return null;
  if (record.version !== MERCHANT_GATEWAY_AUTH_VERSION) return null;
  const action = record.action;
  if (action !== "config" && action !== "verify") return null;

  const agentId = normalizeStringField(record.agentId, 64);
  const ownerAddress = typeof record.ownerAddress === "string" ? record.ownerAddress.trim().toLowerCase() : null;
  const actorAddress = typeof record.actorAddress === "string" ? record.actorAddress.trim().toLowerCase() : null;
  const serviceSlug = normalizeStringField(record.serviceSlug, 128);
  const nonce = normalizeStringField(record.nonce, 128);
  const issuedAt =
    typeof record.issuedAt === "number" && Number.isFinite(record.issuedAt) ? Math.trunc(record.issuedAt) : null;

  if (!agentId || !serviceSlug || !nonce || issuedAt == null) return null;
  if (!ownerAddress || !isHexAddressLower(ownerAddress)) return null;
  if (!actorAddress || !isHexAddressLower(actorAddress)) return null;
  if (issuedAt <= 0) return null;

  return {
    scope: MERCHANT_GATEWAY_AUTH_SCOPE,
    version: MERCHANT_GATEWAY_AUTH_VERSION,
    action,
    agentId,
    ownerAddress,
    actorAddress,
    serviceSlug,
    nonce,
    issuedAt,
  };
};

export const createMerchantGatewayAuthPayload = (input: {
  action: MerchantGatewayAuthAction;
  agentId: string;
  ownerAddress: string;
  actorAddress: string;
  serviceSlug: string;
  nonce: string;
  issuedAt?: number;
}): MerchantGatewayAuthPayload => ({
  scope: MERCHANT_GATEWAY_AUTH_SCOPE,
  version: MERCHANT_GATEWAY_AUTH_VERSION,
  action: input.action,
  agentId: input.agentId,
  ownerAddress: input.ownerAddress.trim().toLowerCase(),
  actorAddress: input.actorAddress.trim().toLowerCase(),
  serviceSlug: input.serviceSlug,
  nonce: input.nonce,
  issuedAt: input.issuedAt ?? Math.floor(Date.now() / 1000),
});

export const buildMerchantGatewayAuthMessage = (payload: MerchantGatewayAuthPayload): string =>
  [
    "Ghost Protocol Merchant Gateway Authorization",
    `scope:${payload.scope}`,
    `version:${payload.version}`,
    `action:${payload.action}`,
    `agentId:${payload.agentId}`,
    `serviceSlug:${payload.serviceSlug}`,
    `ownerAddress:${payload.ownerAddress}`,
    `actorAddress:${payload.actorAddress}`,
    `issuedAt:${payload.issuedAt}`,
    `nonce:${payload.nonce}`,
  ].join("\n");
