export const DEFAULT_AGENT_GATEWAY_CANARY_PATH = "/ghostgate/canary";
export const AGENT_GATEWAY_VERIFY_TIMEOUT_MS = 5_000;

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

const PRIVATE_IPV4_PATTERN =
  /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[0-1])\.)/;

export const normalizeAgentId = (value: unknown): string | null => {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  return normalized;
};

export const normalizeOwnerAddress = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) return null;
  return normalized;
};

export const deriveAgentServiceSlug = (agentId: string): string => `agent-${agentId}`;

export const normalizeServiceSlug = (value: unknown, agentId: string): string | null => {
  const derived = deriveAgentServiceSlug(agentId);
  if (value == null) return derived;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return normalized === derived ? normalized : null;
};

export const normalizeCanaryPath = (value: unknown): string | null => {
  if (value == null) return DEFAULT_AGENT_GATEWAY_CANARY_PATH;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_AGENT_GATEWAY_CANARY_PATH;
  if (!trimmed.startsWith("/")) return null;
  if (trimmed.includes("://")) return null;
  return trimmed;
};

export const normalizeCanaryMethod = (value: unknown): "GET" | null => {
  if (value == null) return "GET";
  if (typeof value !== "string") return null;
  return value.trim().toUpperCase() === "GET" ? "GET" : null;
};

const isPrivateHostname = (hostname: string): boolean => {
  const lower = hostname.trim().toLowerCase();
  if (!lower) return true;
  if (LOCAL_HOSTNAMES.has(lower)) return true;
  if (lower.endsWith(".local")) return true;
  if (PRIVATE_IPV4_PATTERN.test(lower)) return true;
  return false;
};

export const normalizeMerchantEndpointUrl = (value: unknown): { normalizedUrl: string; origin: string } | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  const protocol = url.protocol.toLowerCase();
  const hostname = url.hostname.toLowerCase();
  const isDevelopment = process.env.NODE_ENV !== "production";

  if (protocol !== "https:" && protocol !== "http:") return null;
  if (url.username || url.password) return null;
  if (url.hash) url.hash = "";

  if (!isDevelopment) {
    if (protocol !== "https:") return null;
    if (isPrivateHostname(hostname)) return null;
  } else {
    if (protocol === "http:" && !isPrivateHostname(hostname) && hostname !== "0.0.0.0") {
      return null;
    }
  }

  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  url.search = "";

  return {
    normalizedUrl: url.toString(),
    origin: url.origin,
  };
};

export const buildCanaryUrl = (endpointUrl: string, canaryPath: string): string => {
  const base = new URL(endpointUrl);
  const endpointPath = (base.pathname || "/").replace(/\/+$/, "") || "/";
  const normalizedCanaryPath = canaryPath.trim();

  // Backward-compatibility: preserve already-absolute full-path canary values.
  if (
    endpointPath !== "/" &&
    (normalizedCanaryPath === endpointPath || normalizedCanaryPath.startsWith(`${endpointPath}/`))
  ) {
    base.pathname = normalizedCanaryPath;
    base.search = "";
    base.hash = "";
    return base.toString();
  }

  if (endpointPath === "/") {
    base.pathname = normalizedCanaryPath;
    base.search = "";
    base.hash = "";
    return base.toString();
  }

  const relativeCanaryPath = normalizedCanaryPath.replace(/^\/+/, "");
  base.pathname = (relativeCanaryPath ? `${endpointPath}/${relativeCanaryPath}` : endpointPath).replace(/\/{2,}/g, "/");
  base.search = "";
  base.hash = "";
  return base.toString();
};

export const parseCanaryJson = (value: unknown): { ghostgate: string; service: string } | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "ghostgate" || keys[1] !== "service") {
    return null;
  }

  if (typeof record.ghostgate !== "string" || typeof record.service !== "string") {
    return null;
  }

  return {
    ghostgate: record.ghostgate,
    service: record.service,
  };
};

export const matchesCanaryContract = (
  payload: unknown,
  expectedServiceSlug: string,
): { ok: true } | { ok: false; reason: string } => {
  const parsed = parseCanaryJson(payload);
  if (!parsed) {
    return { ok: false, reason: 'Canary JSON must exactly match keys {"ghostgate","service"} with string values.' };
  }
  if (parsed.ghostgate !== "ready") {
    return { ok: false, reason: 'Canary JSON field "ghostgate" must equal "ready".' };
  }
  if (parsed.service !== expectedServiceSlug) {
    return { ok: false, reason: `Canary JSON service mismatch. Expected "${expectedServiceSlug}".` };
  }
  return { ok: true };
};
