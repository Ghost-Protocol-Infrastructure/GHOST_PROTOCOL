import { type WireTerminalDisposition, type WireWorkflowStatus } from "@prisma/client";
import { createPublicClient, getAbiItem, getAddress, http, type Hash } from "viem";
import { base, baseSepolia } from "viem/chains";
import { prisma } from "@/lib/db";
import {
  createGhostWirePublicClient,
  parseGhostWireFundedLogs,
  validateGhostWireCreateArtifact,
  validateGhostWireFundArtifact,
} from "@/lib/ghostwire-direct";
import { GHOSTWIRE_ERC8183_AGENTIC_COMMERCE_ABI } from "@/lib/ghostwire-contract";
import {
  GHOSTWIRE_ERC8183_PINNED_COMMIT,
  GHOSTWIRE_ERC8183_PINNED_CONTRACT,
  GHOSTWIRE_ERC8183_PINNED_REPOSITORY,
  GHOSTWIRE_JOB_EXPIRY_SECONDS,
  GHOSTWIRE_MAX_EXPIRY_WINDOW_SECONDS,
  GHOSTWIRE_PROTOCOL_FEE_BPS,
  GHOSTWIRE_QUOTE_TTL_SECONDS,
  GHOSTWIRE_SUBMITTED_EVALUATION_GRACE_SECONDS,
  GHOSTWIRE_SUPPORTED_MAINNET_CHAIN_ID,
  GHOSTWIRE_SUPPORTED_SETTLEMENT_ASSET,
  GHOSTWIRE_SUPPORTED_TESTNET_CHAIN_ID,
  resolveGhostWireContractAddress,
  resolveGhostWireMinConfirmations,
  resolveGhostWireRpcUrl,
  type GhostWireSupportedChainId,
} from "@/lib/ghostwire-config";
import {
  countWireJobsNeedingOperatorWork,
  failWireJobArtifactValidation,
  listPendingWireWebhookOutboxEvents,
  listWireJobsForArtifactRecovery,
  listWireJobsNeedingOperatorWork,
  markWireJobForManualReview,
  recordWireJobExecutionArtifacts,
  reconcileWireJobFundedState,
  reconcileWireJobSubmittedState,
  reconcileWireJobTerminalState,
  updateWireArtifactRecoveryCheckpoint,
  updateWireWebhookOutboxDelivery,
} from "@/lib/ghostwire-store";
import { signGhostWireWebhookPayload } from "@/lib/ghostwire-webhooks";

export const GHOSTWIRE_OPERATOR_DEFAULT_WORKFLOW_LIMIT = 25;
export const GHOSTWIRE_OPERATOR_DEFAULT_WEBHOOK_LIMIT = 25;
export const GHOSTWIRE_OPERATOR_MAX_LIMIT = 100;

const GHOSTWIRE_OPERATOR_MODE = "direct-artifact-reconcile-webhooks";
const GHOSTWIRE_OPERATOR_RETRY_DELAY_MS = 5 * 60 * 1000;
const GHOSTWIRE_WEBHOOK_MAX_ATTEMPTS = 6;
const GHOSTWIRE_WEBHOOK_BASE_RETRY_DELAY_MS = 60 * 1000;
const GHOSTWIRE_WEBHOOK_MAX_RETRY_DELAY_MS = 30 * 60 * 1000;
const GHOSTWIRE_LOG_SCAN_BLOCK_RANGE = 9_000n;
const GHOSTWIRE_ARTIFACT_RECOVERY_GRACE_WINDOW_MS = 2 * 60 * 1000;
const GHOSTWIRE_ARTIFACT_RECOVERY_ELIGIBILITY_WINDOW_MS = 24 * 60 * 60 * 1000;
const GHOSTWIRE_ARTIFACT_RECOVERY_MAX_BLOCK_SCAN = 2_000n;

type ReconcileResultStatus =
  | "already_reconciled"
  | "waiting_artifacts"
  | "waiting_confirmation"
  | "confirmed_funded"
  | "confirmed_submitted"
  | "confirmed_terminal"
  | "recovered_create"
  | "recovered_fund"
  | "manual_review"
  | "retrying"
  | "failed";

type GhostWirePendingJob = Awaited<ReturnType<typeof listWireJobsNeedingOperatorWork>>[number];
type GhostWireArtifactRecoveryJob = Awaited<ReturnType<typeof listWireJobsForArtifactRecovery>>[number];
type GhostWirePendingWebhook = Awaited<ReturnType<typeof listPendingWireWebhookOutboxEvents>>[number];

type GhostWireLifecycleEvent = {
  state: "SUBMITTED" | WireTerminalDisposition;
  txHash: Hash;
  blockNumber: bigint;
  logIndex: number;
  confirmations: number;
};

const resolveWireChain = (chainId: GhostWireSupportedChainId) =>
  chainId === GHOSTWIRE_SUPPORTED_MAINNET_CHAIN_ID ? base : baseSepolia;

const createGhostWireLifecycleClient = (chainId: GhostWireSupportedChainId) =>
  createPublicClient({
    chain: resolveWireChain(chainId),
    transport: http(resolveGhostWireRpcUrl(chainId), {
      retryCount: 2,
      retryDelay: 250,
      timeout: 15_000,
    }),
  });

const normalizeHash = (value: string | null | undefined): Hash | null => {
  const trimmed = value?.trim().toLowerCase();
  return trimmed && /^0x[a-f0-9]{64}$/.test(trimmed) ? (trimmed as Hash) : null;
};

