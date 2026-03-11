import {
  type WireWebhookDeliveryStatus,
  type WireWorkflowStatus,
} from "@prisma/client";
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  getAddress,
  http,
  maxUint256,
  parseEventLogs,
  type Hash,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import { prisma } from "@/lib/db";
import { GHOSTWIRE_ERC8183_AGENTIC_COMMERCE_ABI } from "@/lib/ghostwire-contract";
import {
  getGhostWireOperatorAccount,
  GHOSTWIRE_ERC8183_PINNED_COMMIT,
  GHOSTWIRE_ERC8183_PINNED_CONTRACT,
  GHOSTWIRE_ERC8183_PINNED_REPOSITORY,
  GHOSTWIRE_JOB_EXPIRY_SECONDS,
  GHOSTWIRE_MIN_CONFIRMATIONS_MAINNET,
  GHOSTWIRE_MIN_CONFIRMATIONS_TESTNET,
  GHOSTWIRE_QUOTE_TTL_SECONDS,
  GHOSTWIRE_SUPPORTED_MAINNET_CHAIN_ID,
  GHOSTWIRE_SUPPORTED_SETTLEMENT_ASSET,
  GHOSTWIRE_SUPPORTED_TESTNET_CHAIN_ID,
  resolveGhostWireContractAddress,
  resolveGhostWireMinConfirmations,
  resolveGhostWireRpcUrl,
  resolveGhostWireUsdcAddress,
  type GhostWireSupportedChainId,
} from "@/lib/ghostwire-config";
import {
  listPendingWireWebhookOutboxEvents,
  listWireJobsNeedingOperatorWork,
  markWireJobForManualReview,
  recordWireJobExecutionArtifacts,
  reconcileWireJobFundedState,
  updateWireWebhookOutboxDelivery,
  upsertWireOperatorSpend,
  WireJobExecutionConflictError,
} from "@/lib/ghostwire-store";
import { signGhostWireWebhookPayload } from "@/lib/ghostwire-webhooks";

export const GHOSTWIRE_OPERATOR_DEFAULT_WORKFLOW_LIMIT = 25;
export const GHOSTWIRE_OPERATOR_DEFAULT_WEBHOOK_LIMIT = 25;
export const GHOSTWIRE_OPERATOR_MAX_LIMIT = 100;

const GHOSTWIRE_OPERATOR_RETRY_DELAY_MS = 5 * 60 * 1000;
const GHOSTWIRE_WEBHOOK_MAX_ATTEMPTS = 6;
const GHOSTWIRE_WEBHOOK_BASE_RETRY_DELAY_MS = 60 * 1000;
const GHOSTWIRE_WEBHOOK_MAX_RETRY_DELAY_MS = 30 * 60 * 1000;

export type GhostWireWorkflowStage = "create" | "fund" | "confirmation" | "reconcile";

type ReconcileResultStatus =
  | "already_reconciled"
  | "waiting_execution"
  | "waiting_confirmation"
  | "confirmed_funded"
  | "manual_review"
  | "submitted"
  | "failed";

type GhostWireExecutionRecordInput = {
  jobId: string;
  contractAddress: string;
  contractJobId: string;
  createTxHash: string;
  fundTxHash: string;
};

type GhostWirePendingJob = Awaited<ReturnType<typeof listWireJobsNeedingOperatorWork>>[number];
type GhostWirePendingWebhook = Awaited<ReturnType<typeof listPendingWireWebhookOutboxEvents>>[number];

const buildWorkflowStagePatch = (
  stage: GhostWireWorkflowStage,
  status: WireWorkflowStatus,
): Partial<{
  createStatus: WireWorkflowStatus;
  fundStatus: WireWorkflowStatus;
  confirmationStatus: WireWorkflowStatus;
  reconcileStatus: WireWorkflowStatus;
}> => {
  switch (stage) {
    case "create":
      return { createStatus: status };
    case "fund":
      return { fundStatus: status };
    case "confirmation":
      return { confirmationStatus: status };
    case "reconcile":
      return { reconcileStatus: status };
  }
};

