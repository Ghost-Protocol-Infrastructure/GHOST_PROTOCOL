import { NextRequest, NextResponse } from "next/server";
import {
  recoverTypedDataAddress,
  verifyTypedData,
  type Address,
} from "viem";
import { consumeUserCredits, getUserCredits } from "@/lib/db";

export const runtime = "nodejs";

const REPLAY_WINDOW_SECONDS = 60n;

const DOMAIN = {
  name: "GhostGate",
  version: "1",
  chainId: 8453,
} as const;

const TYPES = {
  Access: [
    { name: "service", type: "string" },
    { name: "timestamp", type: "uint256" },
    { name: "nonce", type: "string" },
  ],
} as const;

interface AccessPayloadRaw {
  service: unknown;
  timestamp: unknown;
  nonce: unknown;
}

interface AccessPayload {
  service: string;
  timestamp: bigint;
  nonce: string;
}

interface RouteContext {
  params: { slug?: string[] } | Promise<{ slug?: string[] }>;
}

const DEFAULT_REQUEST_COST = (() => {
  const raw = process.env.GHOST_REQUEST_CREDIT_COST?.trim();
  if (raw && /^\d+$/.test(raw)) {
    const parsed = BigInt(raw);
    if (parsed > 0n) return parsed;
  }
  return 1n;
})();

const json = (body: unknown, status = 200): NextResponse =>
  NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

const parseTimestamp = (value: unknown): bigint | null => {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return null;
};

const parseAndValidatePayload = (rawPayload: string): AccessPayload | null => {
  let parsed: AccessPayloadRaw;
  try {
    parsed = JSON.parse(rawPayload) as AccessPayloadRaw;
  } catch {
    return null;
  }

  if (typeof parsed.service !== "string" || parsed.service.length === 0) return null;
  if (typeof parsed.nonce !== "string" || parsed.nonce.length === 0) return null;

  const ts = parseTimestamp(parsed.timestamp);
  if (ts == null) return null;

  return {
    service: parsed.service,
    timestamp: ts,
    nonce: parsed.nonce,
  };
};

const parseSignature = (rawSig: string): `0x${string}` | null => {
  if (!/^0x[0-9a-fA-F]+$/.test(rawSig)) return null;
  return rawSig as `0x${string}`;
};

const resolveServiceFromSlug = async (context: RouteContext): Promise<string | null> => {
  const params = await Promise.resolve(context.params);
  const slug = params.slug;
  if (!slug || slug.length === 0) return null;
  return slug.join("/");
};

const isReplayWindowValid = (timestamp: bigint): boolean => {
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (timestamp > now) return false;
  return now - timestamp <= REPLAY_WINDOW_SECONDS;
};

const parseCreditCost = (value: string | null): bigint | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = BigInt(trimmed);
  if (parsed <= 0n) return null;
  return parsed;
};

const resolveRequestCost = (request: NextRequest): bigint => {
  const requestScopedCost = parseCreditCost(request.headers.get("x-ghost-credit-cost"));
  if (requestScopedCost != null) return requestScopedCost;
  return DEFAULT_REQUEST_COST;
};

const handle = async (request: NextRequest, context: RouteContext): Promise<NextResponse> => {
  const requestedService = await resolveServiceFromSlug(context);
  if (!requestedService) {
    return json({ error: "Missing service slug", code: 400 }, 400);
  }

  const rawSig = request.headers.get("x-ghost-sig");
  const rawPayload = request.headers.get("x-ghost-payload");
  if (!rawSig || !rawPayload) {
    return json({ error: "Missing required auth headers", code: 400 }, 400);
  }

  const signature = parseSignature(rawSig);
  const payload = parseAndValidatePayload(rawPayload);
  if (!signature || !payload) {
    return json({ error: "Malformed signature or payload", code: 400 }, 400);
  }

  if (payload.service !== requestedService) {
    return json({ error: "Service mismatch", code: 401 }, 401);
  }

  if (!isReplayWindowValid(payload.timestamp)) {
    return json({ error: "Signature expired", code: 401 }, 401);
  }

  let signer: Address;
  let isValidSig = false;
  try {
    signer = await recoverTypedDataAddress({
      domain: DOMAIN,
      types: TYPES,
      primaryType: "Access",
      message: payload,
      signature,
    });

    isValidSig = await verifyTypedData({
      address: signer,
      domain: DOMAIN,
      types: TYPES,
      primaryType: "Access",
      message: payload,
      signature,
    });
  } catch {
    return json({ error: "Invalid Signature", code: 401 }, 401);
  }

  if (!isValidSig) {
    return json({ error: "Invalid Signature", code: 401 }, 401);
  }

  const requestCost = resolveRequestCost(request);
  const balance = await getUserCredits(signer);
  if (balance < requestCost) {
    return json(
      {
        error: "Payment Required",
        code: 402,
        details: {
          balance: balance.toString(),
          required: requestCost.toString(),
        },
      },
      402,
    );
  }

  const consumed = await consumeUserCredits(signer, requestCost);
  if (!consumed) {
    return json(
      {
        error: "Payment Required",
        code: 402,
      },
      402,
    );
  }

  return json(
    {
      authorized: true,
      code: 200,
      service: requestedService,
      signer,
      cost: requestCost.toString(),
      remainingCredits: consumed.after.toString(),
    },
    200,
  );
};

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  return handle(request, context);
}

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  return handle(request, context);
}