const nextRetryAt = (): Date => new Date(Date.now() + GHOSTWIRE_OPERATOR_RETRY_DELAY_MS);

const nextWebhookRetryAt = (attemptCount: number): Date => {
  const delay = Math.min(
    GHOSTWIRE_WEBHOOK_BASE_RETRY_DELAY_MS * 2 ** Math.max(0, attemptCount - 1),
    GHOSTWIRE_WEBHOOK_MAX_RETRY_DELAY_MS,
  );
  return new Date(Date.now() + delay);
};

const isRetryableWebhookStatus = (status: number): boolean =>
  status >= 500 || status === 408 || status === 409 || status === 425 || status === 429;

const buildWorkflowStagePatch = (
  stage: "artifact" | "confirmation" | "reconcile",
  status: WireWorkflowStatus,
): Partial<{
  artifactStatus: WireWorkflowStatus;
  confirmationStatus: WireWorkflowStatus;
  reconcileStatus: WireWorkflowStatus;
}> => {
  switch (stage) {
    case "artifact":
      return { artifactStatus: status };
    case "confirmation":
      return { confirmationStatus: status };
    case "reconcile":
      return { reconcileStatus: status };
  }
};

const updateGhostWireWorkflowStage = async (input: {
  wireJobId: string;
  stage: "artifact" | "confirmation" | "reconcile";
  status: WireWorkflowStatus;
  lastError?: string | null;
  nextRetryAt?: Date | null;
  incrementRetryCount?: boolean;
}) =>
  prisma.wireJobWorkflow.update({
    where: { wireJobId: input.wireJobId },
    data: {
      ...buildWorkflowStagePatch(input.stage, input.status),
      lastError: input.lastError ?? null,
      nextRetryAt: input.nextRetryAt ?? null,
      lastAttemptAt: new Date(),
      retryCount: input.incrementRetryCount ? { increment: 1 } : undefined,
      manualReviewRequired: false,
      manualReviewReason: null,
    },
  });

const markManualReview = async (
  wireJobId: string,
  stage: "create" | "fund" | "confirmation" | "reconcile",
  reason: string,
) => {
  await markWireJobForManualReview({
    jobId: wireJobId,
    stage,
    reason,
  });
  return {
    status: "manual_review" as const,
    detail: reason,
  };
};

const getReceiptObservation = async (input: { chainId: GhostWireSupportedChainId; txHash: Hash }) => {
  const client = createGhostWirePublicClient(input.chainId);

  try {
    const [receipt, latestBlock] = await Promise.all([
      client.getTransactionReceipt({ hash: input.txHash }),
      client.getBlockNumber(),
    ]);
    const confirmations = latestBlock >= receipt.blockNumber ? Number(latestBlock - receipt.blockNumber + 1n) : 0;
    return {
      found: true as const,
      receipt,
      confirmations,
    };
  } catch (error) {
    return {
      found: false as const,
      error: error instanceof Error ? error.message : "Receipt not yet available.",
    };
  }
};

const mapGhostWireContractStatus = (
  status: bigint | number,
): "OPEN" | "FUNDED" | "SUBMITTED" | WireTerminalDisposition => {
  const normalized = typeof status === "bigint" ? Number(status) : status;
  switch (normalized) {
    case 0:
      return "OPEN";
    case 1:
      return "FUNDED";
    case 2:
      return "SUBMITTED";
    case 3:
      return "COMPLETED";
    case 4:
      return "REJECTED";
    case 5:
      return "EXPIRED";
    default:
      throw new Error(`Unsupported GhostWire contract status: ${String(status)}`);
  }
};

