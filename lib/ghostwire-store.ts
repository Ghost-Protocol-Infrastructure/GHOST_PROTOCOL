import { randomUUID } from "node:crypto";
import {
  Prisma,
  type WireContractState,
  type WireOperatorActionType,
  type WireTerminalDisposition,
  type WireWebhookDeliveryStatus,
  type WireWorkflowStatus,
} from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  estimateGhostWireReserveUsdcMicro,
  GHOSTWIRE_JOB_EXPIRY_SECONDS,
  GHOSTWIRE_PROTOCOL_FEE_BPS,
  GHOSTWIRE_QUOTE_TTL_SECONDS,
  GHOSTWIRE_SUPPORTED_RESERVE_ASSET,
  GHOSTWIRE_SUPPORTED_SETTLEMENT_ASSET,
  resolveGhostWireContractBudgetAmount,
  resolveGhostWireMinConfirmations,
  resolveGhostWireNetworkReserveWei,
  type GhostWireSupportedChainId,
} from "@/lib/ghostwire-config";

const buildGhostWireId = (prefix: "wq" | "wj"): string => `${prefix}_${randomUUID().replace(/-/g, "")}`;
const buildWireOpenEventId = (jobId: string): string => `wire_job_open:${jobId}`;
const buildWireOpenWebhookEventId = (jobId: string): string => `wire_job_open_webhook:${jobId}`;
const buildWireFundedEventId = (jobId: string, txHash: string): string => `wire_job_funded:${jobId}:${txHash.toLowerCase()}`;
const buildWireFundedWebhookEventId = (jobId: string, txHash: string): string =>
  `wire_job_funded_webhook:${jobId}:${txHash.toLowerCase()}`;
const buildWireSubmittedEventId = (jobId: string, txHash?: string | null): string =>
  txHash ? `wire_job_submitted:${jobId}:${txHash.toLowerCase()}` : `wire_job_submitted:${jobId}`;
const buildWireSubmittedWebhookEventId = (jobId: string, txHash?: string | null): string =>
  txHash ? `wire_job_submitted_webhook:${jobId}:${txHash.toLowerCase()}` : `wire_job_submitted_webhook:${jobId}`;
const buildWireTerminalEventId = (jobId: string, state: WireTerminalDisposition, txHash?: string | null): string =>
  txHash ? `wire_job_terminal:${jobId}:${state}:${txHash.toLowerCase()}` : `wire_job_terminal:${jobId}:${state}`;
const buildWireTerminalWebhookEventId = (
  jobId: string,
  state: WireTerminalDisposition,
  txHash?: string | null,
): string =>
  txHash
    ? `wire_job_terminal_webhook:${jobId}:${state}:${txHash.toLowerCase()}`
    : `wire_job_terminal_webhook:${jobId}:${state}`;

const calculateProtocolFeeAmount = (principalAmount: bigint): bigint =>
  (principalAmount * BigInt(GHOSTWIRE_PROTOCOL_FEE_BPS)) / 10_000n;

const sumOperatorSpend = (
  rows: Array<{
    nativeAmountSpent: bigint;
  }>,
): bigint => rows.reduce((sum, row) => sum + row.nativeAmountSpent, 0n);

export class WireQuoteNotFoundError extends Error {
  constructor() {
    super("Wire quote not found.");
    this.name = "WireQuoteNotFoundError";
  }
}

export class WireQuoteExpiredError extends Error {
  constructor() {
    super("Wire quote expired.");
    this.name = "WireQuoteExpiredError";
  }
}

export class WireQuoteConsumedError extends Error {
  constructor() {
    super("Wire quote already consumed.");
    this.name = "WireQuoteConsumedError";
  }
}

export class WireQuoteMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WireQuoteMismatchError";
  }
}

export class WireJobNotFoundError extends Error {
  constructor() {
    super("Wire job not found.");
    this.name = "WireJobNotFoundError";
  }
}

export class WireJobExecutionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WireJobExecutionConflictError";
  }
}

export const createWireQuote = async (input: {
  clientAddress?: string | null;
  providerAddress: string;
  providerAgentId?: string | null;
  providerServiceSlug?: string | null;
  evaluatorAddress: string;
  chainId: GhostWireSupportedChainId;
  principalAmount: bigint;
  ttlSeconds?: number;
}): Promise<{
  id: string;
  quoteId: string;
  expiresAt: string;
  pricing: {
    principal: { asset: "USDC"; amount: string; decimals: 6 };
    protocolFee: { asset: "USDC"; amount: string; decimals: 6; bps: number };
    networkReserve: { asset: "ETH"; amount: string; decimals: 18; chainId: GhostWireSupportedChainId };
    display: {
      networkReserveSettlementAssetEstimate: {
        asset: "USDC";
        amount: string;
        decimals: 6;
      } | null;
    };
  };
  confirmations: {
    min: number;
  };
}> => {
  const quoteId = buildGhostWireId("wq");
  const now = new Date();
  const ttlSeconds = input.ttlSeconds ?? GHOSTWIRE_QUOTE_TTL_SECONDS;
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
  const protocolFeeAmount = calculateProtocolFeeAmount(input.principalAmount);
  const networkReserveAmount = resolveGhostWireNetworkReserveWei(input.chainId);
  const displayReserveEstimateAmount = estimateGhostWireReserveUsdcMicro(networkReserveAmount);

  const record = await prisma.wireQuote.create({
    data: {
      quoteId,
      clientAddress: input.clientAddress ?? null,
      providerAddress: input.providerAddress,
      providerAgentId: input.providerAgentId ?? null,
      providerServiceSlug: input.providerServiceSlug ?? null,
      evaluatorAddress: input.evaluatorAddress,
      chainId: input.chainId,
      settlementAsset: GHOSTWIRE_SUPPORTED_SETTLEMENT_ASSET,
      principalAmount: input.principalAmount,
      protocolFeeAmount,
      networkReserveAmount,
      networkReserveAsset: GHOSTWIRE_SUPPORTED_RESERVE_ASSET,
      networkReserveDecimals: 18,
      displayReserveEstimateAmount,
      displayReserveEstimateAsset: displayReserveEstimateAmount != null ? GHOSTWIRE_SUPPORTED_SETTLEMENT_ASSET : null,
      ttlSeconds,
      expiresAt,
    },
    select: {
      id: true,
      quoteId: true,
      chainId: true,
      expiresAt: true,
      principalAmount: true,
      protocolFeeAmount: true,
      networkReserveAmount: true,
      displayReserveEstimateAmount: true,
    },
  });

  return {
    id: record.id,
    quoteId: record.quoteId,
    expiresAt: record.expiresAt.toISOString(),
    pricing: {
      principal: {
        asset: GHOSTWIRE_SUPPORTED_SETTLEMENT_ASSET,
        amount: record.principalAmount.toString(),
        decimals: 6,
      },
      protocolFee: {
        asset: GHOSTWIRE_SUPPORTED_SETTLEMENT_ASSET,
        amount: record.protocolFeeAmount.toString(),
        decimals: 6,
        bps: GHOSTWIRE_PROTOCOL_FEE_BPS,
      },
      networkReserve: {
        asset: GHOSTWIRE_SUPPORTED_RESERVE_ASSET,
        amount: record.networkReserveAmount.toString(),
        decimals: 18,
        chainId: record.chainId as GhostWireSupportedChainId,
      },
      display: {
        networkReserveSettlementAssetEstimate:
          record.displayReserveEstimateAmount == null
            ? null
            : {
                asset: GHOSTWIRE_SUPPORTED_SETTLEMENT_ASSET,
                amount: record.displayReserveEstimateAmount.toString(),
                decimals: 6,
              },
      },
    },
    confirmations: {
      min: resolveGhostWireMinConfirmations(record.chainId as GhostWireSupportedChainId),
    },
  };
};

