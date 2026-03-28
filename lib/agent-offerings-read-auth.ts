import {
  normalizeMerchantGatewayAuthPayload,
  type MerchantGatewayAuthPayload,
} from "@/lib/agent-gateway-auth";

export type CachedAgentOfferingReadAuth = {
  agentId: string;
  ownerAddress: string;
  actorAddress: string;
  serviceSlug: string;
  authPayload: MerchantGatewayAuthPayload;
  authSignature: string;
  expiresAtMs: number;
};

type ReadAuthScope = {
  agentId: string;
  ownerAddress: string;
  actorAddress: string;
  serviceSlug: string;
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const STORAGE_KEY_PREFIX = "ghost.agent-offerings.read-auth.v1";

const normalizeScope = (scope: ReadAuthScope) => ({
  agentId: scope.agentId.trim(),
  ownerAddress: scope.ownerAddress.trim().toLowerCase(),
  actorAddress: scope.actorAddress.trim().toLowerCase(),
  serviceSlug: scope.serviceSlug.trim(),
});

export const getAgentOfferingsReadAuthStorageKey = (scope: ReadAuthScope): string => {
  const normalized = normalizeScope(scope);
  return [
    STORAGE_KEY_PREFIX,
    encodeURIComponent(normalized.agentId),
    encodeURIComponent(normalized.ownerAddress),
    encodeURIComponent(normalized.actorAddress),
    encodeURIComponent(normalized.serviceSlug),
  ].join(":");
};

const parseCachedReadAuth = (raw: string | null, scope: ReadAuthScope): CachedAgentOfferingReadAuth | null => {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const normalizedScope = normalizeScope(scope);
    const authPayload = normalizeMerchantGatewayAuthPayload(parsed.authPayload);
    const authSignature = typeof parsed.authSignature === "string" ? parsed.authSignature.trim() : "";
    const expiresAtMs =
      typeof parsed.expiresAtMs === "number" && Number.isFinite(parsed.expiresAtMs)
        ? Math.trunc(parsed.expiresAtMs)
        : null;
    const agentId = typeof parsed.agentId === "string" ? parsed.agentId.trim() : "";
    const ownerAddress = typeof parsed.ownerAddress === "string" ? parsed.ownerAddress.trim().toLowerCase() : "";
    const actorAddress = typeof parsed.actorAddress === "string" ? parsed.actorAddress.trim().toLowerCase() : "";
    const serviceSlug = typeof parsed.serviceSlug === "string" ? parsed.serviceSlug.trim() : "";

    if (!authPayload || authPayload.action !== "offerings_manage") return null;
    if (!authSignature || expiresAtMs == null || expiresAtMs <= Date.now()) return null;
    if (
      agentId !== normalizedScope.agentId ||
      ownerAddress !== normalizedScope.ownerAddress ||
      actorAddress !== normalizedScope.actorAddress ||
      serviceSlug !== normalizedScope.serviceSlug
    ) {
      return null;
    }

    return {
      agentId,
      ownerAddress,
      actorAddress,
      serviceSlug,
      authPayload,
      authSignature,
      expiresAtMs,
    };
  } catch {
    return null;
  }
};

export const loadCachedAgentOfferingReadAuth = (
  storage: StorageLike,
  scope: ReadAuthScope,
): CachedAgentOfferingReadAuth | null => {
  const key = getAgentOfferingsReadAuthStorageKey(scope);
  const parsed = parseCachedReadAuth(storage.getItem(key), scope);
  if (!parsed) {
    storage.removeItem(key);
    return null;
  }
  return parsed;
};

export const saveCachedAgentOfferingReadAuth = (
  storage: StorageLike,
  value: CachedAgentOfferingReadAuth,
): void => {
  storage.setItem(getAgentOfferingsReadAuthStorageKey(value), JSON.stringify(value));
};

export const clearCachedAgentOfferingReadAuth = (
  storage: StorageLike,
  scope: ReadAuthScope,
): void => {
  storage.removeItem(getAgentOfferingsReadAuthStorageKey(scope));
};