const getLatestGhostWireLifecycleEvent = async (input: {
  chainId: GhostWireSupportedChainId;
  contractAddress: `0x${string}`;
  contractJobId: string;
}) => {
  const client = createGhostWireLifecycleClient(input.chainId);
  const jobId = BigInt(input.contractJobId);
  const latestBlock = await client.getBlockNumber();
  let toBlock = latestBlock;

  while (true) {
    const fromBlock = toBlock > GHOSTWIRE_LOG_SCAN_BLOCK_RANGE ? toBlock - GHOSTWIRE_LOG_SCAN_BLOCK_RANGE : 0n;

    const [submittedLogs, completedLogs, rejectedLogs, expiredLogs] = await Promise.all([
      client.getLogs({
        address: input.contractAddress,
        event: getAbiItem({ abi: GHOSTWIRE_ERC8183_AGENTIC_COMMERCE_ABI, name: "JobSubmitted" }),
        args: { jobId },
        fromBlock,
        toBlock,
      }),
      client.getLogs({
        address: input.contractAddress,
        event: getAbiItem({ abi: GHOSTWIRE_ERC8183_AGENTIC_COMMERCE_ABI, name: "JobCompleted" }),
        args: { jobId },
        fromBlock,
        toBlock,
      }),
      client.getLogs({
        address: input.contractAddress,
        event: getAbiItem({ abi: GHOSTWIRE_ERC8183_AGENTIC_COMMERCE_ABI, name: "JobRejected" }),
        args: { jobId },
        fromBlock,
        toBlock,
      }),
      client.getLogs({
        address: input.contractAddress,
        event: getAbiItem({ abi: GHOSTWIRE_ERC8183_AGENTIC_COMMERCE_ABI, name: "JobExpired" }),
        args: { jobId },
        fromBlock,
        toBlock,
      }),
    ]);

    const events: GhostWireLifecycleEvent[] = [
      ...submittedLogs.map((log) => ({
        state: "SUBMITTED" as const,
        txHash: log.transactionHash,
        blockNumber: log.blockNumber ?? 0n,
        logIndex: log.logIndex ?? 0,
        confirmations:
          latestBlock >= (log.blockNumber ?? latestBlock)
            ? Number(latestBlock - (log.blockNumber ?? latestBlock) + 1n)
            : 0,
      })),
      ...completedLogs.map((log) => ({
        state: "COMPLETED" as const,
        txHash: log.transactionHash,
        blockNumber: log.blockNumber ?? 0n,
        logIndex: log.logIndex ?? 0,
        confirmations:
          latestBlock >= (log.blockNumber ?? latestBlock)
            ? Number(latestBlock - (log.blockNumber ?? latestBlock) + 1n)
            : 0,
      })),
      ...rejectedLogs.map((log) => ({
        state: "REJECTED" as const,
        txHash: log.transactionHash,
        blockNumber: log.blockNumber ?? 0n,
        logIndex: log.logIndex ?? 0,
        confirmations:
          latestBlock >= (log.blockNumber ?? latestBlock)
            ? Number(latestBlock - (log.blockNumber ?? latestBlock) + 1n)
            : 0,
      })),
      ...expiredLogs.map((log) => ({
        state: "EXPIRED" as const,
        txHash: log.transactionHash,
        blockNumber: log.blockNumber ?? 0n,
        logIndex: log.logIndex ?? 0,
        confirmations:
          latestBlock >= (log.blockNumber ?? latestBlock)
            ? Number(latestBlock - (log.blockNumber ?? latestBlock) + 1n)
            : 0,
      })),
    ];

    if (events.length > 0) {
      events.sort((left, right) => {
        if (left.blockNumber === right.blockNumber) return left.logIndex - right.logIndex;
        return left.blockNumber < right.blockNumber ? -1 : 1;
      });
      return events.at(-1) ?? null;
    }

    if (fromBlock === 0n) {
      return null;
    }

    toBlock = fromBlock - 1n;
  }
};

const buildArtifactDiscoveryRange = (lastCheckedBlock: bigint | null, latestBlock: bigint) => {
  const initialFromBlock =
    latestBlock > GHOSTWIRE_ARTIFACT_RECOVERY_MAX_BLOCK_SCAN
      ? latestBlock - GHOSTWIRE_ARTIFACT_RECOVERY_MAX_BLOCK_SCAN + 1n
      : 0n;
  const fromBlock = lastCheckedBlock == null ? initialFromBlock : lastCheckedBlock + 1n;
  if (fromBlock > latestBlock) {
    return null;
  }
  return {
    fromBlock,
    toBlock: latestBlock,
  };
};

const updateArtifactCheckpoint = async (input: {
  wireJobId: string;
  artifactStatus?: WireWorkflowStatus;
  artifactLastCheckedBlock?: bigint | null;
  lastError?: string | null;
  nextRetryAt?: Date | null;
}) =>
  updateWireArtifactRecoveryCheckpoint({
    jobId: input.wireJobId,
    artifactStatus: input.artifactStatus,
    artifactCheckedAt: new Date(),
    artifactLastCheckedBlock: input.artifactLastCheckedBlock,
    lastError: input.lastError,
    nextRetryAt: input.nextRetryAt,
  });