const buildWirePricingPayload = (job: {
  chainId: number;
  principalAmount: bigint;
  protocolFeeAmount: bigint;
  networkReserveAmount: bigint;
}): {
  principal: { asset: "USDC"; amount: string; decimals: 6 };
  protocolFee: { asset: "USDC"; amount: string; decimals: 6; bps: number };
  networkReserve: { asset: "ETH"; amount: string; decimals: 18; chainId: number };
} => ({
  principal: {
    asset: GHOSTWIRE_SUPPORTED_SETTLEMENT_ASSET,
    amount: job.principalAmount.toString(),
    decimals: 6,
  },
  protocolFee: {
    asset: GHOSTWIRE_SUPPORTED_SETTLEMENT_ASSET,
    amount: job.protocolFeeAmount.toString(),
    decimals: 6,
    bps: GHOSTWIRE_PROTOCOL_FEE_BPS,
  },
  networkReserve: {
    asset: GHOSTWIRE_SUPPORTED_RESERVE_ASSET,
    amount: job.networkReserveAmount.toString(),
    decimals: 18,
    chainId: job.chainId,
  },
});

const deriveTerminalSettlement = (input: {
  contractState: WireContractState;
  terminalDisposition: "COMPLETED" | "REJECTED" | "EXPIRED" | null;
  principalAmount: bigint;
  protocolFeeAmount: bigint;
  networkReserveAmount: bigint;
  operatorSpends: Array<{ nativeAmountSpent: bigint }>;
}) => {
  if (
    input.contractState !== "COMPLETED" &&
    input.contractState !== "REJECTED" &&
    input.contractState !== "EXPIRED"
  ) {
    return null;
  }

  const actualNetworkSpend = sumOperatorSpend(input.operatorSpends);
  const unusedNetworkReserveRefund =
    actualNetworkSpend >= input.networkReserveAmount ? 0n : input.networkReserveAmount - actualNetworkSpend;
  const isCompleted = input.terminalDisposition === "COMPLETED";
  const providerPayoutAmount = isCompleted
    ? input.principalAmount > input.protocolFeeAmount
      ? input.principalAmount - input.protocolFeeAmount
      : 0n
    : 0n;

  return {
    providerPayout: {
      asset: GHOSTWIRE_SUPPORTED_SETTLEMENT_ASSET,
      amount: providerPayoutAmount.toString(),
      decimals: 6,
    },
    protocolRevenue: {
      asset: GHOSTWIRE_SUPPORTED_SETTLEMENT_ASSET,
      amount: isCompleted ? input.protocolFeeAmount.toString() : "0",
      decimals: 6,
    },
    actualNetworkSpend: {
      asset: GHOSTWIRE_SUPPORTED_RESERVE_ASSET,
      amount: actualNetworkSpend.toString(),
      decimals: 18,
    },
    unusedNetworkReserveRefund: {
      asset: GHOSTWIRE_SUPPORTED_RESERVE_ASSET,
      amount: unusedNetworkReserveRefund.toString(),
      decimals: 18,
    },
  };
};

const buildOpenWebhookPayload = (job: {
  jobId: string;
  quoteId: string;
  chainId: number;
  contractState: WireContractState;
  publicState: WireContractState;
  principalAmount: bigint;
  protocolFeeAmount: bigint;
  networkReserveAmount: bigint;
  createdAt: Date;
}) => ({
  jobId: job.jobId,
  quoteId: job.quoteId,
  state: job.publicState,
  contractState: job.contractState,
  createdAt: job.createdAt.toISOString(),
  pricing: buildWirePricingPayload(job),
});

const buildFundedWebhookPayload = (job: {
  jobId: string;
  quoteId: string;
  chainId: number;
  contractAddress: string | null;
  contractJobId: string | null;
  contractState: WireContractState;
  publicState: WireContractState;
  principalAmount: bigint;
  protocolFeeAmount: bigint;
  networkReserveAmount: bigint;
  createTxHash: string | null;
  fundTxHash: string | null;
  updatedAt: Date;
}) => ({
  jobId: job.jobId,
  quoteId: job.quoteId,
  state: job.publicState,
  contractState: job.contractState,
  contractAddress: job.contractAddress,
  contractJobId: job.contractJobId,
  createTxHash: job.createTxHash,
  fundTxHash: job.fundTxHash,
  observedAt: job.updatedAt.toISOString(),
  pricing: buildWirePricingPayload(job),
});

