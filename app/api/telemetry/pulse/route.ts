import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const noStoreHeaders = {
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  Pragma: "no-cache",
  Expires: "0",
};

export async function GET() {
  return NextResponse.json(
    {
      status: "alive",
      timestamp: Date.now(),
    },
    {
      headers: noStoreHeaders,
    },
  );
}

export async function POST() {
  return NextResponse.json(
    {
      status: "ok",
      timestamp: Date.now(),
    },
    {
      headers: noStoreHeaders,
    },
  );
}
