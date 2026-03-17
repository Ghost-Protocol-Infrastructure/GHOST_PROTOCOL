import { type NextRequest } from "next/server";
import type { WireArtifactValidationState, WireWorkflowStatus } from "@prisma/client";
import {
  buildGhostWireArtifactAuthPayload,
  buildGhostWireArtifactAuthMessage,
  validateGhostWireCreateArtifact,
  validateGhostWireFundArtifact,
  verifyGhostWireArtifactAuth,
} from "@/lib/ghostwire-direct";
import { consumeGhostWireRateLimit } from "@/lib/ghostwire-rate-limit";
import {
  failWireJobArtifactValidation,
  getWireJobArtifactContext,
  getWireJobById,
  prepareWireJobFunding as prepareWireFundingFromJob,
  recordWireJobExecutionArtifacts,
  reconcileWireJobFundedState,
  WireJobExecutionConflictError,
  WireJobNotFoundError,
} from "@/lib/ghostwire-store";
import {
  ghostWireJson,
  isRecord,
  parseAddressString,
  parseGhostWireJsonBody,
  parseHashString,
  parseOptionalString,
  parseWireApprovalMode,
} from "@/lib/ghostwire-route";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    jobId: string;
  }>;
};

type ParsedArtifactAuth = {
  scope: "ghostwire_artifacts";
  version: "1";
  jobId: string;
  clientAddress: string;
  createTxHash: string | null;
  fundTxHash: string | null;
  issuedAt: number;
  nonce: string;
};

const parseArtifactAuthPayload = (value: unknown): ParsedArtifactAuth | null => {
  if (!isRecord(value)) return null;
  const scope = value.scope === "ghostwire_artifacts" ? value.scope : null;
  const version = value.version === "1" ? value.version : null;
  const jobId = parseOptionalString(value.jobId);
  const clientAddress = parseAddressString(value.clientAddress);
  const createTxHash = value.createTxHash == null ? null : parseHashString(value.createTxHash);
  const fundTxHash = value.fundTxHash == null ? null : parseHashString(value.fundTxHash);
  const issuedAt =
    typeof value.issuedAt === "number" && Number.isInteger(value.issuedAt)
      ? value.issuedAt
      : typeof value.issuedAt === "string" && /^\d+$/.test(value.issuedAt.trim())
        ? Number.parseInt(value.issuedAt.trim(), 10)
        : null;
  const nonce = parseOptionalString(value.nonce);

  if (!scope || !version || !jobId || !clientAddress || issuedAt == null || !nonce) {
    return null;
  }

  return {
    scope,
    version,
    jobId,
    clientAddress,
    createTxHash,
    fundTxHash,
    issuedAt,
    nonce,
  };
};

const buildRecoveryGuidance = (input: {
  state: string;
  validationState: WireArtifactValidationState;
  validationError: string | null;
}) => {
  if (input.validationState !== "INVALID" && input.validationState !== "MANUAL_REVIEW") {
    return {
      recoveryAction: null,
      recoveryHint: null,
    };
  }

  if (input.state === "OPEN") {
    return {
      recoveryAction: "REJECT_OPEN_JOB",
      recoveryHint:
        input.validationError ??
        "The on-chain GhostWire job does not match the prepared job. Reject the open job from the client wallet, then prepare a new job.",
    };
  }

  return {
    recoveryAction: "CLAIM_REFUND_AFTER_EXPIRY",
    recoveryHint:
      input.validationError ??
      "The funded GhostWire job does not match the prepared job. Wait until expiry, then call claimRefund() from the client or evaluator wallet.",
  };
};