const buildSubmittedWebhookPayload = (job: {
  jobId: string;
  quoteId: string;
  chainId: number;
  contractAddress: string | null;
  contractJobId: string | null;
  contractState: WireContractState;
  publicState: WireContractState;
  fundTxHash: string | null;
  updatedAt: Date;
  principalAmount: bigint;
  protocolFeeAmount: bigint;
  networkReserveAmount: bigint;
}) => ({
  jobId: job.jobId,
  quoteId: job.quoteId,
  state: job.publicState,
  contractState: job.contractState,
  contractAddress: job.contractAddress,
  contractJobId: job.contractJobId,
  fundTxHash: job.fundTxHash,
  observedAt: job.updatedAt.toISOString(),
  pricing: buildWirePricingPayload(job),
});

const buildTerminalWebhookPayload = (job: {
  jobId: string;
  quoteId: string;
  chainId: number;
  contractAddress: string | null;
  contractJobId: string | null;
  contractState: WireContractState;
  publicState: WireContractState;
  terminalDisposition: WireTerminalDisposition | null;
  terminalTxHash: string | null;
  updatedAt: Date;
  principalAmount: bigint;
  protocolFeeAmount: bigint;
  networkReserveAmount: bigint;
  operatorSpends: Array<{ nativeAmountSpent: bigint }>;
}) => ({
  jobId: job.jobId,
  quoteId: job.quoteId,
  state: job.publicState,
  contractState: job.contractState,
  contractAddress: job.contractAddress,
  contractJobId: job.contractJobId,
  terminalDisposition: job.terminalDisposition,
  terminalTxHash: job.terminalTxHash,
  observedAt: job.updatedAt.toISOString(),
  pricing: buildWirePricingPayload(job),
  settlement: deriveTerminalSettlement({
    contractState: job.contractState,
    terminalDisposition: job.terminalDisposition,
    principalAmount: job.principalAmount,
    protocolFeeAmount: job.protocolFeeAmount,
    networkReserveAmount: job.networkReserveAmount,
    operatorSpends: job.operatorSpends,
  }),
});

const hasWireWebhookTarget = (job: {
  webhookTargetUrl?: string | null;
  webhookSecret?: string | null;
}): boolean => Boolean(job.webhookTargetUrl && job.webhookSecret);

export const createWireJobFromQuote = async (input: {
  quoteId: string;
  clientAddress: string;
  providerAddress: string;
  providerAgentId?: string | null;
  providerServiceSlug?: string | null;
  evaluatorAddress: string;
  specHash: `0x${string}`;
  metadataUri?: string | null;
  webhookTargetUrl?: string | null;
  webhookSecret?: string | null;
}): Promise<{
  id: string;
  jobId: string;
  quoteId: string;
  chainId: number;
  state: WireContractState;
  contractState: WireContractState;
  pricing: ReturnType<typeof buildWirePricingPayload>;
  operator: {
    createStatus: WireWorkflowStatus;
    fundStatus: WireWorkflowStatus;
    confirmationStatus: WireWorkflowStatus;
    reconcileStatus: WireWorkflowStatus;
  };
}> =>
  prisma.$transaction(async (tx) => {
    const quote = await tx.wireQuote.findUnique({
      where: { quoteId: input.quoteId },
    });
    if (!quote) throw new WireQuoteNotFoundError();
    if (quote.expiresAt <= new Date()) throw new WireQuoteExpiredError();
    if (quote.consumedAt) throw new WireQuoteConsumedError();
    if (quote.clientAddress && quote.clientAddress !== input.clientAddress) {
      throw new WireQuoteMismatchError("Quote client address does not match create request.");
    }
    if (quote.providerAddress !== input.providerAddress) {
      throw new WireQuoteMismatchError("Quote provider address does not match create request.");
    }
    if (
      quote.providerAgentId &&
      input.providerAgentId &&
      quote.providerAgentId !== input.providerAgentId
    ) {
      throw new WireQuoteMismatchError("Quote provider agent attribution does not match create request.");
    }
    if (
      quote.providerServiceSlug &&
      input.providerServiceSlug &&
      quote.providerServiceSlug !== input.providerServiceSlug
    ) {
      throw new WireQuoteMismatchError("Quote provider service attribution does not match create request.");
    }
    if (quote.evaluatorAddress !== input.evaluatorAddress) {
      throw new WireQuoteMismatchError("Quote evaluator address does not match create request.");
    }

    const consumedAt = new Date();
    const jobExpiresAt = new Date(consumedAt.getTime() + GHOSTWIRE_JOB_EXPIRY_SECONDS * 1000);
    const jobId = buildGhostWireId("wj");
    const eventId = buildWireOpenEventId(jobId);
    const webhookEventId = buildWireOpenWebhookEventId(jobId);
    const contractBudgetAmount = resolveGhostWireContractBudgetAmount(quote.principalAmount);

    const providerAgentId = quote.providerAgentId ?? input.providerAgentId ?? null;
    const providerServiceSlug = quote.providerServiceSlug ?? input.providerServiceSlug ?? null;

    const job = await tx.wireJob.create({
      data: {
        jobId,
        quoteId: quote.quoteId,
        chainId: quote.chainId,
        jobExpiresAt,
        clientAddress: input.clientAddress,
        providerAddress: input.providerAddress,
        providerAgentId,
        providerServiceSlug,
        evaluatorAddress: input.evaluatorAddress,
        contractBudgetAmount,
        settlementAsset: quote.settlementAsset,
        principalAmount: quote.principalAmount,
        protocolFeeAmount: quote.protocolFeeAmount,
        networkReserveAmount: quote.networkReserveAmount,
        networkReserveAsset: quote.networkReserveAsset,
        specHash: input.specHash,
        metadataUri: input.metadataUri ?? null,
        webhookTargetUrl: input.webhookTargetUrl ?? null,
        webhookSecret: input.webhookSecret ?? null,
        contractState: "OPEN",
        publicState: "OPEN",
        workflow: {
          create: {
            createStatus: "PENDING",
            fundStatus: "PENDING",
            confirmationStatus: "PENDING",
            reconcileStatus: "PENDING",
            manualReviewRequired: false,
            manualReviewReason: null,
          },
        },
      },
      include: {
        workflow: true,
      },
    });

    await tx.wireQuote.update({
      where: { quoteId: quote.quoteId },
      data: {
        consumedAt,
        clientAddress: input.clientAddress,
        providerAgentId,
        providerServiceSlug,
      },
    });

    await tx.wireJobTransition.create({
      data: {
        wireJobId: job.id,
        eventId,
        fromState: null,
        toState: "OPEN",
        observedAt: consumedAt,
        confirmedAt: consumedAt,
        confirmationsAtObservation: 0,
      },
    });

    if (hasWireWebhookTarget(job)) {
      await tx.wireWebhookOutbox.create({
        data: {
          eventId: webhookEventId,
          wireJobId: job.id,
          eventType: "wire.job.open",
          state: "OPEN",
          contractState: "OPEN",
          payloadJson: buildOpenWebhookPayload(job) as Prisma.InputJsonValue,
        },
      });
    }

    return {
      id: job.id,
      jobId: job.jobId,
      quoteId: job.quoteId,
      chainId: job.chainId,
      state: job.publicState,
      contractState: job.contractState,
      pricing: buildWirePricingPayload(job),
      operator: {
        createStatus: job.workflow?.createStatus ?? "PENDING",
        fundStatus: job.workflow?.fundStatus ?? "PENDING",
        confirmationStatus: job.workflow?.confirmationStatus ?? "PENDING",
        reconcileStatus: job.workflow?.reconcileStatus ?? "PENDING",
      },
    };
  });

