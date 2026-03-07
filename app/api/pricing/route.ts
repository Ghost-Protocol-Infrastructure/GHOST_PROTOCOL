import { NextRequest, NextResponse } from "next/server";
import { GHOST_CREDIT_PRICE_WEI, GHOST_PREFERRED_CHAIN_ID } from "@/lib/constants";
import { getServiceCreditCost } from "@/lib/db";

export const runtime = "nodejs";

type CostSource = "db" | "env" | "default";

const DEFAULT_REQUEST_COST = (() => {
  const raw = process.env.GHOST_REQUEST_CREDIT_COST?.trim();
  if (raw && /^\d+$/.test(raw)) {
    const parsed = BigInt(raw);
    if (parsed > 0n) return parsed;
  }
  return 1n;
})();

const ALLOW_CLIENT_COST_OVERRIDE = process.env.GHOST_GATE_ALLOW_CLIENT_COST_OVERRIDE?.trim() === "true";
const ENABLE_DB_SERVICE_PRICING = process.env.GHOST_GATE_DB_SERVICE_PRICING_ENABLED?.trim() === "true";
const GHOST_GATE_X402_ENABLED = process.env.GHOST_GATE_X402_ENABLED?.trim() === "true";
const GHOST_GATE_X402_SCHEME = process.env.GHOST_GATE_X402_SCHEME?.trim() || "ghost-eip712-credit-v1";

const ENV_SERVICE_PRICING = (() => {
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
})();

const json = (body: unknown, status = 200): NextResponse =>
  NextResponse.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
    },
  });

const parseServiceSlug = (request: NextRequest): string | null => {
  const raw = request.nextUrl.searchParams.get("service");
  if (raw == null) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : "";
};

const resolveServiceCost = async (service: string): Promise<{ cost: bigint; source: CostSource }> => {
  if (ENABLE_DB_SERVICE_PRICING) {
    try {
      const dbServiceCost = await getServiceCreditCost(service);
      if (dbServiceCost != null) {
        return { cost: dbServiceCost, source: "db" };
      }
    } catch {
      // Continue through env/default when DB pricing lookup fails.
    }
  }

  const envServiceCost = ENV_SERVICE_PRICING.get(service);
  if (envServiceCost != null) {
    return { cost: envServiceCost, source: "env" };
  }

  return { cost: DEFAULT_REQUEST_COST, source: "default" };
};

export async function GET(request: NextRequest): Promise<NextResponse> {
  const service = parseServiceSlug(request);
  if (service === "") {
    return json(
      {
        code: 400,
        error: "Invalid service slug",
      },
      400,
    );
  }

  const servicePricing = service
    ? await resolveServiceCost(service)
    : {
        cost: DEFAULT_REQUEST_COST,
        source: "default" as CostSource,
      };

  return json({
    ok: true,
    apiVersion: 1,
    currency: "GHOST_CREDIT",
    creditPriceWei: GHOST_CREDIT_PRICE_WEI.toString(),
    preferredChainId: GHOST_PREFERRED_CHAIN_ID,
    gate: {
      defaultRequestCreditCost: DEFAULT_REQUEST_COST.toString(),
      allowClientCostOverride: ALLOW_CLIENT_COST_OVERRIDE,
      dbServicePricingEnabled: ENABLE_DB_SERVICE_PRICING,
      envServicePricingCount: ENV_SERVICE_PRICING.size,
      x402CompatibilityEnabled: GHOST_GATE_X402_ENABLED,
      x402Scheme: GHOST_GATE_X402_SCHEME,
    },
    service: service
      ? {
          slug: service,
          cost: servicePricing.cost.toString(),
          source: servicePricing.source,
        }
      : null,
  });
}
