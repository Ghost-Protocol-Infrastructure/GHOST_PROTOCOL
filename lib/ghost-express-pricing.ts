import { getServiceCreditCost } from "@/lib/db";

export type GhostExpressCostSource = "header" | "db" | "env" | "default";

export const GHOST_EXPRESS_MIN_CREDIT_COST = 5n;
export const GHOST_EXPRESS_MIN_CREDIT_COST_NUMBER = Number(GHOST_EXPRESS_MIN_CREDIT_COST);

const parsePositiveCost = (value: string | null | undefined): bigint | null => {
  const trimmed = value?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) {
    return null;
  }

  const parsed = BigInt(trimmed);
  return parsed > 0n ? parsed : null;
};

export const applyGhostExpressMinimumCreditCost = (cost: bigint): bigint =>
  cost < GHOST_EXPRESS_MIN_CREDIT_COST ? GHOST_EXPRESS_MIN_CREDIT_COST : cost;

export const getGhostExpressDefaultRequestCost = (): bigint =>
  applyGhostExpressMinimumCreditCost(parsePositiveCost(process.env.GHOST_REQUEST_CREDIT_COST) ?? GHOST_EXPRESS_MIN_CREDIT_COST);

export const isGhostExpressDbServicePricingEnabled = (): boolean =>
  process.env.GHOST_GATE_DB_SERVICE_PRICING_ENABLED?.trim() === "true";

export const isGhostExpressClientCostOverrideEnabled = (): boolean =>
  process.env.GHOST_GATE_ALLOW_CLIENT_COST_OVERRIDE?.trim() === "true";

export const getGhostExpressEnvServicePricing = (): Map<string, bigint> => {
  const raw = process.env.GHOST_GATE_SERVICE_PRICING_JSON?.trim();
  const pricing = new Map<string, bigint>();
  if (!raw) return pricing;

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [service, value] of Object.entries(parsed)) {
      if (typeof service !== "string") continue;
      const slug = service.trim();
      if (!slug) continue;

      if (typeof value === "number" && Number.isInteger(value) && value > 0) {
        pricing.set(slug, BigInt(value));
        continue;
      }

      if (typeof value === "string" && /^\d+$/.test(value) && value !== "0") {
        pricing.set(slug, BigInt(value));
      }
    }
  } catch {
    // Ignore malformed pricing JSON and fall back to defaults.
  }

  return pricing;
};

export const resolveGhostExpressHeaderOverrideCost = (value: string | null): bigint | null => {
  const parsed = parsePositiveCost(value);
  return parsed == null ? null : applyGhostExpressMinimumCreditCost(parsed);
};

export const resolveGhostExpressServiceCost = async (
  service: string,
): Promise<{ cost: bigint; source: Exclude<GhostExpressCostSource, "header"> }> => {
  if (isGhostExpressDbServicePricingEnabled()) {
    try {
      const dbServiceCost = await getServiceCreditCost(service);
      if (dbServiceCost != null) {
        return {
          cost: applyGhostExpressMinimumCreditCost(dbServiceCost),
          source: "db",
        };
      }
    } catch {
      // Continue through env/default when DB pricing lookup fails.
    }
  }

  const envServiceCost = getGhostExpressEnvServicePricing().get(service);
  if (envServiceCost != null) {
    return {
      cost: applyGhostExpressMinimumCreditCost(envServiceCost),
      source: "env",
    };
  }

  return {
    cost: getGhostExpressDefaultRequestCost(),
    source: "default",
  };
};