export const getWireJobById = async (jobId: string): Promise<{
  id: string;
  jobId: string;
  quoteId: string;
  chainId: number;
  jobExpiresAt: string;
  state: WireContractState;
  contractState: WireContractState;
  terminalDisposition: string | null;
  clientAddress: string;
  providerAddress: string;
  providerAgentId: string | null;
  providerServiceSlug: string | null;
  evaluatorAddress: string;
  specHash: string;
  metadataUri: string | null;
  contractAddress: string | null;
  contractJobId: string | null;
  createTxHash: string | null;
  fundTxHash: string | null;
  terminalTxHash: string | null;
  createdAt: string;
  updatedAt: string;
  pricing: ReturnType<typeof buildWirePricingPayload>;
  operator: {
    createStatus: WireWorkflowStatus | null;
    fundStatus: WireWorkflowStatus | null;
    confirmationStatus: WireWorkflowStatus | null;
    reconcileStatus: WireWorkflowStatus | null;
    retryCount: number | null;
    nextRetryAt: string | null;
    lastError: string | null;
    manualReviewRequired: boolean | null;
    manualReviewReason: string | null;
  };
  settlement: ReturnType<typeof deriveTerminalSettlement>;
}> => {
  const job = await prisma.wireJob.findUnique({
    where: { jobId },
    include: {
      workflow: true,
      operatorSpends: {
        select: {
          nativeAmountSpent: true,
        },
      },
    },
  });
  if (!job) throw new WireJobNotFoundError();

  return {
    id: job.id,
    jobId: job.jobId,
    quoteId: job.quoteId,
    chainId: job.chainId,
    jobExpiresAt: job.jobExpiresAt.toISOString(),
    state: job.publicState,
    contractState: job.contractState,
    terminalDisposition: job.terminalDisposition,
    clientAddress: job.clientAddress,
    providerAddress: job.providerAddress,
    providerAgentId: job.providerAgentId,
    providerServiceSlug: job.providerServiceSlug,
    evaluatorAddress: job.evaluatorAddress,
    specHash: job.specHash,
    metadataUri: job.metadataUri,
    contractAddress: job.contractAddress,
    contractJobId: job.contractJobId,
    createTxHash: job.createTxHash,
    fundTxHash: job.fundTxHash,
    terminalTxHash: job.terminalTxHash,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    pricing: buildWirePricingPayload(job),
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
    settlement: deriveTerminalSettlement({
      contractState: job.contractState,
      terminalDisposition: job.terminalDisposition,
      principalAmount: job.principalAmount,
      protocolFeeAmount: job.protocolFeeAmount,
      networkReserveAmount: job.networkReserveAmount,
      operatorSpends: job.operatorSpends,
    }),
  };
};

const buildWireOperatorWorkWhere = (now: Date): Prisma.WireJobWhereInput => ({
  workflow: {
    AND: [
      { manualReviewRequired: false },
      {
        OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
      },
    ],
  },
  OR: [
    {
      workflow: {
        OR: [
          { createStatus: { in: ["PENDING", "FAILED", "IN_PROGRESS"] } },
          { fundStatus: { in: ["PENDING", "FAILED", "IN_PROGRESS"] } },
          { confirmationStatus: { in: ["PENDING", "FAILED", "IN_PROGRESS"] } },
          { reconcileStatus: { in: ["PENDING", "FAILED", "IN_PROGRESS"] } },
        ],
      },
    },
    {
      publicState: { in: ["FUNDED", "SUBMITTED"] },
    },
  ],
});

export const listWireJobsNeedingOperatorWork = async (limit: number) =>
  prisma.wireJob.findMany({
    where: buildWireOperatorWorkWhere(new Date()),
    orderBy: { createdAt: "asc" },
    take: limit,
    select: {
      id: true,
      jobId: true,
      quoteId: true,
      chainId: true,
      jobExpiresAt: true,
      publicState: true,
      contractState: true,
      contractAddress: true,
      contractJobId: true,
      contractBudgetAmount: true,
      createTxHash: true,
      fundTxHash: true,
      terminalTxHash: true,
      clientAddress: true,
      providerAddress: true,
      providerAgentId: true,
      providerServiceSlug: true,
      evaluatorAddress: true,
      specHash: true,
      metadataUri: true,
      createdAt: true,
      updatedAt: true,
      workflow: {
        select: {
          createStatus: true,
          fundStatus: true,
          confirmationStatus: true,
          reconcileStatus: true,
          retryCount: true,
          nextRetryAt: true,
          lastError: true,
          manualReviewRequired: true,
          manualReviewReason: true,
        },
      },
    },
  });

