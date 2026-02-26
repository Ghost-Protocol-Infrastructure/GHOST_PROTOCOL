import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    { ghostgate: "ready", service: "agent-18755" },
    {
      status: 200,
      headers: {
        "cache-control": "no-store",
      },
    },
  );
}

