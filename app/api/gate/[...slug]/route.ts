import { NextRequest, NextResponse } from "next/server";
import {
  createPublicClient,
  http,
  recoverTypedDataAddress,
  verifyTypedData,
  type Address,
} from "viem";
import { baseSepolia } from "viem/chains";
import { GHOST_CREDITS_ABI, GHOST_CREDITS_ADDRESS } from "@/lib/ghost-credits";

export const runtime = "nodejs";

const REPLAY_WINDOW_SECONDS = 60n;

const SERVICE_REGISTRY: Record<string, string> = {
  weather: "https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.41",
  mock: "https://jsonplaceholder.typicode.com/todos/1",
};

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

const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(),
});

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

const forwardToUpstream = async (
  request: NextRequest,
  targetUrl: string,
): Promise<NextResponse> => {
  const init: RequestInit = {
    method: request.method,
    headers: { accept: "application/json, text/plain;q=0.9, */*;q=0.8" },
    cache: "no-store",
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    const contentType = request.headers.get("content-type");
    if (contentType) {
      (init.headers as Record<string, string>)["content-type"] = contentType;
    }
    init.body = await request.text();
  }

  const upstream = await fetch(targetUrl, init);
  const body = await upstream.text();
  const contentType = upstream.headers.get("content-type") ?? "application/json; charset=utf-8";

  return new NextResponse(body, {
    status: upstream.status,
    headers: {
      "content-type": contentType,
      "cache-control": "no-store",
    },
  });
};

const handle = async (request: NextRequest, context: RouteContext): Promise<NextResponse> => {
  const requestedService = await resolveServiceFromSlug(context);
  if (!requestedService) {
    return json({ error: "Missing service slug", code: 400 }, 400);
  }

  const upstreamUrl = SERVICE_REGISTRY[requestedService];
  if (!upstreamUrl) {
    return json({ error: "Unknown service", code: 404 }, 404);
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

  let balance: bigint;
  console.log("DEBUG: Checking credits for user:", signer);
  console.log("DEBUG: Contract Address:", GHOST_CREDITS_ADDRESS);
  try {
    balance = await publicClient.readContract({
      address: GHOST_CREDITS_ADDRESS,
      abi: GHOST_CREDITS_ABI,
      functionName: "credits",
      args: [signer],
    });
  } catch (error) {
    console.error("READ CONTRACT ERROR:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return json({ error: "Failed to read on-chain credits", code: 500, details: errorMessage }, 500);
  }

  if (balance <= 0n) {
    return json({ error: "Insufficient Credits", code: 402 }, 402);
  }

  try {
    return await forwardToUpstream(request, upstreamUrl);
  } catch {
    return json({ error: "Upstream request failed", code: 502 }, 502);
  }
};

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  return handle(request, context);
}

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  return handle(request, context);
}