export const countWireJobsNeedingOperatorWork = async () => prisma.wireJob.count({ where: buildWireOperatorWorkWhere(new Date()) });

export const listPendingWireWebhookOutboxEvents = async (limit: number) =>
  prisma.wireWebhookOutbox.findMany({
    where: {
      deliveryStatus: { in: ["PENDING", "FAILED"] },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
    },
    orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
    take: limit,
    include: {
      wireJob: {
        select: {
          jobId: true,
          webhookTargetUrl: true,
          webhookSecret: true,
        },
      },
    },
  });

const buildWireOperatorPayload = (workflow: {
  createStatus: WireWorkflowStatus | null;
  fundStatus: WireWorkflowStatus | null;
  confirmationStatus: WireWorkflowStatus | null;
  reconcileStatus: WireWorkflowStatus | null;
  retryCount: number | null;
  nextRetryAt: Date | null;
  lastError: string | null;
  manualReviewRequired: boolean | null;
  manualReviewReason: string | null;
}) => ({
  createStatus: workflow.createStatus,
  fundStatus: workflow.fundStatus,
  confirmationStatus: workflow.confirmationStatus,
  reconcileStatus: workflow.reconcileStatus,
  retryCount: workflow.retryCount,
  nextRetryAt: workflow.nextRetryAt?.toISOString() ?? null,
  lastError: workflow.lastError,
  manualReviewRequired: workflow.manualReviewRequired,
  manualReviewReason: workflow.manualReviewReason,
});