const resolveWireChain = (chainId: GhostWireSupportedChainId) =>
  chainId === GHOSTWIRE_SUPPORTED_MAINNET_CHAIN_ID ? base : baseSepolia;

const createGhostWirePublicClient = (chainId: GhostWireSupportedChainId) =>
  createPublicClient({
    chain: resolveWireChain(chainId),
    transport: http(resolveGhostWireRpcUrl(chainId), {
      retryCount: 2,
      retryDelay: 250,
      timeout: 15_000,
    }),
  });

const createGhostWireWalletClient = (chainId: GhostWireSupportedChainId) => {
  const account = getGhostWireOperatorAccount();
  if (!account) return null;

  return createWalletClient({
    account,
    chain: resolveWireChain(chainId),
    transport: http(resolveGhostWireRpcUrl(chainId), {
      retryCount: 2,
      retryDelay: 250,
      timeout: 15_000,
    }),
  });
};

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

const recordOperatorSpendFromReceipt = async (input: {
  wireJobId: string;
  actionType: "APPROVE" | "CREATE" | "FUND";
  txHash: Hash;
  receipt: Awaited<ReturnType<ReturnType<typeof createGhostWirePublicClient>["getTransactionReceipt"]>>;
}) =>
  upsertWireOperatorSpend({
    wireJobId: input.wireJobId,
    actionType: input.actionType,
    txHash: input.txHash,
    gasUsed: input.receipt.gasUsed,
    effectiveGasPrice: input.receipt.effectiveGasPrice ?? 0n,
    nativeAmountSpent: input.receipt.gasUsed * (input.receipt.effectiveGasPrice ?? 0n),
  });

