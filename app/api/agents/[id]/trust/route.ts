import { NextRequest, NextResponse } from "next/server";
import { loadActivePortableTrustArtifactByAgentId } from "@/lib/trust-artifact-store";
import { isPortableTrustEnabled } from "@/lib/trust-signing";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

const PUBLIC_CACHE_HEADERS = {
  "cache-control": "public, max-age=60, stale-while-revalidate=300",
} as const;

const NO_STORE_HEADERS = {
  "cache-control": "no-store",
} as const;

export async function GET(_: NextRequest, context: RouteContext): Promise<NextResponse> {
  const { id } = await context.params;
  const agentId = decodeURIComponent(id).trim();

  if (!agentId) {
    return NextResponse.json({ error: "Agent id is required." }, { status: 400, headers: NO_STORE_HEADERS });
  }

  if (!isPortableTrustEnabled()) {
    return NextResponse.json({ error: "Portable trust is not enabled." }, { status: 404, headers: NO_STORE_HEADERS });
  }

  try {
    const artifact = await loadActivePortableTrustArtifactByAgentId(agentId);
    if (!artifact) {
      return NextResponse.json({ error: "Portable trust artifact not found." }, { status: 404, headers: NO_STORE_HEADERS });
    }

    return NextResponse.json(
      {
        ok: true,
        artifact,
      },
      {
        status: 200,
        headers: PUBLIC_CACHE_HEADERS,
      },
    );
  } catch (error) {
    console.error("Failed to load portable trust artifact.", error);
    return NextResponse.json(
      { error: "Failed to load portable trust artifact." },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