const attemptCreateArtifactRecovery = async (job: GhostWireArtifactRecoveryJob) => {
  const chainId = job.chainId as GhostWireSupportedChainId;
  const contractAddress = resolveGhostWireContractAddress(chainId);
  if (!contractAddress) {
    const result = await markManualReview(
      job.id,
      "create",
      `No AgenticCommerce contract address is configured for chain ${chainId}.`,
    );
    return { jobId: job.jobId, ...result };
  }

  const publicClient = createGhostWirePublicClient(chainId);
  const latestBlock = await publicClient.getBlockNumber();
  const range = buildArtifactDiscoveryRange(job.workflow?.artifactLastCheckedBlock ?? null, latestBlock);
  if (!range) {
    await updateArtifactCheckpoint({
      wireJobId: job.id,
      artifactStatus: job.workflow?.artifactStatus ?? "PENDING",
      artifactLastCheckedBlock: latestBlock,
      lastError: null,
      nextRetryAt: nextRetryAt(),
    });
    return {
      jobId: job.jobId,
      status: "waiting_artifacts" as ReconcileResultStatus,
      detail: "No newer blocks are available for create-artifact recovery yet.",
    };
  }

  const logs = await publicClient.getLogs({
    address: contractAddress,
    event: getAbiItem({ abi: GHOSTWIRE_ERC8183_AGENTIC_COMMERCE_ABI, name: "JobCreated" }),
    args: {
      client: getAddress(job.clientAddress),
      provider: getAddress(job.providerAddress),
    },
    fromBlock: range.fromBlock,
    toBlock: range.toBlock,
  });

  const orderedLogs = [...logs].sort((left, right) => {
    const leftBlock = left.blockNumber ?? 0n;
    const rightBlock = right.blockNumber ?? 0n;
    if (leftBlock === rightBlock) {
      return (right.logIndex ?? 0) - (left.logIndex ?? 0);
    }
    return leftBlock > rightBlock ? -1 : 1;
  });

  let firstValidationError: string | null = null;
  const expectedDescription = job.metadataUri?.trim() || job.specHash;

  for (const log of orderedLogs) {
    if (!log.transactionHash) continue;

    try {
      const createValidation = await validateGhostWireCreateArtifact({
        chainId,
        expectedClientAddress: job.clientAddress,
        expectedProviderAddress: job.providerAddress,
        expectedEvaluatorAddress: job.evaluatorAddress,
        expectedJobExpiresAt: job.jobExpiresAt,
        expectedDescription,
        createTxHash: log.transactionHash,
      });

      await recordWireJobExecutionArtifacts({
        jobId: job.jobId,
        contractAddress: createValidation.contractAddress,
        contractJobId: createValidation.contractJobId,
        createTxHash: createValidation.createTxHash,
        createTxSender: createValidation.createTxSender,
        artifactValidationState: "PARTIAL",
        artifactValidationError: null,
        artifactStatus: "SUCCEEDED",
        createStatus: "SUCCEEDED",
        fundStatus: "PENDING",
        confirmationStatus: "PENDING",
        reconcileStatus: "PENDING",
        artifactCheckedAt: new Date(),
        artifactLastCheckedBlock: range.toBlock,
      });

      return {
        jobId: job.jobId,
        status: "recovered_create" as ReconcileResultStatus,
        detail: `Recovered create artifact ${createValidation.createTxHash}.`,
        contractJobId: createValidation.contractJobId,
        createTxHash: createValidation.createTxHash,
      };
    } catch (error) {
      firstValidationError = error instanceof Error ? error.message : "Create artifact validation failed.";
    }
  }

  await updateArtifactCheckpoint({
    wireJobId: job.id,
    artifactStatus: job.workflow?.artifactStatus ?? "PENDING",
    artifactLastCheckedBlock: range.toBlock,
    lastError: firstValidationError,
    nextRetryAt: nextRetryAt(),
  });
  return {
    jobId: job.jobId,
    status: "waiting_artifacts" as ReconcileResultStatus,
    detail: firstValidationError ?? "No matching create artifact was discovered yet.",
  };
};

const attemptFundArtifactRecovery = async (
  job: GhostWireArtifactRecoveryJob,
  overrides?: {
    contractJobId?: string;
    createTxHash?: string;
  },
) => {
  const chainId = job.chainId as GhostWireSupportedChainId;
  const contractAddress = resolveGhostWireContractAddress(chainId);
  const contractJobId = overrides?.contractJobId ?? job.contractJobId;
  if (!contractAddress || !contractJobId) {
    return {
      jobId: job.jobId,
      status: "waiting_artifacts" as ReconcileResultStatus,
      detail: "Fund-artifact recovery requires a discovered contract job id first.",
    };
  }

  const publicClient = createGhostWirePublicClient(chainId);
  const latestBlock = await publicClient.getBlockNumber();
  const range = buildArtifactDiscoveryRange(job.workflow?.artifactLastCheckedBlock ?? null, latestBlock);
  if (!range) {
    await updateArtifactCheckpoint({
      wireJobId: job.id,
      artifactStatus: job.workflow?.artifactStatus ?? "PENDING",
      artifactLastCheckedBlock: latestBlock,
      lastError: null,
      nextRetryAt: nextRetryAt(),
    });
    return {
      jobId: job.jobId,
      status: "waiting_artifacts" as ReconcileResultStatus,
      detail: "No newer blocks are available for fund-artifact recovery yet.",
    };
  }

  const logs = await publicClient.getLogs({
    address: contractAddress,
    event: getAbiItem({ abi: GHOSTWIRE_ERC8183_AGENTIC_COMMERCE_ABI, name: "JobFunded" }),
    args: {
      jobId: BigInt(contractJobId),
      client: getAddress(job.clientAddress),
    },
    fromBlock: range.fromBlock,
    toBlock: range.toBlock,
  });

  const orderedLogs = [...logs].sort((left, right) => {
    const leftBlock = left.blockNumber ?? 0n;
    const rightBlock = right.blockNumber ?? 0n;
    if (leftBlock === rightBlock) {
      return (right.logIndex ?? 0) - (left.logIndex ?? 0);
    }
    return leftBlock > rightBlock ? -1 : 1;
  });

  let firstValidationError: string | null = null;

  for (const log of orderedLogs) {
    if (!log.transactionHash) continue;

    const matchingEvent = parseGhostWireFundedLogs({
      logs: [log],
      expectedClientAddress: job.clientAddress,
      expectedContractJobId: contractJobId,
      expectedBudgetAmount: job.contractBudgetAmount,
    });
    if (!matchingEvent) continue;

    try {
      const fundValidation = await validateGhostWireFundArtifact({
        chainId,
        expectedClientAddress: job.clientAddress,
        expectedProviderAddress: job.providerAddress,
        expectedEvaluatorAddress: job.evaluatorAddress,
        expectedBudgetAmount: job.contractBudgetAmount,
        expectedContractJobId: contractJobId,
        fundTxHash: log.transactionHash,
      });

      await recordWireJobExecutionArtifacts({
        jobId: job.jobId,
        contractAddress: fundValidation.contractAddress,
        contractJobId,
        createTxHash: overrides?.createTxHash ?? job.createTxHash ?? undefined,
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
        artifactLastCheckedBlock: range.toBlock,
      });

      if (fundValidation.confirmations >= fundValidation.minConfirmations) {
        await reconcileWireJobFundedState({
          jobId: job.jobId,
          createTxHash: overrides?.createTxHash ?? job.createTxHash ?? "",
          fundTxHash: fundValidation.fundTxHash,
          confirmedAt: new Date(),
          blockNumber: fundValidation.blockNumber,
          confirmations: fundValidation.confirmations,
        });
      }

      return {
        jobId: job.jobId,
        status: "recovered_fund" as ReconcileResultStatus,
        detail: `Recovered fund artifact ${fundValidation.fundTxHash}.`,
      };
    } catch (error) {
      firstValidationError = error instanceof Error ? error.message : "Fund artifact validation failed.";
    }
  }

  await updateArtifactCheckpoint({
    wireJobId: job.id,
    artifactStatus: job.workflow?.artifactStatus ?? "PENDING",
    artifactLastCheckedBlock: range.toBlock,
    lastError: firstValidationError,
    nextRetryAt: nextRetryAt(),
  });
  return {
    jobId: job.jobId,
    status: "waiting_artifacts" as ReconcileResultStatus,
    detail: firstValidationError ?? "No matching fund artifact was discovered yet.",
  };
};

