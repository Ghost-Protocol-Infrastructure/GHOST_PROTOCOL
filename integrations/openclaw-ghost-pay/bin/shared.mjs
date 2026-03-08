import { randomBytes } from "node:crypto";

export const DEFAULT_BASE_URL = "https://ghostprotocol.cc";
export const DEFAULT_CHAIN_ID = 8453;
export const DEFAULT_X402_SCHEME = "ghost-eip712-credit-v1";
export const DEFAULT_TIMEOUT_MS = 15000;

export function parseCliArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token || !token.startsWith("--")) continue;
    const body = token.slice(2);
    if (!body) continue;

    const separator = body.indexOf("=");
    if (separator > 0) {
      const key = body.slice(0, separator);
      const value = body.slice(separator + 1);
      args[key] = value;
      continue;
    }

    const maybeValue = argv[i + 1];
    if (!maybeValue || maybeValue.startsWith("--")) {
      args[body] = "true";
      continue;
    }

    args[body] = maybeValue;
    i += 1;
  }
  return args;
}

export function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
}

export function parsePositiveInt(raw, fallback) {
  if (raw == null || raw === "") return fallback;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function toBool(raw, fallback = false) {
  if (raw == null || raw === "") return fallback;
  const value = String(raw).trim().toLowerCase();
  if (value === "true" || value === "1" || value === "yes") return true;
  if (value === "false" || value === "0" || value === "no") return false;
  return fallback;
}

export function encodeBase64Json(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function decodeBase64Json(value) {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

export function parseJson(raw, fallback = null) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function createNonce(bytes = 16) {
  return randomBytes(bytes).toString("hex");
}

export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}