const resolveArtifactState = (input: {
  hasCreate: boolean;
  hasFund: boolean;
  validationState: WireArtifactValidationState;
}): {
  artifactStatus: WireWorkflowStatus;
  createStatus: WireWorkflowStatus;
  fundStatus: WireWorkflowStatus;
  confirmationStatus: WireWorkflowStatus;
  reconcileStatus: WireWorkflowStatus;
} => {
  if (input.validationState === "INVALID" || input.validationState === "MANUAL_REVIEW") {
    return {
      artifactStatus: "FAILED",
      createStatus: input.hasCreate ? "FAILED" : "PENDING",
      fundStatus: input.hasFund ? "FAILED" : "PENDING",
      confirmationStatus: "PENDING",
      reconcileStatus: "PENDING",
    };
  }

  if (input.hasFund) {
    return {
      artifactStatus: "SUCCEEDED",
      createStatus: "SUCCEEDED",
      fundStatus: "SUCCEEDED",
      confirmationStatus: "IN_PROGRESS",
      reconcileStatus: "PENDING",
    };
  }

  if (input.hasCreate) {
    return {
      artifactStatus: "SUCCEEDED",
      createStatus: "SUCCEEDED",
      fundStatus: "PENDING",
      confirmationStatus: "PENDING",
      reconcileStatus: "PENDING",
    };
  }

  return {
    artifactStatus: "PENDING",
    createStatus: "PENDING",
    fundStatus: "PENDING",
    confirmationStatus: "PENDING",
    reconcileStatus: "PENDING",
  };
};