const attemptGhostWireArtifactRecovery = async (job: GhostWireArtifactRecoveryJob) => {
  if (!job.createTxHash) {
    const createResult = await attemptCreateArtifactRecovery(job);
    if (createResult.status === "recovered_create" && !job.fundTxHash) {
      return attemptFundArtifactRecovery(job, {
        contractJobId: createResult.contractJobId,
        createTxHash: createResult.createTxHash,
      });
    }
    return createResult;
  }

  if (!job.fundTxHash) {
    return attemptFundArtifactRecovery(job, {
      contractJobId: job.contractJobId ?? undefined,
      createTxHash: job.createTxHash ?? undefined,
    });
  }

  return {
    jobId: job.jobId,
    status: "already_reconciled" as ReconcileResultStatus,
    detail: "Both create and fund artifacts are already recorded.",
  };
};

const reconcileWireJobFundedConfirmation = async (job: GhostWirePendingJob) => {
  const chainId = job.chainId as GhostWireSupportedChainId;
  const minConfirmations = resolveGhostWireMinConfirmations(chainId);
  const fundTxHash = normalizeHash(job.fundTxHash);

  if (!fundTxHash || !job.createTxHash) {
    return {
      jobId: job.jobId,
      status: "waiting_artifacts" as ReconcileResultStatus,
      detail: "GhostWire is waiting for validated create/fund artifacts from the client wallet.",
    };
  }

  const observation = await getReceiptObservation({
    chainId,
    txHash: fundTxHash,
  });
  if (!observation.found) {
    await updateGhostWireWorkflowStage({
      wireJobId: job.id,
      stage: "confirmation",
      status: "IN_PROGRESS",
      lastError: observation.error,
      nextRetryAt: nextRetryAt(),
      incrementRetryCount: true,
    });
    return {
      jobId: job.jobId,
      status: "waiting_confirmation" as ReconcileResultStatus,
      detail: observation.error,
    };
  }

  if (observation.receipt.status !== "success") {
    const reason = "Fund transaction reverted on-chain after artifact recording.";
    await failWireJobArtifactValidation({
      jobId: job.jobId,
      stage: "fund",
      reason,
      artifactLastCheckedBlock: observation.receipt.blockNumber,
    });
    return {
      jobId: job.jobId,
      status: "manual_review" as ReconcileResultStatus,
      detail: reason,
    };
  }

  if (observation.confirmations < minConfirmations) {
    await updateGhostWireWorkflowStage({
      wireJobId: job.id,
      stage: "confirmation",
      status: "IN_PROGRESS",
      lastError: `Fund transaction has ${observation.confirmations}/${minConfirmations} confirmations.`,
      nextRetryAt: nextRetryAt(),
    });
    return {
      jobId: job.jobId,
      status: "waiting_confirmation" as ReconcileResultStatus,
      detail: `Fund transaction has ${observation.confirmations}/${minConfirmations} confirmations.`,
    };
  }

  const reconciled = await reconcileWireJobFundedState({
    jobId: job.jobId,
    createTxHash: job.createTxHash,
    fundTxHash: fundTxHash,
    confirmedAt: new Date(),
    blockNumber: observation.receipt.blockNumber,
    confirmations: observation.confirmations,
  });

  return {
    jobId: job.jobId,
    status: "confirmed_funded" as ReconcileResultStatus,
    state: reconciled.publicState,
    contractState: reconciled.contractState,
  };
};

