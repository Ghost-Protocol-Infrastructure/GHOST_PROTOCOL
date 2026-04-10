import { NextRequest, NextResponse } from "next/server";
import { GHOST_CREDIT_PRICE_WEI, GHOST_PREFERRED_CHAIN_ID } from "@/lib/constants";
import {
  getGhostExpressDefaultRequestCost,
  isGhostExpressClientCostOverrideEnabled,
  isGhostExpressDbServicePricingEnabled,
  getGhostExpressEnvServicePricing,
  resolveGhostExpressServiceCost,
} from "@/lib/ghost-express-pricing";
import { buildX402Metadata } from "@/lib/x402-interop";

export const runtime = "nodejs";

type CostSource = "db" | "env" | "default";

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
    ? ((await resolveGhostExpressServiceCost(service)) as { cost: bigint; source: CostSource })
    : {
        cost: getGhostExpressDefaultRequestCost(),
        source: "default" as CostSource,
      };

  return json({
    ok: true,
    apiVersion: 1,
    currency: "GHOST_CREDIT",
    creditPriceWei: GHOST_CREDIT_PRICE_WEI.toString(),
    preferredChainId: GHOST_PREFERRED_CHAIN_ID,
    x402: buildX402Metadata(),
    gate: {
      defaultRequestCreditCost: getGhostExpressDefaultRequestCost().toString(),
      allowClientCostOverride: isGhostExpressClientCostOverrideEnabled(),
      dbServicePricingEnabled: isGhostExpressDbServicePricingEnabled(),
      envServicePricingCount: getGhostExpressEnvServicePricing().size,
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