export async function POST(request: NextRequest, context: RouteContext) {
  const { jobId } = await context.params;
  const normalizedJobId = jobId.trim();

  const parsed = await parseGhostWireJsonBody(request);
  if (!parsed.ok) {
    return ghostWireJson(
      { code: parsed.status, error: parsed.error, errorCode: parsed.errorCode },
      parsed.status,
    );
  }

  if (!isRecord(parsed.body)) {
    return ghostWireJson(
      { code: 400, error: "Invalid GhostWire artifact request shape.", errorCode: "INVALID_WIRE_ARTIFACT_REQUEST" },
      400,
    );
  }

  const createTxHash = parseHashString(parsed.body.createTxHash);
  const fundTxHash = parseHashString(parsed.body.fundTxHash);
  const createTxSenderInput = parseAddressString(parsed.body.createTxSender);
  const fundTxSenderInput = parseAddressString(parsed.body.fundTxSender);
  const authPayload = parseArtifactAuthPayload(parsed.body.authPayload);
  const authSignature = parseOptionalString(parsed.body.authSignature);
  const approvalMode = parseWireApprovalMode(parsed.body.approvalMode) ?? "exact";

  if (!createTxHash && !fundTxHash) {
    return ghostWireJson(
      {
        code: 400,
        error: "At least one of createTxHash or fundTxHash is required.",
        errorCode: "INVALID_WIRE_ARTIFACT_PARAMS",
      },
      400,
    );
  }

  if (!authPayload || !authSignature) {
    return ghostWireJson(
      {
        code: 401,
        error: "GhostWire artifact submission requires a signed client-wallet authorization payload.",
        errorCode: "WIRE_ARTIFACT_AUTH_REQUIRED",
      },
      401,
    );
  }

  if (authPayload.jobId !== normalizedJobId) {
    return ghostWireJson(
      { code: 401, error: "Artifact authorization jobId does not match request path.", errorCode: "WIRE_ARTIFACT_AUTH_INVALID" },
      401,
    );
  }
  if ((createTxHash ?? null) !== authPayload.createTxHash || (fundTxHash ?? null) !== authPayload.fundTxHash) {
    return ghostWireJson(
      {
        code: 401,
        error: "Artifact authorization payload does not match the submitted transaction hashes.",
        errorCode: "WIRE_ARTIFACT_AUTH_INVALID",
      },
      401,
    );
  }

  try {
    const job = await getWireJobArtifactContext(normalizedJobId);
    const rateLimit = consumeGhostWireRateLimit({
      request,
      action: "artifacts",
      jobId: normalizedJobId,
      actorAddress: job.clientAddress,
    });
    if (!rateLimit.ok) {
      return ghostWireJson(
        {
          code: rateLimit.status,
          error: rateLimit.error,
          errorCode: rateLimit.errorCode,
          retryAfterSeconds: rateLimit.retryAfterSeconds,
        },
        rateLimit.status,
      );
    }

    const authOk = await verifyGhostWireArtifactAuth({
      expectedClientAddress: job.clientAddress,
      authPayload,
      authSignature,
    });
    if (!authOk) {
      return ghostWireJson(
        { code: 401, error: "GhostWire artifact authorization signature is invalid.", errorCode: "WIRE_ARTIFACT_AUTH_INVALID" },
        401,
      );
    }

    const expectedDescription = job.metadataUri?.trim() || job.specHash;
    let resolvedContractJobId = job.contractJobId;
    let latestCheckedBlock = job.workflow?.artifactLastCheckedBlock ?? null;

    if (createTxHash) {
      try {
        const createValidation = await validateGhostWireCreateArtifact({
          chainId: job.chainId as 8453 | 84532,
          expectedClientAddress: job.clientAddress,
          expectedProviderAddress: job.providerAddress,
          expectedEvaluatorAddress: job.evaluatorAddress,
          expectedJobExpiresAt: job.jobExpiresAt,
          expectedDescription,
          createTxHash,
        });
        if (createTxSenderInput && createValidation.createTxSender !== createTxSenderInput) {
          throw new Error("Create transaction sender override does not match the observed on-chain sender.");
        }

        resolvedContractJobId = createValidation.contractJobId;
        latestCheckedBlock = createValidation.blockNumber;
        const createStates = resolveArtifactState({
          hasCreate: true,
          hasFund: Boolean(fundTxHash),
          validationState: fundTxHash ? "VALID" : "PARTIAL",
        });

        await recordWireJobExecutionArtifacts({
          jobId: normalizedJobId,
          contractAddress: createValidation.contractAddress,
          contractJobId: createValidation.contractJobId,
          createTxHash: createValidation.createTxHash,
          createTxSender: createValidation.createTxSender,
          artifactValidationState: fundTxHash ? "VALID" : "PARTIAL",
          artifactValidationError: null,
          artifactStatus: createStates.artifactStatus,
          createStatus: createStates.createStatus,
          fundStatus: createStates.fundStatus,
          confirmationStatus: createStates.confirmationStatus,
          reconcileStatus: createStates.reconcileStatus,
          artifactCheckedAt: new Date(),
          artifactLastCheckedBlock: createValidation.blockNumber,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Create artifact validation failed.";
        await failWireJobArtifactValidation({
          jobId: normalizedJobId,
          stage: "create",
          reason: message,
          artifactLastCheckedBlock: latestCheckedBlock,
        });
        const snapshot = await getWireJobById(normalizedJobId);
        const recovery = buildRecoveryGuidance({
          state: snapshot.contractState,
          validationState: "MANUAL_REVIEW",
          validationError: message,
        });
        return ghostWireJson(
          {
            code: 409,
            error: message,
            errorCode: "WIRE_CREATE_ARTIFACT_INVALID",
            job: {
              ...snapshot,
              ...recovery,
            },
          },
          409,
        );
      }
    }

    if (fundTxHash) {
      if (!resolvedContractJobId) {
        return ghostWireJson(
          {
            code: 409,
            error: "Fund artifact requires a validated create artifact first.",
            errorCode: "WIRE_FUND_ARTIFACT_REQUIRES_CREATE",
          },
          409,
        );
      }

      try {
        const fundValidation = await validateGhostWireFundArtifact({
          chainId: job.chainId as 8453 | 84532,
          expectedClientAddress: job.clientAddress,
          expectedProviderAddress: job.providerAddress,
          expectedEvaluatorAddress: job.evaluatorAddress,
          expectedBudgetAmount: job.contractBudgetAmount,
          expectedContractJobId: resolvedContractJobId,
          fundTxHash,
        });
        if (fundTxSenderInput && fundValidation.fundTxSender !== fundTxSenderInput) {
          throw new Error("Fund transaction sender override does not match the observed on-chain sender.");
        }

        latestCheckedBlock = fundValidation.blockNumber;
        await recordWireJobExecutionArtifacts({
          jobId: normalizedJobId,
          contractAddress: fundValidation.contractAddress,
          contractJobId: resolvedContractJobId,
          fundTxHash: fundValidation.fundTxHash,
          fundTxSender: fundValidation.fundTxSender,
          artifactValidationState: "VALID",
          artifactValidationError: null,
          artifactStatus: "SUCCEEDED",
          createStatus: "SUCCEEDED",
          fundStatus: "SUCCEEDED",
          confirmationStatus: fundValidation.confirmations >= fundValidation.minConfirmations ? "SUCCEEDED" : "IN_PROGRESS",
          reconcileStatus: fundValidation.confirmations >= fundValidation.minConfirmations ? "SUCCEEDED" : "PENDING",
          artifactCheckedAt: new Date(),
          artifactLastCheckedBlock: fundValidation.blockNumber,
        });

        if (fundValidation.confirmations >= fundValidation.minConfirmations) {
          await reconcileWireJobFundedState({
            jobId: normalizedJobId,
            createTxHash: createTxHash ?? job.createTxHash ?? "",
            fundTxHash: fundValidation.fundTxHash,
            confirmedAt: new Date(),
            blockNumber: fundValidation.blockNumber,
            confirmations: fundValidation.confirmations,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Fund artifact validation failed.";
        await failWireJobArtifactValidation({
          jobId: normalizedJobId,
          stage: "fund",
          reason: message,
          artifactLastCheckedBlock: latestCheckedBlock,
        });
        const snapshot = await getWireJobById(normalizedJobId);
        const recovery = buildRecoveryGuidance({
          state: snapshot.contractState,
          validationState: "MANUAL_REVIEW",
          validationError: message,
        });
        return ghostWireJson(
          {
            code: 409,
            error: message,
            errorCode: "WIRE_FUND_ARTIFACT_INVALID",
            job: {
              ...snapshot,
              ...recovery,
            },
          },
          409,
        );
      }
    }

    const snapshot = await getWireJobById(normalizedJobId);
    const walletPrep =
      createTxHash && !fundTxHash
        ? await prepareWireFundingFromJob({
            jobId: normalizedJobId,
            approvalMode,
          })
        : null;
    const recovery = buildRecoveryGuidance({
      state: snapshot.contractState,
      validationState: snapshot.artifactValidationState,
      validationError: snapshot.artifactValidationError,
    });

    return ghostWireJson({
      ok: true,
      apiVersion: 1,
      artifactAuthMessage: buildGhostWireArtifactAuthMessage(
        buildGhostWireArtifactAuthPayload({
          jobId: normalizedJobId,
          clientAddress: job.clientAddress,
          nonce: authPayload.nonce,
          createTxHash,
          fundTxHash,
          issuedAt: authPayload.issuedAt,
        }),
      ),
      job: {
        ...snapshot,
        ...recovery,
      },
      direct: walletPrep
        ? {
            ...walletPrep,
            nextAction: "submit_fund_artifact",
          }
        : null,
    });
  } catch (error) {
    if (error instanceof WireJobNotFoundError) {
      return ghostWireJson({ code: 404, error: error.message, errorCode: "WIRE_JOB_NOT_FOUND" }, 404);
    }
    if (error instanceof WireJobExecutionConflictError) {
      return ghostWireJson({ code: 409, error: error.message, errorCode: "WIRE_JOB_ARTIFACT_CONFLICT" }, 409);
    }

    console.error("Failed to record GhostWire artifacts.", error);
    return ghostWireJson(
      { code: 500, error: "Failed to record GhostWire artifacts.", errorCode: "WIRE_ARTIFACT_RECORD_FAILED" },
      500,
    );
  }
}