const reconcileWireJobDirectLifecycle = async (job: GhostWirePendingJob) => {
  if (!job.contractAddress || !job.contractJobId) {
    return {
      jobId: job.jobId,
      status: "waiting_artifacts" as ReconcileResultStatus,
      detail: "GhostWire lifecycle reconciliation requires recorded contract artifacts first.",
    };
  }

  const chainId = job.chainId as GhostWireSupportedChainId;
  const minConfirmations = resolveGhostWireMinConfirmations(chainId);
  const publicClient = createGhostWirePublicClient(chainId);
  const onchainJob = await publicClient.readContract({
    address: getAddress(job.contractAddress),
    abi: GHOSTWIRE_ERC8183_AGENTIC_COMMERCE_ABI,
    functionName: "getJob",
    args: [BigInt(job.contractJobId)],
  });

  const onchainState = mapGhostWireContractStatus(onchainJob.status);
  if (onchainState === "OPEN") {
    const result = await markManualReview(
      job.id,
      "reconcile",
      "On-chain GhostWire job is still OPEN even though direct funding artifacts are already recorded.",
    );
    return { jobId: job.jobId, ...result };
  }

  if (onchainState === "FUNDED") {
    const expired = Math.floor(Date.now() / 1000) >= Number(onchainJob.expiredAt);
    return {
      jobId: job.jobId,
      status: "already_reconciled" as ReconcileResultStatus,
      detail: expired
        ? "GhostWire job is funded but expired on-chain; the client or evaluator must call claimRefund()."
        : "GhostWire job remains funded and is awaiting provider submission.",
    };
  }

  const latestLifecycleEvent = await getLatestGhostWireLifecycleEvent({
    chainId,
    contractAddress: getAddress(job.contractAddress),
    contractJobId: job.contractJobId,
  });

  if (!latestLifecycleEvent || latestLifecycleEvent.state !== onchainState) {
    const result = await markManualReview(
      job.id,
      "reconcile",
      `On-chain GhostWire job is ${onchainState} but the matching lifecycle event could not be resolved from logs.`,
    );
    return { jobId: job.jobId, ...result };
  }

  if (latestLifecycleEvent.confirmations < minConfirmations) {
    await updateGhostWireWorkflowStage({
      wireJobId: job.id,
      stage: "confirmation",
      status: "IN_PROGRESS",
      lastError: `${latestLifecycleEvent.state} transaction has ${latestLifecycleEvent.confirmations}/${minConfirmations} confirmations.`,
      nextRetryAt: nextRetryAt(),
    });
    return {
      jobId: job.jobId,
      status: "waiting_confirmation" as ReconcileResultStatus,
      detail: `${latestLifecycleEvent.state} transaction has ${latestLifecycleEvent.confirmations}/${minConfirmations} confirmations.`,
    };
  }

  if (onchainState === "SUBMITTED") {
    const reconciled = await reconcileWireJobSubmittedState({
      jobId: job.jobId,
      submitTxHash: latestLifecycleEvent.txHash,
      confirmedAt: new Date(),
      blockNumber: latestLifecycleEvent.blockNumber,
      confirmations: latestLifecycleEvent.confirmations,
      logIndex: latestLifecycleEvent.logIndex,
    });
    return {
      jobId: job.jobId,
      status: "confirmed_submitted" as ReconcileResultStatus,
      state: reconciled.publicState,
      contractState: reconciled.contractState,
    };
  }

  const reconciled = await reconcileWireJobTerminalState({
    jobId: job.jobId,
    state: onchainState,
    terminalTxHash: latestLifecycleEvent.txHash,
    confirmedAt: new Date(),
    blockNumber: latestLifecycleEvent.blockNumber,
    confirmations: latestLifecycleEvent.confirmations,
    logIndex: latestLifecycleEvent.logIndex,
  });
  return {
    jobId: job.jobId,
    status: "confirmed_terminal" as ReconcileResultStatus,
    state: reconciled.publicState,
    contractState: reconciled.contractState,
  };
};

const processGhostWireWorkflowJob = async (job: GhostWirePendingJob) => {
  if (!job.createTxHash || !job.fundTxHash || !job.contractAddress || !job.contractJobId) {
    return {
      jobId: job.jobId,
      status: "waiting_artifacts" as ReconcileResultStatus,
      detail: "GhostWire is waiting for the client wallet to report direct transaction artifacts.",
    };
  }

  if (job.contractState === "OPEN") {
    return reconcileWireJobFundedConfirmation(job);
  }

  return reconcileWireJobDirectLifecycle(job);
};

const deliverGhostWireWebhookEvent = async (event: GhostWirePendingWebhook) => {
  const targetUrl = event.wireJob.webhookTargetUrl?.trim() ?? null;
  const secret = event.wireJob.webhookSecret?.trim() ?? null;

  if (!targetUrl || !secret) {
    await updateWireWebhookOutboxDelivery({
      eventId: event.eventId,
      deliveryStatus: "DEAD_LETTER",
      lastError: "Webhook target configuration is missing for this GhostWire job.",
      incrementAttemptCount: true,
      nextAttemptAt: null,
    });
    return {
      eventId: event.eventId,
      status: "dead_letter" as const,
      detail: "Webhook target configuration is missing for this GhostWire job.",
    };
  }

  const timestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = JSON.stringify(event.payloadJson);
  const signature = signGhostWireWebhookPayload({
    secret,
    timestamp,
    rawBody,
  });

  try {
    const response = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ghost-event-id": event.eventId,
        "x-ghost-event-type": event.eventType,
        "x-ghost-timestamp": timestamp,
        "x-ghost-signature": signature,
        "x-ghost-delivery-attempt": String(event.attemptCount + 1),
      },
      body: rawBody,
    });

    if (response.ok) {
      await updateWireWebhookOutboxDelivery({
        eventId: event.eventId,
        deliveryStatus: "DELIVERED",
        deliveredAt: new Date(),
        lastError: null,
        nextAttemptAt: null,
        incrementAttemptCount: true,
      });
      return {
        eventId: event.eventId,
        status: "delivered" as const,
      };
    }

    const responseText = (await response.text()).slice(0, 500);
    const retryable = isRetryableWebhookStatus(response.status);
    const exhausted = event.attemptCount + 1 >= GHOSTWIRE_WEBHOOK_MAX_ATTEMPTS;

    await updateWireWebhookOutboxDelivery({
      eventId: event.eventId,
      deliveryStatus: retryable && !exhausted ? "FAILED" : "DEAD_LETTER",
      lastError: `Webhook delivery failed with HTTP ${response.status}${responseText ? `: ${responseText}` : ""}`,
      nextAttemptAt: retryable && !exhausted ? nextWebhookRetryAt(event.attemptCount + 1) : null,
      incrementAttemptCount: true,
    });

    return {
      eventId: event.eventId,
      status: retryable && !exhausted ? ("retrying" as const) : ("dead_letter" as const),
      detail: `HTTP ${response.status}`,
    };
  } catch (error) {
    const exhausted = event.attemptCount + 1 >= GHOSTWIRE_WEBHOOK_MAX_ATTEMPTS;
    const message = error instanceof Error ? error.message : "Webhook delivery failed.";

    await updateWireWebhookOutboxDelivery({
      eventId: event.eventId,
      deliveryStatus: exhausted ? "DEAD_LETTER" : "FAILED",
      lastError: message,
      nextAttemptAt: exhausted ? null : nextWebhookRetryAt(event.attemptCount + 1),
      incrementAttemptCount: true,
    });

    return {
      eventId: event.eventId,
      status: exhausted ? ("dead_letter" as const) : ("retrying" as const),
      detail: message,
    };
  }
};