const updateGhostWireWorkflowStage = async (input: {
  jobId: string;
  stage: GhostWireWorkflowStage;
  status: WireWorkflowStatus;
  lastError?: string | null;
  nextRetryAt?: Date | null;
  incrementRetryCount?: boolean;
}) =>
  prisma.wireJobWorkflow.update({
    where: { wireJobId: input.jobId },
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

const markManualReview = async (jobId: string, stage: GhostWireWorkflowStage, reason: string) => {
  await markWireJobForManualReview({
    jobId,
    stage,
    reason,
  });

  return {
    status: "manual_review" as const,
    detail: reason,
  };
};

const resolveGhostWireHostedContext = async (job: GhostWirePendingJob) => {
  const chainId = job.chainId as GhostWireSupportedChainId;
  const account = getGhostWireOperatorAccount();
  if (!account) {
    return {
      ok: false as const,
      reason: "GHOSTWIRE_OPERATOR_PRIVATE_KEY is not configured for hosted GhostWire execution.",
    };
  }

  const contractAddress = resolveGhostWireContractAddress(chainId);
  if (!contractAddress) {
    return {
      ok: false as const,
      reason: `No GhostWire ERC-8183 contract address is configured for chain ${chainId}.`,
    };
  }

  if (job.clientAddress.toLowerCase() !== account.address.toLowerCase()) {
    return {
      ok: false as const,
      reason:
        "Hosted GhostWire create/fund execution only supports jobs whose client address matches the configured operator account.",
    };
  }

  const publicClient = createGhostWirePublicClient(chainId);
  const walletClient = createGhostWireWalletClient(chainId);
  if (!walletClient) {
    return {
      ok: false as const,
      reason: "GhostWire wallet client could not be created from the configured operator key.",
    };
  }

  const [paymentToken, platformFeeBp] = await Promise.all([
    publicClient.readContract({
      address: contractAddress,
      abi: GHOSTWIRE_ERC8183_AGENTIC_COMMERCE_ABI,
      functionName: "paymentToken",
    }),
    publicClient.readContract({
      address: contractAddress,
      abi: GHOSTWIRE_ERC8183_AGENTIC_COMMERCE_ABI,
      functionName: "platformFeeBP",
    }),
  ]);

  if (platformFeeBp !== 0n) {
    return {
      ok: false as const,
      reason:
        `GhostWire v1 requires an ERC-8183 contract with platformFeeBP=0. The configured contract reports ${platformFeeBp.toString()}.`,
    };
  }

  const expectedPaymentToken = resolveGhostWireUsdcAddress(chainId);
  if (getAddress(paymentToken) !== expectedPaymentToken) {
    return {
      ok: false as const,
      reason:
        `GhostWire v1 requires the ERC-8183 payment token to match ${GHOSTWIRE_SUPPORTED_SETTLEMENT_ASSET} on chain ${chainId}.`,
    };
  }

  return {
    ok: true as const,
    chainId,
    account,
    contractAddress,
    expectedPaymentToken,
    publicClient,
    walletClient,
  };
};

const parseJobCreatedEvent = (job: GhostWirePendingJob, logs: readonly unknown[]) => {
  const events = parseEventLogs({
    abi: GHOSTWIRE_ERC8183_AGENTIC_COMMERCE_ABI,
    logs: logs as never,
    eventName: "JobCreated",
    strict: false,
  });

  const match = events.find((event) => {
    const client = typeof event.args.client === "string" ? event.args.client.toLowerCase() : null;
    const provider = typeof event.args.provider === "string" ? event.args.provider.toLowerCase() : null;
    return client === job.clientAddress.toLowerCase() && provider === job.providerAddress.toLowerCase();
  });

  const rawJobId = match?.args.jobId;
  return typeof rawJobId === "bigint" ? rawJobId.toString() : null;
};

const attemptGhostWireHostedCreateAndFund = async (job: GhostWirePendingJob) => {
  if (job.contractState !== "OPEN") {
    return {
      jobId: job.jobId,
      status: "waiting_confirmation" as ReconcileResultStatus,
      detail: `Wire job is already in ${job.contractState} state.`,
    };
  }

  const context = await resolveGhostWireHostedContext(job);
  if (!context.ok) {
    const result = await markManualReview(job.id, "create", context.reason);
    return { jobId: job.jobId, ...result };
  }

  const {
    account,
    contractAddress,
    expectedPaymentToken,
    publicClient,
    walletClient,
  } = context;

  let contractJobId = job.contractJobId;
  let createTxHash = normalizeHash(job.createTxHash);
  let fundTxHash = normalizeHash(job.fundTxHash);

  if (!createTxHash || !contractJobId || !job.contractAddress) {
    await updateGhostWireWorkflowStage({
      jobId: job.id,
      stage: "create",
      status: "IN_PROGRESS",
      lastError: null,
      nextRetryAt: null,
    });

    try {
      const createHash = await walletClient.writeContract({
        account,
        chain: walletClient.chain,
        address: contractAddress,
        abi: GHOSTWIRE_ERC8183_AGENTIC_COMMERCE_ABI,
        functionName: "createJob",
        args: [
          getAddress(job.providerAddress),
          getAddress(job.evaluatorAddress),
          BigInt(Math.floor(job.jobExpiresAt.getTime() / 1000)),
          job.metadataUri?.trim() || job.specHash,
        ],
      });
      const createReceipt = await publicClient.waitForTransactionReceipt({
        hash: createHash,
        confirmations: 1,
        timeout: 120_000,
      });

      if (createReceipt.status !== "success") {
        await updateGhostWireWorkflowStage({
          jobId: job.id,
          stage: "create",
          status: "FAILED",
          lastError: "createJob transaction reverted on-chain.",
          nextRetryAt: nextRetryAt(),
          incrementRetryCount: true,
        });
        return {
          jobId: job.jobId,
          status: "failed" as ReconcileResultStatus,
          detail: "createJob transaction reverted on-chain.",
        };
      }

      const parsedContractJobId = parseJobCreatedEvent(job, createReceipt.logs);
      if (!parsedContractJobId) {
        const result = await markManualReview(
          job.id,
          "create",
          "createJob succeeded but JobCreated event could not be decoded for the pinned ERC-8183 ABI.",
        );
        return { jobId: job.jobId, ...result };
      }

      await recordOperatorSpendFromReceipt({
        wireJobId: job.id,
        actionType: "CREATE",
        txHash: createHash,
        receipt: createReceipt,
      });

      await recordWireJobExecutionArtifacts({
        jobId: job.jobId,
        contractAddress,
        contractJobId: parsedContractJobId,
        createTxHash: createHash,
      });

      createTxHash = createHash;
      contractJobId = parsedContractJobId;
    } catch (error) {
      await updateGhostWireWorkflowStage({
        jobId: job.id,
        stage: "create",
        status: "FAILED",
        lastError: error instanceof Error ? error.message : "Failed to create hosted GhostWire job.",
        nextRetryAt: nextRetryAt(),
        incrementRetryCount: true,
      });
      return {
        jobId: job.jobId,
        status: "failed" as ReconcileResultStatus,
        detail: error instanceof Error ? error.message : "Failed to create hosted GhostWire job.",
      };
    }
  }

  if (!contractJobId || !createTxHash) {
    const result = await markManualReview(
      job.id,
      "create",
      "GhostWire execution is missing create artifacts after hosted job creation.",
    );
    return { jobId: job.jobId, ...result };
  }

  try {
    const budgetHash = await walletClient.writeContract({
      account,
      chain: walletClient.chain,
      address: contractAddress,
      abi: GHOSTWIRE_ERC8183_AGENTIC_COMMERCE_ABI,
      functionName: "setBudget",
      args: [BigInt(contractJobId), job.contractBudgetAmount],
    });
    const budgetReceipt = await publicClient.waitForTransactionReceipt({
      hash: budgetHash,
      confirmations: 1,
      timeout: 120_000,
    });

    if (budgetReceipt.status !== "success") {
      await updateGhostWireWorkflowStage({
        jobId: job.id,
        stage: "create",
        status: "FAILED",
        lastError: "setBudget transaction reverted on-chain.",
        nextRetryAt: nextRetryAt(),
        incrementRetryCount: true,
      });
      return {
        jobId: job.jobId,
        status: "failed" as ReconcileResultStatus,
        detail: "setBudget transaction reverted on-chain.",
      };
    }

    await recordOperatorSpendFromReceipt({
      wireJobId: job.id,
      actionType: "CREATE",
      txHash: budgetHash,
      receipt: budgetReceipt,
    });

    await updateGhostWireWorkflowStage({
      jobId: job.id,
      stage: "create",
      status: "SUCCEEDED",
      lastError: null,
      nextRetryAt: null,
    });
  } catch (error) {
    await updateGhostWireWorkflowStage({
      jobId: job.id,
      stage: "create",
      status: "FAILED",
      lastError: error instanceof Error ? error.message : "Failed to set hosted GhostWire budget.",
      nextRetryAt: nextRetryAt(),
      incrementRetryCount: true,
    });
    return {
      jobId: job.jobId,
      status: "failed" as ReconcileResultStatus,
      detail: error instanceof Error ? error.message : "Failed to set hosted GhostWire budget.",
    };
  }

  if (!fundTxHash) {
    await updateGhostWireWorkflowStage({
      jobId: job.id,
      stage: "fund",
      status: "IN_PROGRESS",
      lastError: null,
      nextRetryAt: null,
    });

    try {
      const allowance = await publicClient.readContract({
        address: expectedPaymentToken,
        abi: erc20Abi,
        functionName: "allowance",
        args: [account.address, contractAddress],
      });

      if (allowance < job.contractBudgetAmount) {
        const approveHash = await walletClient.writeContract({
          account,
          chain: walletClient.chain,
          address: expectedPaymentToken,
          abi: erc20Abi,
          functionName: "approve",
          args: [contractAddress, maxUint256],
        });
        const approveReceipt = await publicClient.waitForTransactionReceipt({
          hash: approveHash,
          confirmations: 1,
          timeout: 120_000,
        });

        if (approveReceipt.status !== "success") {
          await updateGhostWireWorkflowStage({
            jobId: job.id,
            stage: "fund",
            status: "FAILED",
            lastError: "approve transaction reverted on-chain.",
            nextRetryAt: nextRetryAt(),
            incrementRetryCount: true,
          });
          return {
            jobId: job.jobId,
            status: "failed" as ReconcileResultStatus,
            detail: "approve transaction reverted on-chain.",
          };
        }

        await recordOperatorSpendFromReceipt({
          wireJobId: job.id,
          actionType: "APPROVE",
          txHash: approveHash,
          receipt: approveReceipt,
        });
      }

      const nextFundHash = await walletClient.writeContract({
        account,
        chain: walletClient.chain,
        address: contractAddress,
        abi: GHOSTWIRE_ERC8183_AGENTIC_COMMERCE_ABI,
        functionName: "fund",
        args: [BigInt(contractJobId), job.contractBudgetAmount],
      });
      const fundReceipt = await publicClient.waitForTransactionReceipt({
        hash: nextFundHash,
        confirmations: 1,
        timeout: 120_000,
      });

      if (fundReceipt.status !== "success") {
        await updateGhostWireWorkflowStage({
          jobId: job.id,
          stage: "fund",
          status: "FAILED",
          lastError: "fund transaction reverted on-chain.",
          nextRetryAt: nextRetryAt(),
          incrementRetryCount: true,
        });
        return {
          jobId: job.jobId,
          status: "failed" as ReconcileResultStatus,
          detail: "fund transaction reverted on-chain.",
        };
      }

      await recordOperatorSpendFromReceipt({
        wireJobId: job.id,
        actionType: "FUND",
        txHash: nextFundHash,
        receipt: fundReceipt,
      });

      await recordWireJobExecutionArtifacts({
        jobId: job.jobId,
        contractAddress,
        contractJobId,
        fundTxHash: nextFundHash,
      });

      fundTxHash = nextFundHash;

      await updateGhostWireWorkflowStage({
        jobId: job.id,
        stage: "fund",
        status: "IN_PROGRESS",
        lastError: null,
        nextRetryAt: nextRetryAt(),
      });
      await updateGhostWireWorkflowStage({
        jobId: job.id,
        stage: "confirmation",
        status: "IN_PROGRESS",
        lastError: null,
        nextRetryAt: nextRetryAt(),
      });

      return {
        jobId: job.jobId,
        status: "submitted" as ReconcileResultStatus,
        detail: "Hosted create/fund path submitted successfully and is awaiting confirmations.",
        createTxHash,
        fundTxHash,
      };
    } catch (error) {
      if (error instanceof WireJobExecutionConflictError) {
        const result = await markManualReview(job.id, "fund", error.message);
        return { jobId: job.jobId, ...result };
      }

      await updateGhostWireWorkflowStage({
        jobId: job.id,
        stage: "fund",
        status: "FAILED",
        lastError: error instanceof Error ? error.message : "Failed to fund hosted GhostWire job.",
        nextRetryAt: nextRetryAt(),
        incrementRetryCount: true,
      });
      return {
        jobId: job.jobId,
        status: "failed" as ReconcileResultStatus,
        detail: error instanceof Error ? error.message : "Failed to fund hosted GhostWire job.",
      };
    }
  }

  return {
    jobId: job.jobId,
    status: "waiting_confirmation" as ReconcileResultStatus,
    detail: "Hosted create/fund artifacts already recorded; waiting for confirmation reconciliation.",
    createTxHash,
    fundTxHash,
  };
};

const reconcileWireJobConfirmedState = async (job: GhostWirePendingJob) => {
  if (job.contractState === "FUNDED" && job.workflow?.reconcileStatus === "SUCCEEDED") {
    return {
      jobId: job.jobId,
      status: "already_reconciled" as ReconcileResultStatus,
    };
  }

  const createTxHash = normalizeHash(job.createTxHash);
  const fundTxHash = normalizeHash(job.fundTxHash);
  const chainId = job.chainId as GhostWireSupportedChainId;
  const minConfirmations = resolveGhostWireMinConfirmations(chainId);

  if (!job.contractAddress || !job.contractJobId || !createTxHash || !fundTxHash) {
    return {
      jobId: job.jobId,
      status: "waiting_execution" as ReconcileResultStatus,
      detail: "Execution artifacts have not been recorded yet.",
    };
  }

  await updateGhostWireWorkflowStage({
    jobId: job.id,
    stage: "confirmation",
    status: "IN_PROGRESS",
    lastError: null,
    nextRetryAt: null,
  });

  const createObservation = await getReceiptObservation({ chainId, txHash: createTxHash });
  if (!createObservation.found) {
    await updateGhostWireWorkflowStage({
      jobId: job.id,
      stage: "confirmation",
      status: "IN_PROGRESS",
      lastError: createObservation.error,
      nextRetryAt: nextRetryAt(),
      incrementRetryCount: true,
    });
    return {
      jobId: job.jobId,
      status: "waiting_confirmation" as ReconcileResultStatus,
      detail: createObservation.error,
    };
  }

  if (createObservation.receipt.status !== "success") {
    await updateGhostWireWorkflowStage({
      jobId: job.id,
      stage: "create",
      status: "FAILED",
      lastError: "Create transaction reverted on-chain.",
      nextRetryAt: nextRetryAt(),
      incrementRetryCount: true,
    });
    return {
      jobId: job.jobId,
      status: "failed" as ReconcileResultStatus,
      detail: "Create transaction reverted on-chain.",
    };
  }

  await recordOperatorSpendFromReceipt({
    wireJobId: job.id,
    actionType: "CREATE",
    txHash: createTxHash,
    receipt: createObservation.receipt,
  });

  const fundObservation = await getReceiptObservation({ chainId, txHash: fundTxHash });
  if (!fundObservation.found) {
    await updateGhostWireWorkflowStage({
      jobId: job.id,
      stage: "fund",
      status: "IN_PROGRESS",
      lastError: fundObservation.error,
      nextRetryAt: nextRetryAt(),
      incrementRetryCount: true,
    });
    return {
      jobId: job.jobId,
      status: "waiting_confirmation" as ReconcileResultStatus,
      detail: fundObservation.error,
    };
  }

  if (fundObservation.receipt.status !== "success") {
    await updateGhostWireWorkflowStage({
      jobId: job.id,
      stage: "fund",
      status: "FAILED",
      lastError: "Fund transaction reverted on-chain.",
      nextRetryAt: nextRetryAt(),
      incrementRetryCount: true,
    });
    return {
      jobId: job.jobId,
      status: "failed" as ReconcileResultStatus,
      detail: "Fund transaction reverted on-chain.",
    };
  }

  if (fundObservation.confirmations < minConfirmations) {
    await updateGhostWireWorkflowStage({
      jobId: job.id,
      stage: "fund",
      status: "IN_PROGRESS",
      lastError: `Fund transaction has ${fundObservation.confirmations}/${minConfirmations} confirmations.`,
      nextRetryAt: nextRetryAt(),
    });
    return {
      jobId: job.jobId,
      status: "waiting_confirmation" as ReconcileResultStatus,
      detail: `Fund transaction has ${fundObservation.confirmations}/${minConfirmations} confirmations.`,
    };
  }

  await recordOperatorSpendFromReceipt({
    wireJobId: job.id,
    actionType: "FUND",
    txHash: fundTxHash,
    receipt: fundObservation.receipt,
  });

  const reconciled = await reconcileWireJobFundedState({
    jobId: job.jobId,
    createTxHash,
    fundTxHash,
    confirmedAt: new Date(),
    blockNumber: fundObservation.receipt.blockNumber,
    confirmations: fundObservation.confirmations,
  });

  return {
    jobId: job.jobId,
    status: "confirmed_funded" as ReconcileResultStatus,
    state: reconciled.publicState,
    contractState: reconciled.contractState,
  };
};

const processGhostWireWorkflowJob = async (job: GhostWirePendingJob) => {
  if (!job.createTxHash || !job.fundTxHash || !job.contractAddress || !job.contractJobId) {
    return attemptGhostWireHostedCreateAndFund(job);
  }

  return reconcileWireJobConfirmedState(job);
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

export const recordGhostWireExecutionBatch = async (records: GhostWireExecutionRecordInput[]) => {
  const accepted: Array<{
    jobId: string;
    contractAddress: string;
    contractJobId: string;
    createTxHash: string;
    fundTxHash: string;
  }> = [];
  const rejected: Array<{ jobId: string; error: string }> = [];

  for (const record of records) {
    try {
      const result = await recordWireJobExecutionArtifacts(record);
      accepted.push({
        jobId: result.jobId,
        contractAddress: result.contractAddress ?? "",
        contractJobId: result.contractJobId ?? "",
        createTxHash: result.createTxHash ?? "",
        fundTxHash: result.fundTxHash ?? "",
      });
    } catch (error) {
      const message =
        error instanceof WireJobExecutionConflictError || error instanceof Error
          ? error.message
          : "Failed to record GhostWire execution artifacts.";
      rejected.push({ jobId: record.jobId, error: message });
    }
  }

  return {
    accepted,
    rejected,
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
    operatorMode: "hosted-create-fund-reconcile",
    processedAt: new Date().toISOString(),
    processedWorkflowCount: jobs.length,
    processedWebhookCount: webhookDelivery.processedCount,
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

  const [workflowBacklogCount, webhookBacklogCount, jobs, webhooks, stateCounts, webhookStatusCounts] =
    await Promise.all([
      prisma.wireJob.count({
        where: {
          workflow: {
            AND: [
              { manualReviewRequired: false },
              { OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: new Date() } }] },
              {
                OR: [
                  { createStatus: { in: ["PENDING", "FAILED", "IN_PROGRESS"] } },
                  { fundStatus: { in: ["PENDING", "FAILED", "IN_PROGRESS"] } },
                  { confirmationStatus: { in: ["PENDING", "FAILED", "IN_PROGRESS"] } },
                  { reconcileStatus: { in: ["PENDING", "FAILED", "IN_PROGRESS"] } },
                ],
              },
            ],
          },
        },
      }),
      prisma.wireWebhookOutbox.count({
        where: {
          deliveryStatus: { in: ["PENDING", "FAILED"] },
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
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
      operatorMode: "hosted-create-fund-reconcile",
      contractSurface: {
        repository: GHOSTWIRE_ERC8183_PINNED_REPOSITORY,
        contract: GHOSTWIRE_ERC8183_PINNED_CONTRACT,
        commit: GHOSTWIRE_ERC8183_PINNED_COMMIT,
      },
      chains: {
        mainnet: {
          chainId: GHOSTWIRE_SUPPORTED_MAINNET_CHAIN_ID,
          minConfirmations: GHOSTWIRE_MIN_CONFIRMATIONS_MAINNET,
          contractAddress: resolveGhostWireContractAddress(GHOSTWIRE_SUPPORTED_MAINNET_CHAIN_ID),
          rpcUrl: resolveGhostWireRpcUrl(GHOSTWIRE_SUPPORTED_MAINNET_CHAIN_ID),
        },
        testnet: {
          chainId: GHOSTWIRE_SUPPORTED_TESTNET_CHAIN_ID,
          minConfirmations: GHOSTWIRE_MIN_CONFIRMATIONS_TESTNET,
          contractAddress: resolveGhostWireContractAddress(GHOSTWIRE_SUPPORTED_TESTNET_CHAIN_ID),
          rpcUrl: resolveGhostWireRpcUrl(GHOSTWIRE_SUPPORTED_TESTNET_CHAIN_ID),
        },
      },
      operatorAddress: getGhostWireOperatorAccount()?.address ?? null,
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
        fundTxHash: job.fundTxHash,
        jobExpiresAt: job.jobExpiresAt.toISOString(),
        createdAt: job.createdAt.toISOString(),
        updatedAt: job.updatedAt.toISOString(),
        operator: {
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

export const markGhostWireWebhookDeliveryStatus = async (input: {
  eventId: string;
  deliveryStatus: WireWebhookDeliveryStatus;
  lastError?: string | null;
  deliveredAt?: Date | null;
  nextAttemptAt?: Date | null;
  incrementAttemptCount?: boolean;
}) =>
  updateWireWebhookOutboxDelivery({
    eventId: input.eventId,
    deliveryStatus: input.deliveryStatus,
    lastError: input.lastError,
    deliveredAt: input.deliveredAt,
    nextAttemptAt: input.nextAttemptAt,
    incrementAttemptCount: input.incrementAttemptCount,
  });