export const listWireJobs = async (input: {
  limit: number;
  cursor?: string | null;
  participantAddress?: string | null;
  state?: WireContractState | null;
}): Promise<{
  items: Array<{
    id: string;
    jobId: string;
    quoteId: string;
    chainId: number;
    jobExpiresAt: string;
    state: WireContractState;
    contractState: WireContractState;
    terminalDisposition: string | null;
    clientAddress: string;
    providerAddress: string;
    providerAgentId: string | null;
    providerServiceSlug: string | null;
    evaluatorAddress: string;
    contractAddress: string | null;
    contractJobId: string | null;
    createTxHash: string | null;
    fundTxHash: string | null;
    terminalTxHash: string | null;
    metadataUri: string | null;
    createdAt: string;
    updatedAt: string;
    pricing: ReturnType<typeof buildWirePricingPayload>;
    operator: ReturnType<typeof buildWireOperatorPayload>;
  }>;
  nextCursor: string | null;
}> => {
  const safeLimit = Math.max(1, Math.min(input.limit, 100));
  const jobs = await prisma.wireJob.findMany({
    where: {
      ...(input.state ? { publicState: input.state } : {}),
      ...(input.participantAddress
        ? {
            OR: [
              { clientAddress: input.participantAddress },
              { providerAddress: input.participantAddress },
              { evaluatorAddress: input.participantAddress },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { jobId: "desc" }],
    take: safeLimit + 1,
    ...(input.cursor ? { cursor: { jobId: input.cursor }, skip: 1 } : {}),
    include: {
      workflow: true,
    },
  });

  const hasNextPage = jobs.length > safeLimit;
  const page = hasNextPage ? jobs.slice(0, safeLimit) : jobs;

  return {
    items: page.map((job) => ({
      id: job.id,
      jobId: job.jobId,
      quoteId: job.quoteId,
      chainId: job.chainId,
      jobExpiresAt: job.jobExpiresAt.toISOString(),
      state: job.publicState,
      contractState: job.contractState,
      terminalDisposition: job.terminalDisposition,
      clientAddress: job.clientAddress,
      providerAddress: job.providerAddress,
      providerAgentId: job.providerAgentId,
      providerServiceSlug: job.providerServiceSlug,
      evaluatorAddress: job.evaluatorAddress,
      contractAddress: job.contractAddress,
      contractJobId: job.contractJobId,
      createTxHash: job.createTxHash,
      fundTxHash: job.fundTxHash,
      terminalTxHash: job.terminalTxHash,
      metadataUri: job.metadataUri,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
      pricing: buildWirePricingPayload(job),
      operator: buildWireOperatorPayload({
        createStatus: job.workflow?.createStatus ?? null,
        fundStatus: job.workflow?.fundStatus ?? null,
        confirmationStatus: job.workflow?.confirmationStatus ?? null,
        reconcileStatus: job.workflow?.reconcileStatus ?? null,
        retryCount: job.workflow?.retryCount ?? null,
        nextRetryAt: job.workflow?.nextRetryAt ?? null,
        lastError: job.workflow?.lastError ?? null,
        manualReviewRequired: job.workflow?.manualReviewRequired ?? null,
        manualReviewReason: job.workflow?.manualReviewReason ?? null,
      }),
    })),
    nextCursor: hasNextPage ? page.at(-1)?.jobId ?? null : null,
  };
};

export const updateWireWebhookOutboxDelivery = async (input: {
  eventId: string;
  deliveryStatus: WireWebhookDeliveryStatus;
  lastError?: string | null;
  deliveredAt?: Date | null;
  nextAttemptAt?: Date | null;
  incrementAttemptCount?: boolean;
}) =>
  prisma.wireWebhookOutbox.update({
    where: { eventId: input.eventId },
    data: {
      deliveryStatus: input.deliveryStatus,
      lastError: input.lastError ?? null,
      deliveredAt: input.deliveredAt ?? null,
      nextAttemptAt: input.nextAttemptAt ?? null,
      lastAttemptAt: new Date(),
      attemptCount: input.incrementAttemptCount ? { increment: 1 } : undefined,
    },
  });

export const markWireJobForManualReview = async (input: {
  jobId: string;
  stage: "create" | "fund" | "confirmation" | "reconcile";
  reason: string;
}) =>
  prisma.wireJobWorkflow.update({
    where: { wireJobId: input.jobId },
    data: {
      createStatus: input.stage === "create" ? "FAILED" : undefined,
      fundStatus: input.stage === "fund" ? "FAILED" : undefined,
      confirmationStatus: input.stage === "confirmation" ? "FAILED" : undefined,
      reconcileStatus: input.stage === "reconcile" ? "FAILED" : undefined,
      manualReviewRequired: true,
      manualReviewReason: input.reason,
      lastError: input.reason,
      nextRetryAt: null,
      lastAttemptAt: new Date(),
    },
    select: {
      createStatus: true,
      fundStatus: true,
      confirmationStatus: true,
      reconcileStatus: true,
      manualReviewRequired: true,
      manualReviewReason: true,
      lastError: true,
    },
  });

export const recordWireJobExecutionArtifacts = async (input: {
  jobId: string;
  contractAddress?: string | null;
  contractJobId?: string | null;
  createTxHash?: string | null;
  fundTxHash?: string | null;
}) =>
  prisma.$transaction(async (tx) => {
    const job = await tx.wireJob.findUnique({
      where: { jobId: input.jobId },
      include: { workflow: true },
    });
    if (!job) throw new WireJobNotFoundError();

    const nextContractAddress = input.contractAddress ?? job.contractAddress;
    const nextContractJobId = input.contractJobId ?? job.contractJobId;
    const nextCreateTxHash = input.createTxHash ?? job.createTxHash;
    const nextFundTxHash = input.fundTxHash ?? job.fundTxHash;

    if (job.contractAddress && input.contractAddress && job.contractAddress.toLowerCase() !== input.contractAddress.toLowerCase()) {
      throw new WireJobExecutionConflictError("Wire job contract address conflicts with existing execution record.");
    }
    if (job.contractJobId && input.contractJobId && job.contractJobId !== input.contractJobId) {
      throw new WireJobExecutionConflictError("Wire job contract identifier conflicts with existing execution record.");
    }
    if (job.createTxHash && input.createTxHash && job.createTxHash.toLowerCase() !== input.createTxHash.toLowerCase()) {
      throw new WireJobExecutionConflictError("Wire job create transaction hash conflicts with existing execution record.");
    }
    if (job.fundTxHash && input.fundTxHash && job.fundTxHash.toLowerCase() !== input.fundTxHash.toLowerCase()) {
      throw new WireJobExecutionConflictError("Wire job fund transaction hash conflicts with existing execution record.");
    }

    const workflow = await tx.wireJobWorkflow.update({
      where: { wireJobId: job.id },
      data: {
        createStatus:
          nextContractAddress && nextContractJobId && nextCreateTxHash
            ? job.workflow?.createStatus === "SUCCEEDED"
              ? "SUCCEEDED"
              : "IN_PROGRESS"
            : job.workflow?.createStatus ?? "PENDING",
        fundStatus:
          nextFundTxHash
            ? job.workflow?.fundStatus === "SUCCEEDED"
              ? "SUCCEEDED"
              : "IN_PROGRESS"
            : job.workflow?.fundStatus ?? "PENDING",
        confirmationStatus:
          nextFundTxHash
            ? job.workflow?.confirmationStatus === "SUCCEEDED"
              ? "SUCCEEDED"
              : "IN_PROGRESS"
            : job.workflow?.confirmationStatus ?? "PENDING",
        reconcileStatus:
          nextFundTxHash
            ? job.workflow?.reconcileStatus === "SUCCEEDED"
              ? "SUCCEEDED"
              : "PENDING"
            : job.workflow?.reconcileStatus ?? "PENDING",
        lastError: null,
        nextRetryAt: null,
        lastAttemptAt: new Date(),
        manualReviewRequired: false,
        manualReviewReason: null,
      },
      select: {
        createStatus: true,
        fundStatus: true,
        confirmationStatus: true,
        reconcileStatus: true,
        manualReviewRequired: true,
        manualReviewReason: true,
      },
    });

    const updatedJob = await tx.wireJob.update({
      where: { id: job.id },
      data: {
        contractAddress: nextContractAddress,
        contractJobId: nextContractJobId,
        createTxHash: nextCreateTxHash,
        fundTxHash: nextFundTxHash,
      },
      select: {
        id: true,
        jobId: true,
        quoteId: true,
        chainId: true,
        contractAddress: true,
        contractJobId: true,
        createTxHash: true,
        fundTxHash: true,
        publicState: true,
        contractState: true,
      },
    });

    return {
      ...updatedJob,
      operator: workflow,
    };
  });

export const recordWireJobTerminalArtifacts = async (input: {
  jobId: string;
  terminalTxHash: string;
}) =>
  prisma.$transaction(async (tx) => {
    const job = await tx.wireJob.findUnique({
      where: { jobId: input.jobId },
      include: { workflow: true },
    });
    if (!job) throw new WireJobNotFoundError();

    if (job.terminalTxHash && job.terminalTxHash.toLowerCase() !== input.terminalTxHash.toLowerCase()) {
      throw new WireJobExecutionConflictError("Wire job terminal transaction hash conflicts with existing execution record.");
    }

    const workflow = await tx.wireJobWorkflow.update({
      where: { wireJobId: job.id },
      data: {
        confirmationStatus: job.workflow?.confirmationStatus === "SUCCEEDED" ? "IN_PROGRESS" : "IN_PROGRESS",
        reconcileStatus: "PENDING",
        lastError: null,
        nextRetryAt: null,
        lastAttemptAt: new Date(),
        manualReviewRequired: false,
        manualReviewReason: null,
      },
      select: {
        createStatus: true,
        fundStatus: true,
        confirmationStatus: true,
        reconcileStatus: true,
        manualReviewRequired: true,
        manualReviewReason: true,
      },
    });

    const updatedJob = await tx.wireJob.update({
      where: { id: job.id },
      data: {
        terminalTxHash: input.terminalTxHash,
      },
      select: {
        id: true,
        jobId: true,
        quoteId: true,
        chainId: true,
        contractAddress: true,
        contractJobId: true,
        createTxHash: true,
        fundTxHash: true,
        terminalTxHash: true,
        publicState: true,
        contractState: true,
      },
    });

    return {
      ...updatedJob,
      operator: workflow,
    };
  });

export const upsertWireOperatorSpend = async (input: {
  wireJobId: string;
  actionType: WireOperatorActionType;
  txHash: string;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  nativeAmountSpent: bigint;
}) =>
  prisma.wireOperatorSpend.upsert({
    where: { txHash: input.txHash },
    update: {
      actionType: input.actionType,
      gasUsed: input.gasUsed,
      effectiveGasPrice: input.effectiveGasPrice,
      nativeAmountSpent: input.nativeAmountSpent,
    },
    create: {
      wireJobId: input.wireJobId,
      actionType: input.actionType,
      txHash: input.txHash,
      nativeAsset: GHOSTWIRE_SUPPORTED_RESERVE_ASSET,
      gasUsed: input.gasUsed,
      effectiveGasPrice: input.effectiveGasPrice,
      nativeAmountSpent: input.nativeAmountSpent,
    },
  });

export const reconcileWireJobSubmittedState = async (input: {
  jobId: string;
  submitTxHash?: string | null;
  confirmedAt: Date;
  blockNumber: bigint;
  confirmations: number;
  logIndex?: number | null;
}) =>
  prisma.$transaction(async (tx) => {
    const job = await tx.wireJob.findUnique({
      where: { jobId: input.jobId },
      include: {
        workflow: true,
      },
    });
    if (!job) throw new WireJobNotFoundError();

    const transitionEventId = buildWireSubmittedEventId(job.jobId, input.submitTxHash);
    const webhookEventId = buildWireSubmittedWebhookEventId(job.jobId, input.submitTxHash);

    const updatedJob = await tx.wireJob.update({
      where: { id: job.id },
      data: {
        contractState: "SUBMITTED",
        publicState: "SUBMITTED",
      },
      select: {
        id: true,
        jobId: true,
        quoteId: true,
        chainId: true,
        contractAddress: true,
        contractJobId: true,
        contractState: true,
        publicState: true,
        principalAmount: true,
        protocolFeeAmount: true,
        networkReserveAmount: true,
        fundTxHash: true,
        webhookTargetUrl: true,
        webhookSecret: true,
        updatedAt: true,
      },
    });

    const workflow = await tx.wireJobWorkflow.update({
      where: { wireJobId: job.id },
      data: {
        confirmationStatus: "SUCCEEDED",
        reconcileStatus: "SUCCEEDED",
        lastError: null,
        nextRetryAt: null,
        lastAttemptAt: input.confirmedAt,
        manualReviewRequired: false,
        manualReviewReason: null,
      },
      select: {
        createStatus: true,
        fundStatus: true,
        confirmationStatus: true,
        reconcileStatus: true,
        manualReviewRequired: true,
        manualReviewReason: true,
      },
    });

    await tx.wireJobTransition.upsert({
      where: { eventId: transitionEventId },
      update: {
        fromState: job.contractState,
        toState: "SUBMITTED",
        sourceTxHash: input.submitTxHash ?? null,
        sourceLogIndex: input.logIndex ?? null,
        blockNumber: input.blockNumber,
        observedAt: input.confirmedAt,
        confirmedAt: input.confirmedAt,
        confirmationsAtObservation: input.confirmations,
      },
      create: {
        wireJobId: job.id,
        eventId: transitionEventId,
        fromState: job.contractState,
        toState: "SUBMITTED",
        sourceTxHash: input.submitTxHash ?? null,
        sourceLogIndex: input.logIndex ?? null,
        blockNumber: input.blockNumber,
        observedAt: input.confirmedAt,
        confirmedAt: input.confirmedAt,
        confirmationsAtObservation: input.confirmations,
      },
    });

    if (hasWireWebhookTarget(updatedJob)) {
      await tx.wireWebhookOutbox.upsert({
        where: { eventId: webhookEventId },
        update: {
          eventType: "wire.job.submitted",
          state: "SUBMITTED",
          contractState: "SUBMITTED",
          payloadJson: buildSubmittedWebhookPayload(updatedJob) as Prisma.InputJsonValue,
        },
        create: {
          eventId: webhookEventId,
          wireJobId: job.id,
          eventType: "wire.job.submitted",
          state: "SUBMITTED",
          contractState: "SUBMITTED",
          payloadJson: buildSubmittedWebhookPayload(updatedJob) as Prisma.InputJsonValue,
        },
      });
    }

    return {
      ...updatedJob,
      operator: workflow,
    };
  });

export const reconcileWireJobTerminalState = async (input: {
  jobId: string;
  state: WireTerminalDisposition;
  terminalTxHash?: string | null;
  confirmedAt: Date;
  blockNumber: bigint;
  confirmations: number;
  logIndex?: number | null;
}) =>
  prisma.$transaction(async (tx) => {
    const job = await tx.wireJob.findUnique({
      where: { jobId: input.jobId },
      include: {
        workflow: true,
        operatorSpends: {
          select: {
            nativeAmountSpent: true,
          },
        },
      },
    });
    if (!job) throw new WireJobNotFoundError();

    const transitionEventId = buildWireTerminalEventId(job.jobId, input.state, input.terminalTxHash);
    const webhookEventId = buildWireTerminalWebhookEventId(job.jobId, input.state, input.terminalTxHash);

    const updatedJob = await tx.wireJob.update({
      where: { id: job.id },
      data: {
        contractState: input.state,
        publicState: input.state,
        terminalDisposition: input.state,
        terminalTxHash: input.terminalTxHash ?? job.terminalTxHash,
      },
      select: {
        id: true,
        jobId: true,
        quoteId: true,
        chainId: true,
        contractAddress: true,
        contractJobId: true,
        contractState: true,
        publicState: true,
        terminalDisposition: true,
        terminalTxHash: true,
        principalAmount: true,
        protocolFeeAmount: true,
        networkReserveAmount: true,
        webhookTargetUrl: true,
        webhookSecret: true,
        updatedAt: true,
      },
    });

    const workflow = await tx.wireJobWorkflow.update({
      where: { wireJobId: job.id },
      data: {
        confirmationStatus: "SUCCEEDED",
        reconcileStatus: "SUCCEEDED",
        lastError: null,
        nextRetryAt: null,
        lastAttemptAt: input.confirmedAt,
        manualReviewRequired: false,
        manualReviewReason: null,
      },
      select: {
        createStatus: true,
        fundStatus: true,
        confirmationStatus: true,
        reconcileStatus: true,
        manualReviewRequired: true,
        manualReviewReason: true,
      },
    });

    await tx.wireJobTransition.upsert({
      where: { eventId: transitionEventId },
      update: {
        fromState: job.contractState,
        toState: input.state,
        sourceTxHash: input.terminalTxHash ?? null,
        sourceLogIndex: input.logIndex ?? null,
        blockNumber: input.blockNumber,
        observedAt: input.confirmedAt,
        confirmedAt: input.confirmedAt,
        confirmationsAtObservation: input.confirmations,
      },
      create: {
        wireJobId: job.id,
        eventId: transitionEventId,
        fromState: job.contractState,
        toState: input.state,
        sourceTxHash: input.terminalTxHash ?? null,
        sourceLogIndex: input.logIndex ?? null,
        blockNumber: input.blockNumber,
        observedAt: input.confirmedAt,
        confirmedAt: input.confirmedAt,
        confirmationsAtObservation: input.confirmations,
      },
    });

    if (hasWireWebhookTarget(updatedJob)) {
      await tx.wireWebhookOutbox.upsert({
        where: { eventId: webhookEventId },
        update: {
          eventType: `wire.job.${input.state.toLowerCase()}`,
          state: input.state,
          contractState: input.state,
          payloadJson: buildTerminalWebhookPayload({
            ...updatedJob,
            operatorSpends: job.operatorSpends,
          }) as Prisma.InputJsonValue,
        },
        create: {
          eventId: webhookEventId,
          wireJobId: job.id,
          eventType: `wire.job.${input.state.toLowerCase()}`,
          state: input.state,
          contractState: input.state,
          payloadJson: buildTerminalWebhookPayload({
            ...updatedJob,
            operatorSpends: job.operatorSpends,
          }) as Prisma.InputJsonValue,
        },
      });
    }

    return {
      ...updatedJob,
      operator: workflow,
    };
  });

export const reconcileWireJobFundedState = async (input: {
  jobId: string;
  createTxHash: string;
  fundTxHash: string;
  confirmedAt: Date;
  blockNumber: bigint;
  confirmations: number;
}) =>
  prisma.$transaction(async (tx) => {
    const job = await tx.wireJob.findUnique({
      where: { jobId: input.jobId },
      include: {
        workflow: true,
      },
    });
    if (!job) throw new WireJobNotFoundError();

    const transitionEventId = buildWireFundedEventId(job.jobId, input.fundTxHash);
    const webhookEventId = buildWireFundedWebhookEventId(job.jobId, input.fundTxHash);

    const updatedJob = await tx.wireJob.update({
      where: { id: job.id },
      data: {
        contractState: job.contractState === "FUNDED" ? job.contractState : "FUNDED",
        publicState: job.publicState === "FUNDED" ? job.publicState : "FUNDED",
      },
      select: {
        id: true,
        jobId: true,
        quoteId: true,
        chainId: true,
        contractAddress: true,
        contractJobId: true,
        contractState: true,
        publicState: true,
        principalAmount: true,
        protocolFeeAmount: true,
        networkReserveAmount: true,
        createTxHash: true,
        fundTxHash: true,
        webhookTargetUrl: true,
        webhookSecret: true,
        updatedAt: true,
      },
    });

    const workflow = await tx.wireJobWorkflow.update({
      where: { wireJobId: job.id },
      data: {
        createStatus: "SUCCEEDED",
        fundStatus: "SUCCEEDED",
        confirmationStatus: "SUCCEEDED",
        reconcileStatus: "SUCCEEDED",
        lastError: null,
        nextRetryAt: null,
        lastAttemptAt: input.confirmedAt,
        manualReviewRequired: false,
        manualReviewReason: null,
      },
      select: {
        createStatus: true,
        fundStatus: true,
        confirmationStatus: true,
        reconcileStatus: true,
        manualReviewRequired: true,
        manualReviewReason: true,
      },
    });

    await tx.wireJobTransition.upsert({
      where: { eventId: transitionEventId },
      update: {
        fromState: "OPEN",
        toState: "FUNDED",
        sourceTxHash: input.fundTxHash,
        blockNumber: input.blockNumber,
        observedAt: input.confirmedAt,
        confirmedAt: input.confirmedAt,
        confirmationsAtObservation: input.confirmations,
      },
      create: {
        wireJobId: job.id,
        eventId: transitionEventId,
        fromState: "OPEN",
        toState: "FUNDED",
        sourceTxHash: input.fundTxHash,
        blockNumber: input.blockNumber,
        observedAt: input.confirmedAt,
        confirmedAt: input.confirmedAt,
        confirmationsAtObservation: input.confirmations,
      },
    });

    if (hasWireWebhookTarget(updatedJob)) {
      await tx.wireWebhookOutbox.upsert({
        where: { eventId: webhookEventId },
        update: {
          eventType: "wire.job.funded",
          state: "FUNDED",
          contractState: "FUNDED",
          payloadJson: buildFundedWebhookPayload(updatedJob) as Prisma.InputJsonValue,
        },
        create: {
          eventId: webhookEventId,
          wireJobId: job.id,
          eventType: "wire.job.funded",
          state: "FUNDED",
          contractState: "FUNDED",
          payloadJson: buildFundedWebhookPayload(updatedJob) as Prisma.InputJsonValue,
        },
      });
    }

    return {
      ...updatedJob,
      operator: workflow,
    };
  });