const deliverPendingGhostWireWebhooks = async (limit: number) => {
  const events = await listPendingWireWebhookOutboxEvents(limit);
  const results = [];

  for (const event of events) {
    results.push(await deliverGhostWireWebhookEvent(event));
  }

  return {
    processedCount: events.length,
    results,
  };
};

const discoverGhostWireArtifacts = async (limit: number) => {
  const now = new Date();
  const recoveryCandidates = await listWireJobsForArtifactRecovery({
    limit,
    notCheckedBefore: new Date(now.getTime() - GHOSTWIRE_ARTIFACT_RECOVERY_GRACE_WINDOW_MS),
    createdAfter: new Date(now.getTime() - GHOSTWIRE_ARTIFACT_RECOVERY_ELIGIBILITY_WINDOW_MS),
  });

  const results = [];
  for (const job of recoveryCandidates) {
    results.push(await attemptGhostWireArtifactRecovery(job));
  }

  return {
    processedCount: recoveryCandidates.length,
    results,
  };
};

export const processGhostWireOperatorTick = async (input?: {
  workflowLimit?: number;
  webhookLimit?: number;
}) => {
  const workflowLimit = Math.max(
    1,
    Math.min(input?.workflowLimit ?? GHOSTWIRE_OPERATOR_DEFAULT_WORKFLOW_LIMIT, GHOSTWIRE_OPERATOR_MAX_LIMIT),
  );
  const webhookLimit = Math.max(
    1,
    Math.min(input?.webhookLimit ?? GHOSTWIRE_OPERATOR_DEFAULT_WEBHOOK_LIMIT, GHOSTWIRE_OPERATOR_MAX_LIMIT),
  );

  const artifactRecovery = await discoverGhostWireArtifacts(workflowLimit);
  const jobs = await listWireJobsNeedingOperatorWork(workflowLimit);
  const reconciled = [];

  for (const job of jobs) {
    reconciled.push(await processGhostWireWorkflowJob(job));
  }

  const webhookDelivery = await deliverPendingGhostWireWebhooks(webhookLimit);
  const snapshot = await resolveGhostWireOperatorSnapshot({
    workflowLimit,
    webhookLimit,
  });

  return {
    ok: true,
    operatorMode: GHOSTWIRE_OPERATOR_MODE,
    processedAt: new Date().toISOString(),
    processedArtifactRecoveryCount: artifactRecovery.processedCount,
    processedWorkflowCount: jobs.length,
    processedWebhookCount: webhookDelivery.processedCount,
    artifactRecovery: artifactRecovery.results,
    reconciled,
    webhookDelivery: webhookDelivery.results,
    snapshot,
  };
};

