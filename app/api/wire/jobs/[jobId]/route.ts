import { NextRequest } from "next/server";
import { getWireJobById, WireJobNotFoundError } from "@/lib/ghostwire-store";
import { buildGhostWireDeliverableSummary } from "@/lib/ghostwire-deliverable";
import { ghostWireJson } from "@/lib/ghostwire-route";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    jobId: string;
  }>;
};

export async function GET(_: NextRequest, context: RouteContext) {
  const { jobId } = await context.params;

  try {
    const job = await getWireJobById(jobId.trim());
    return ghostWireJson({
      ok: true,
      apiVersion: 1,
      job: {
        ...job,
        deliverable: buildGhostWireDeliverableSummary({
          jobId: job.jobId,
          metadataUri: job.metadataUri,
          contractState: job.contractState,
        }),
      },
    });
  } catch (error) {
    if (error instanceof WireJobNotFoundError) {
      return ghostWireJson({ code: 404, error: error.message, errorCode: "WIRE_JOB_NOT_FOUND" }, 404);
    }

    console.error("Failed to fetch GhostWire job.", error);
    return ghostWireJson(
      { code: 500, error: "Failed to fetch GhostWire job.", errorCode: "WIRE_JOB_FETCH_FAILED" },
      500,
    );
  }
}
