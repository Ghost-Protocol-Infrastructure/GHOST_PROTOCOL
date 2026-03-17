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
    const recovery =
      job.artifactValidationState === "INVALID" || job.artifactValidationState === "MANUAL_REVIEW"
        ? job.contractState === "OPEN"
          ? {
              recoveryAction: "REJECT_OPEN_JOB",
              recoveryHint:
                job.artifactValidationError ??
                "The on-chain GhostWire job does not match the prepared job. Reject the open job from the client wallet, then prepare a new job.",
            }
          : {
              recoveryAction: "CLAIM_REFUND_AFTER_EXPIRY",
              recoveryHint:
                job.artifactValidationError ??
                "The funded GhostWire job does not match the prepared job. Wait until expiry, then call claimRefund() from the client or evaluator wallet.",
            }
        : {
            recoveryAction: null,
            recoveryHint: null,
          };
    return ghostWireJson({
      ok: true,
      apiVersion: 1,
      job: {
        ...job,
        ...recovery,
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