export const resolveGhostWireOperatorSnapshot = async (input?: {
  workflowLimit?: number;
  webhookLimit?: number;
}) => {
  const workflowLimit = Math.max(
    1,
    Math.min(input?.workflowLimit ?? GHOSTWIRE_OPERATOR_DEFAULT_WORKFLOW_LIMIT, GHOSTWIRE_OPERATOR_MAX_LIMIT),
  );
  const webhookLimit = Math.max(
    1,
    Math.min(input?.webhookLimit ?? GHOSTWIRE_OPERATOR_DEFAULT_WEBHOOK_LIMIT, GHOSTWIRE_OPERATOR_MAX_LIMIT),
  );
  const now = new Date();

  const [workflowBacklogCount, webhookBacklogCount, jobs, webhooks, stateCounts, webhookStatusCounts] =
    await Promise.all([
      countWireJobsNeedingOperatorWork(),
      prisma.wireWebhookOutbox.count({
        where: {
          deliveryStatus: { in: ["PENDING", "FAILED"] },
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        },
      }),
      listWireJobsNeedingOperatorWork(workflowLimit),
      listPendingWireWebhookOutboxEvents(webhookLimit),
      prisma.wireJob.groupBy({
        by: ["publicState"],
        _count: { _all: true },
      }),
      prisma.wireWebhookOutbox.groupBy({
        by: ["deliveryStatus"],
        _count: { _all: true },
      }),
    ]);

  return {
    environment: {
      settlementAsset: GHOSTWIRE_SUPPORTED_SETTLEMENT_ASSET,
      quoteTtlSeconds: GHOSTWIRE_QUOTE_TTL_SECONDS,
      jobExpirySeconds: GHOSTWIRE_JOB_EXPIRY_SECONDS,
      maxExpiryWindowSeconds: GHOSTWIRE_MAX_EXPIRY_WINDOW_SECONDS,
      submittedEvaluationGraceSeconds: GHOSTWIRE_SUBMITTED_EVALUATION_GRACE_SECONDS,
      operatorMode: GHOSTWIRE_OPERATOR_MODE,
      directExecution: {
        customerFundsEscrow: true,
        customerPaysGas: true,
        sponsorshipSupported: false,
      },
      artifactRecovery: {
        graceWindowSeconds: Math.trunc(GHOSTWIRE_ARTIFACT_RECOVERY_GRACE_WINDOW_MS / 1000),
        eligibilityWindowSeconds: Math.trunc(GHOSTWIRE_ARTIFACT_RECOVERY_ELIGIBILITY_WINDOW_MS / 1000),
        perPassJobCap: workflowLimit,
        perJobBlockScanCap: Number(GHOSTWIRE_ARTIFACT_RECOVERY_MAX_BLOCK_SCAN),
      },
      contractSurface: {
        repository: GHOSTWIRE_ERC8183_PINNED_REPOSITORY,
        contract: GHOSTWIRE_ERC8183_PINNED_CONTRACT,
        commit: GHOSTWIRE_ERC8183_PINNED_COMMIT,
      },
      chains: {
        mainnet: {
          chainId: GHOSTWIRE_SUPPORTED_MAINNET_CHAIN_ID,
          minConfirmations: resolveGhostWireMinConfirmations(GHOSTWIRE_SUPPORTED_MAINNET_CHAIN_ID),
          contractAddress: resolveGhostWireContractAddress(GHOSTWIRE_SUPPORTED_MAINNET_CHAIN_ID),
          rpcUrl: resolveGhostWireRpcUrl(GHOSTWIRE_SUPPORTED_MAINNET_CHAIN_ID),
        },
        testnet: {
          chainId: GHOSTWIRE_SUPPORTED_TESTNET_CHAIN_ID,
          minConfirmations: resolveGhostWireMinConfirmations(GHOSTWIRE_SUPPORTED_TESTNET_CHAIN_ID),
          contractAddress: resolveGhostWireContractAddress(GHOSTWIRE_SUPPORTED_TESTNET_CHAIN_ID),
          rpcUrl: resolveGhostWireRpcUrl(GHOSTWIRE_SUPPORTED_TESTNET_CHAIN_ID),
        },
      },
    },
    workflow: {
      backlogCount: workflowBacklogCount,
      sampleLimit: workflowLimit,
      jobs: jobs.map((job) => ({
        id: job.id,
        jobId: job.jobId,
        quoteId: job.quoteId,
        chainId: job.chainId,
        state: job.publicState,
        contractState: job.contractState,
        contractAddress: job.contractAddress,
        contractJobId: job.contractJobId,
        createTxHash: job.createTxHash,
        createTxSender: job.createTxSender,
        fundTxHash: job.fundTxHash,
        fundTxSender: job.fundTxSender,
        artifactsRecordedAt: job.artifactsRecordedAt?.toISOString() ?? null,
        artifactValidationState: job.artifactValidationState,
        artifactValidationError: job.artifactValidationError,
        jobExpiresAt: job.jobExpiresAt.toISOString(),
        createdAt: job.createdAt.toISOString(),
        updatedAt: job.updatedAt.toISOString(),
        operator: {
          artifactStatus: job.workflow?.artifactStatus ?? null,
          artifactCheckedAt: job.workflow?.artifactCheckedAt?.toISOString() ?? null,
          createStatus: job.workflow?.createStatus ?? null,
          fundStatus: job.workflow?.fundStatus ?? null,
          confirmationStatus: job.workflow?.confirmationStatus ?? null,
          reconcileStatus: job.workflow?.reconcileStatus ?? null,
          retryCount: job.workflow?.retryCount ?? null,
          nextRetryAt: job.workflow?.nextRetryAt?.toISOString() ?? null,
          lastError: job.workflow?.lastError ?? null,
          manualReviewRequired: job.workflow?.manualReviewRequired ?? null,
          manualReviewReason: job.workflow?.manualReviewReason ?? null,
        },
      })),
      states: Object.fromEntries(stateCounts.map((row) => [row.publicState, row._count._all])),
    },
    webhooks: {
      backlogCount: webhookBacklogCount,
      sampleLimit: webhookLimit,
      events: webhooks.map((event) => ({
        eventId: event.eventId,
        jobId: event.wireJob.jobId,
        eventType: event.eventType,
        state: event.state,
        contractState: event.contractState,
        deliveryStatus: event.deliveryStatus,
        attemptCount: event.attemptCount,
        nextAttemptAt: event.nextAttemptAt?.toISOString() ?? null,
        deliveredAt: event.deliveredAt?.toISOString() ?? null,
        createdAt: event.createdAt.toISOString(),
        lastError: event.lastError,
        hasWebhookTarget: Boolean(event.wireJob.webhookTargetUrl && event.wireJob.webhookSecret),
      })),
      statuses: Object.fromEntries(webhookStatusCounts.map((row) => [row.deliveryStatus, row._count._all])),
    },
  };
};
