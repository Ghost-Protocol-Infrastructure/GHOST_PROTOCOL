import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  getAbiItem,
  getAddress,
  http,
  maxUint256,
  parseEventLogs,
  toHex,
  verifyMessage,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import { GHOSTWIRE_ERC8183_AGENTIC_COMMERCE_ABI } from "@/lib/ghostwire-contract";
import {
  GHOSTWIRE_PROTOCOL_FEE_BPS,
  GHOSTWIRE_SUPPORTED_MAINNET_CHAIN_ID,
  GHOSTWIRE_SUPPORTED_SETTLEMENT_ASSET,
  resolveGhostWireContractAddress,
  resolveGhostWireMinConfirmations,
  resolveGhostWireRpcUrl,
  resolveGhostWireUsdcAddress,
  type GhostWireSupportedChainId,
} from "@/lib/ghostwire-config";

export type WireApprovalMode = "exact" | "unlimited";

export type GhostWireWalletTxRequest = {
  to: Address;
  data: Hex;
  value: Hex;
  chainId: GhostWireSupportedChainId;
};

export type GhostWireDirectBalanceAnalysis = {
  asset: "USDC";
  amount: string;
  decimals: 6;
  requiredAmount: string;
  sufficient: boolean;
};

export type GhostWireNativeBalanceAnalysis = {
  asset: "ETH";
  amount: string;
  decimals: 18;
};

export type GhostWireDirectAllowanceAnalysis = {
  asset: "USDC";
  amount: string;
  decimals: 6;
  requiredAmount: string;
  sufficient: boolean;
};

export type GhostWireArtifactAuthPayload = {
  scope: "ghostwire_artifacts";
  version: "1";
  jobId: string;
  clientAddress: string;
  createTxHash: string | null;
  fundTxHash: string | null;
  issuedAt: number;
  nonce: string;
};

const GHOSTWIRE_ARTIFACT_AUTH_SCOPE = "ghostwire_artifacts" as const;
const GHOSTWIRE_ARTIFACT_AUTH_VERSION = "1" as const;
const GHOSTWIRE_ARTIFACT_AUTH_MAX_AGE_SECONDS = 300;
const GHOSTWIRE_CREATE_READBACK_RETRY_DELAYS_MS = [250, 1_000, 2_500] as const;

const getWireChain = (chainId: GhostWireSupportedChainId) =>
  chainId === GHOSTWIRE_SUPPORTED_MAINNET_CHAIN_ID ? base : baseSepolia;

export const createGhostWirePublicClient = (chainId: GhostWireSupportedChainId) =>
  createPublicClient({
    chain: getWireChain(chainId),
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

const delay = async (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export const buildGhostWireJobDescription = (input: {
  metadataUri?: string | null;
  specHash: string;
}): string => {
  const metadataUri = input.metadataUri?.trim();
  return metadataUri && metadataUri.length > 0 ? metadataUri : input.specHash;
};

export const buildGhostWireWalletTxRequest = (input: {
  to: Address;
  data: Hex;
  chainId: GhostWireSupportedChainId;
  value?: bigint;
}): GhostWireWalletTxRequest => ({
  to: input.to,
  data: input.data,
  chainId: input.chainId,
  value: toHex(input.value ?? 0n),
});

export const buildGhostWireApproveTxRequest = (input: {
  chainId: GhostWireSupportedChainId;
  spender: Address;
  amount: bigint;
  approvalMode?: WireApprovalMode;
}): GhostWireWalletTxRequest => {
  const tokenAddress = resolveGhostWireUsdcAddress(input.chainId);
  const approveAmount = input.approvalMode === "unlimited" ? maxUint256 : input.amount;
  return buildGhostWireWalletTxRequest({
    to: tokenAddress,
    chainId: input.chainId,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [input.spender, approveAmount],
    }),
  });
};

export const buildGhostWireCreateTxRequest = (input: {
  chainId: GhostWireSupportedChainId;
  providerAddress: string;
  evaluatorAddress: string;
  jobExpiresAt: Date;
  description: string;
}): GhostWireWalletTxRequest => {
  const contractAddress = resolveGhostWireContractAddress(input.chainId);
  if (!contractAddress) {
    throw new Error(`GhostWire contract address is not configured for chain ${input.chainId}.`);
  }

  return buildGhostWireWalletTxRequest({
    to: contractAddress,
    chainId: input.chainId,
    data: encodeFunctionData({
      abi: GHOSTWIRE_ERC8183_AGENTIC_COMMERCE_ABI,
      functionName: "createJob",
      args: [
        getAddress(input.providerAddress),
        getAddress(input.evaluatorAddress),
        BigInt(Math.floor(input.jobExpiresAt.getTime() / 1000)),
        input.description,
      ],
    }),
  });
};

export const buildGhostWireSetBudgetTxRequest = (input: {
  chainId: GhostWireSupportedChainId;
  contractJobId: string;
  budgetAmount: bigint;
}): GhostWireWalletTxRequest => {
  const contractAddress = resolveGhostWireContractAddress(input.chainId);
  if (!contractAddress) {
    throw new Error(`GhostWire contract address is not configured for chain ${input.chainId}.`);
  }

  return buildGhostWireWalletTxRequest({
    to: contractAddress,
    chainId: input.chainId,
    data: encodeFunctionData({
      abi: GHOSTWIRE_ERC8183_AGENTIC_COMMERCE_ABI,
      functionName: "setBudget",
      args: [BigInt(input.contractJobId), input.budgetAmount],
    }),
  });
};

export const buildGhostWireFundTxRequest = (input: {
  chainId: GhostWireSupportedChainId;
  contractJobId: string;
  budgetAmount: bigint;
}): GhostWireWalletTxRequest => {
  const contractAddress = resolveGhostWireContractAddress(input.chainId);
  if (!contractAddress) {
    throw new Error(`GhostWire contract address is not configured for chain ${input.chainId}.`);
  }

  return buildGhostWireWalletTxRequest({
    to: contractAddress,
    chainId: input.chainId,
    data: encodeFunctionData({
      abi: GHOSTWIRE_ERC8183_AGENTIC_COMMERCE_ABI,
      functionName: "fund",
      args: [BigInt(input.contractJobId), input.budgetAmount],
    }),
  });
};

export const getGhostWireDirectPreflight = async (input: {
  chainId: GhostWireSupportedChainId;
  clientAddress: string;
  budgetAmount: bigint;
  approvalMode?: WireApprovalMode;
}) => {
  const contractAddress = resolveGhostWireContractAddress(input.chainId);
  if (!contractAddress) {
    throw new Error(`GhostWire contract address is not configured for chain ${input.chainId}.`);
  }

  const clientAddress = getAddress(input.clientAddress);
  const tokenAddress = resolveGhostWireUsdcAddress(input.chainId);
  const publicClient = createGhostWirePublicClient(input.chainId);
  const [allowance, balance, nativeBalance] = await Promise.all([
    publicClient.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "allowance",
      args: [clientAddress, contractAddress],
    }),
    publicClient.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [clientAddress],
    }),
    publicClient.getBalance({ address: clientAddress }),
  ]);

  const approvalMode = input.approvalMode ?? "exact";
  const needsApproval = allowance < input.budgetAmount;
  return {
    contractAddress,
    paymentTokenAddress: tokenAddress,
    approvalMode,
    allowance: {
      asset: GHOSTWIRE_SUPPORTED_SETTLEMENT_ASSET,
      amount: allowance.toString(),
      decimals: 6,
      requiredAmount: input.budgetAmount.toString(),
      sufficient: allowance >= input.budgetAmount,
    } satisfies GhostWireDirectAllowanceAnalysis,
    balance: {
      asset: GHOSTWIRE_SUPPORTED_SETTLEMENT_ASSET,
      amount: balance.toString(),
      decimals: 6,
      requiredAmount: input.budgetAmount.toString(),
      sufficient: balance >= input.budgetAmount,
    } satisfies GhostWireDirectBalanceAnalysis,
    nativeBalance: {
      asset: "ETH",
      amount: nativeBalance.toString(),
      decimals: 18,
    } satisfies GhostWireNativeBalanceAnalysis,
    approveTxRequest: needsApproval
      ? buildGhostWireApproveTxRequest({
          chainId: input.chainId,
          spender: contractAddress,
          amount: input.budgetAmount,
          approvalMode,
        })
      : null,
  };
};

export const buildGhostWireArtifactAuthPayload = (input: {
  jobId: string;
  clientAddress: string;
  createTxHash?: string | null;
  fundTxHash?: string | null;
  issuedAt?: number;
  nonce: string;
}): GhostWireArtifactAuthPayload => ({
  scope: GHOSTWIRE_ARTIFACT_AUTH_SCOPE,
  version: GHOSTWIRE_ARTIFACT_AUTH_VERSION,
  jobId: input.jobId,
  clientAddress: getAddress(input.clientAddress).toLowerCase(),
  createTxHash: normalizeHash(input.createTxHash ?? null),
  fundTxHash: normalizeHash(input.fundTxHash ?? null),
  issuedAt: input.issuedAt ?? Math.floor(Date.now() / 1000),
  nonce: input.nonce,
});

export const buildGhostWireArtifactAuthMessage = (payload: GhostWireArtifactAuthPayload): string =>
  [
    "Ghost Protocol GhostWire Artifact Authorization",
    `scope:${payload.scope}`,
    `version:${payload.version}`,
    `jobId:${payload.jobId}`,
    `clientAddress:${payload.clientAddress}`,
    `createTxHash:${payload.createTxHash ?? ""}`,
    `fundTxHash:${payload.fundTxHash ?? ""}`,
    `issuedAt:${payload.issuedAt}`,
    `nonce:${payload.nonce}`,
  ].join("\n");

export const verifyGhostWireArtifactAuth = async (input: {
  expectedClientAddress: string;
  authPayload: GhostWireArtifactAuthPayload;
  authSignature: string;
  nowSeconds?: number;
}) => {
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (input.authPayload.scope !== GHOSTWIRE_ARTIFACT_AUTH_SCOPE) return false;
  if (input.authPayload.version !== GHOSTWIRE_ARTIFACT_AUTH_VERSION) return false;
  if (input.authPayload.issuedAt > nowSeconds + 5) return false;
  if (nowSeconds - input.authPayload.issuedAt > GHOSTWIRE_ARTIFACT_AUTH_MAX_AGE_SECONDS) return false;
  if (getAddress(input.authPayload.clientAddress).toLowerCase() !== getAddress(input.expectedClientAddress).toLowerCase()) {
    return false;
  }

  return verifyMessage({
    address: getAddress(input.expectedClientAddress),
    message: buildGhostWireArtifactAuthMessage(input.authPayload),
    signature: input.authSignature as Hex,
  });
};

const mapGhostWireContractStatus = (status: bigint | number) => {
  const normalized = typeof status === "bigint" ? Number(status) : status;
  switch (normalized) {
    case 0:
      return "OPEN" as const;
    case 1:
      return "FUNDED" as const;
    case 2:
      return "SUBMITTED" as const;
    case 3:
      return "COMPLETED" as const;
    case 4:
      return "REJECTED" as const;
    case 5:
      return "EXPIRED" as const;
    default:
      throw new Error(`Unsupported GhostWire contract status: ${String(status)}`);
  }
};

const readGhostWireJob = async (input: {
  chainId: GhostWireSupportedChainId;
  contractAddress: Address;
  contractJobId: string;
}) => {
  const publicClient = createGhostWirePublicClient(input.chainId);
  return publicClient.readContract({
    address: input.contractAddress,
    abi: GHOSTWIRE_ERC8183_AGENTIC_COMMERCE_ABI,
    functionName: "getJob",
    args: [BigInt(input.contractJobId)],
  });
};

type GhostWireOnchainJobSnapshot = {
  client: Address;
  provider: Address;
  evaluator: Address;
  description: string;
  budget: bigint;
  expiredAt: bigint;
  status: bigint | number;
};

const buildGhostWireCreateReadbackMismatchMessage = (input: {
  contractAddress: Address;
  contractJobId: string;
  expectedClientAddress: string;
  expectedProviderAddress: string;
  expectedEvaluatorAddress: string;
  expectedDescription: string;
  expectedExpiry: bigint;
  onchainJob: GhostWireOnchainJobSnapshot;
}) => {
  const expectedClient = getAddress(input.expectedClientAddress).toLowerCase();
  const expectedProvider = getAddress(input.expectedProviderAddress).toLowerCase();
  const expectedEvaluator = getAddress(input.expectedEvaluatorAddress).toLowerCase();
  const observedClient = getAddress(input.onchainJob.client).toLowerCase();
  const observedProvider = getAddress(input.onchainJob.provider).toLowerCase();
  const observedEvaluator = getAddress(input.onchainJob.evaluator).toLowerCase();
  const mismatches: string[] = [];

  if (observedClient !== expectedClient) {
    mismatches.push(`client expected=${expectedClient} observed=${observedClient}`);
  }
  if (observedProvider !== expectedProvider) {
    mismatches.push(`provider expected=${expectedProvider} observed=${observedProvider}`);
  }
  if (observedEvaluator !== expectedEvaluator) {
    mismatches.push(`evaluator expected=${expectedEvaluator} observed=${observedEvaluator}`);
  }
  if (input.onchainJob.description !== input.expectedDescription) {
    mismatches.push(
      `description expected=${JSON.stringify(input.expectedDescription)} observed=${JSON.stringify(input.onchainJob.description)}`,
    );
  }
  if (input.onchainJob.expiredAt !== input.expectedExpiry) {
    mismatches.push(
      `expiredAt expected=${input.expectedExpiry.toString()} observed=${input.onchainJob.expiredAt.toString()}`,
    );
  }

  if (mismatches.length === 0) return null;

  return `On-chain GhostWire job readback did not match the prepared job. contract=${input.contractAddress.toLowerCase()} jobId=${input.contractJobId} ${mismatches.join("; ")}`;
};

export const validateGhostWireCreateArtifact = async (input: {
  chainId: GhostWireSupportedChainId;
  expectedClientAddress: string;
  expectedProviderAddress: string;
  expectedEvaluatorAddress: string;
  expectedJobExpiresAt: Date;
  expectedDescription: string;
  createTxHash: string;
}) => {
  const contractAddress = resolveGhostWireContractAddress(input.chainId);
  if (!contractAddress) {
    throw new Error(`GhostWire contract address is not configured for chain ${input.chainId}.`);
  }

  const publicClient = createGhostWirePublicClient(input.chainId);
  const txHash = normalizeHash(input.createTxHash);
  if (!txHash) {
    throw new Error("Create transaction hash is malformed.");
  }

  const [transaction, receipt] = await Promise.all([
    publicClient.getTransaction({ hash: txHash }),
    publicClient.getTransactionReceipt({ hash: txHash }),
  ]);
  if (receipt.status !== "success") throw new Error("Create transaction reverted on-chain.");
  if (!transaction.to || getAddress(transaction.to) !== contractAddress) {
    throw new Error("Create transaction was not sent to the configured GhostWire contract.");
  }
  if (getAddress(transaction.from).toLowerCase() !== getAddress(input.expectedClientAddress).toLowerCase()) {
    throw new Error("Create transaction sender does not match the expected client wallet.");
  }

  const parsedEvents = parseEventLogs({
    abi: GHOSTWIRE_ERC8183_AGENTIC_COMMERCE_ABI,
    logs: receipt.logs,
    eventName: "JobCreated",
    strict: false,
  });
  const expectedExpiry = BigInt(Math.floor(input.expectedJobExpiresAt.getTime() / 1000));
  const matchingEvent = parsedEvents.find((event) => {
    const client = typeof event.args.client === "string" ? getAddress(event.args.client).toLowerCase() : null;
    const provider = typeof event.args.provider === "string" ? getAddress(event.args.provider).toLowerCase() : null;
    const evaluator = typeof event.args.evaluator === "string" ? getAddress(event.args.evaluator).toLowerCase() : null;
    return (
      client === getAddress(input.expectedClientAddress).toLowerCase() &&
      provider === getAddress(input.expectedProviderAddress).toLowerCase() &&
      evaluator === getAddress(input.expectedEvaluatorAddress).toLowerCase() &&
      event.args.expiredAt === expectedExpiry
    );
  });

  const rawJobId = matchingEvent?.args.jobId;
  if (typeof rawJobId !== "bigint") {
    throw new Error("Create transaction did not emit a matching JobCreated event.");
  }
  const contractJobId = rawJobId.toString();
  let onchainJob: GhostWireOnchainJobSnapshot | null = null;
  let lastReadbackError =
    `On-chain GhostWire job readback did not stabilize after create. contract=${contractAddress.toLowerCase()} jobId=${contractJobId}`;

  for (let attempt = 0; attempt <= GHOSTWIRE_CREATE_READBACK_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const candidate = (await readGhostWireJob({
        chainId: input.chainId,
        contractAddress,
        contractJobId,
      })) as GhostWireOnchainJobSnapshot;
      const mismatch = buildGhostWireCreateReadbackMismatchMessage({
        contractAddress,
        contractJobId,
        expectedClientAddress: input.expectedClientAddress,
        expectedProviderAddress: input.expectedProviderAddress,
        expectedEvaluatorAddress: input.expectedEvaluatorAddress,
        expectedDescription: input.expectedDescription,
        expectedExpiry,
        onchainJob: candidate,
      });

      if (!mismatch) {
        onchainJob = candidate;
        break;
      }

      lastReadbackError = mismatch;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown GhostWire readback error.";
      lastReadbackError = `Failed to read GhostWire job after create. contract=${contractAddress.toLowerCase()} jobId=${contractJobId} error=${message}`;
    }

    if (attempt < GHOSTWIRE_CREATE_READBACK_RETRY_DELAYS_MS.length) {
      await delay(GHOSTWIRE_CREATE_READBACK_RETRY_DELAYS_MS[attempt]!);
    }
  }

  if (!onchainJob) {
    throw new Error(lastReadbackError);
  }

  const latestBlock = await publicClient.getBlockNumber();
  const confirmations =
    latestBlock >= receipt.blockNumber ? Number(latestBlock - receipt.blockNumber + 1n) : 0;

  return {
    contractAddress,
    contractJobId,
    createTxHash: txHash,
    createTxSender: getAddress(transaction.from).toLowerCase(),
    blockNumber: receipt.blockNumber,
    confirmations,
    onchainState: mapGhostWireContractStatus(onchainJob.status),
  };
};

export const validateGhostWireFundArtifact = async (input: {
  chainId: GhostWireSupportedChainId;
  expectedClientAddress: string;
  expectedProviderAddress: string;
  expectedEvaluatorAddress: string;
  expectedBudgetAmount: bigint;
  expectedContractJobId: string;
  fundTxHash: string;
}) => {
  const contractAddress = resolveGhostWireContractAddress(input.chainId);
  if (!contractAddress) {
    throw new Error(`GhostWire contract address is not configured for chain ${input.chainId}.`);
  }

  const publicClient = createGhostWirePublicClient(input.chainId);
  const txHash = normalizeHash(input.fundTxHash);
  if (!txHash) {
    throw new Error("Fund transaction hash is malformed.");
  }

  const [transaction, receipt, paymentToken] = await Promise.all([
    publicClient.getTransaction({ hash: txHash }),
    publicClient.getTransactionReceipt({ hash: txHash }),
    publicClient.readContract({
      address: contractAddress,
      abi: GHOSTWIRE_ERC8183_AGENTIC_COMMERCE_ABI,
      functionName: "paymentToken",
    }),
  ]);

  if (receipt.status !== "success") throw new Error("Fund transaction reverted on-chain.");
  if (!transaction.to || getAddress(transaction.to) !== contractAddress) {
    throw new Error("Fund transaction was not sent to the configured GhostWire contract.");
  }
  if (getAddress(transaction.from).toLowerCase() !== getAddress(input.expectedClientAddress).toLowerCase()) {
    throw new Error("Fund transaction sender does not match the expected client wallet.");
  }
  if (getAddress(paymentToken) !== resolveGhostWireUsdcAddress(input.chainId)) {
    throw new Error("Configured GhostWire payment token does not match the expected USDC contract.");
  }

  const parsedEvents = parseEventLogs({
    abi: GHOSTWIRE_ERC8183_AGENTIC_COMMERCE_ABI,
    logs: receipt.logs,
    eventName: "JobFunded",
    strict: false,
  });
  const matchingEvent = parsedEvents.find((event) => {
    const client = typeof event.args.client === "string" ? getAddress(event.args.client).toLowerCase() : null;
    return (
      event.args.jobId === BigInt(input.expectedContractJobId) &&
      client === getAddress(input.expectedClientAddress).toLowerCase() &&
      event.args.amount === input.expectedBudgetAmount
    );
  });
  if (!matchingEvent) {
    throw new Error("Fund transaction did not emit a matching JobFunded event.");
  }

  const onchainJob = (await readGhostWireJob({
    chainId: input.chainId,
    contractAddress,
    contractJobId: input.expectedContractJobId,
  })) as {
    client: Address;
    provider: Address;
    evaluator: Address;
    budget: bigint;
    status: bigint | number;
  };

  if (getAddress(onchainJob.client).toLowerCase() !== getAddress(input.expectedClientAddress).toLowerCase()) {
    throw new Error("On-chain job client does not match the expected client wallet.");
  }
  if (getAddress(onchainJob.provider).toLowerCase() !== getAddress(input.expectedProviderAddress).toLowerCase()) {
    throw new Error("On-chain job provider does not match the expected provider wallet.");
  }
  if (getAddress(onchainJob.evaluator).toLowerCase() !== getAddress(input.expectedEvaluatorAddress).toLowerCase()) {
    throw new Error("On-chain job evaluator does not match the expected evaluator wallet.");
  }
  if (onchainJob.budget !== input.expectedBudgetAmount) {
    throw new Error("On-chain job budget does not match the prepared GhostWire budget.");
  }

  const latestBlock = await publicClient.getBlockNumber();
  const confirmations =
    latestBlock >= receipt.blockNumber ? Number(latestBlock - receipt.blockNumber + 1n) : 0;

  return {
    contractAddress,
    fundTxHash: txHash,
    fundTxSender: getAddress(transaction.from).toLowerCase(),
    blockNumber: receipt.blockNumber,
    confirmations,
    minConfirmations: resolveGhostWireMinConfirmations(input.chainId),
    onchainState: mapGhostWireContractStatus(onchainJob.status),
  };
};

export const parseGhostWireJobCreatedLogs = (input: {
  logs: readonly unknown[];
  expectedClientAddress: string;
  expectedProviderAddress: string;
  expectedEvaluatorAddress: string;
  expectedExpiredAt: bigint;
}) => {
  const parsedEvents = parseEventLogs({
    abi: GHOSTWIRE_ERC8183_AGENTIC_COMMERCE_ABI,
    logs: input.logs as never,
    eventName: "JobCreated",
    strict: false,
  });
  return parsedEvents.find((event) => {
    const client = typeof event.args.client === "string" ? getAddress(event.args.client).toLowerCase() : null;
    const provider = typeof event.args.provider === "string" ? getAddress(event.args.provider).toLowerCase() : null;
    const evaluator = typeof event.args.evaluator === "string" ? getAddress(event.args.evaluator).toLowerCase() : null;
    return (
      client === getAddress(input.expectedClientAddress).toLowerCase() &&
      provider === getAddress(input.expectedProviderAddress).toLowerCase() &&
      evaluator === getAddress(input.expectedEvaluatorAddress).toLowerCase() &&
      event.args.expiredAt === input.expectedExpiredAt
    );
  });
};

export const parseGhostWireFundedLogs = (input: {
  logs: readonly unknown[];
  expectedClientAddress: string;
  expectedContractJobId: string;
  expectedBudgetAmount: bigint;
}) => {
  const parsedEvents = parseEventLogs({
    abi: GHOSTWIRE_ERC8183_AGENTIC_COMMERCE_ABI,
    logs: input.logs as never,
    eventName: "JobFunded",
    strict: false,
  });
  return parsedEvents.find((event) => {
    const client = typeof event.args.client === "string" ? getAddress(event.args.client).toLowerCase() : null;
    return (
      client === getAddress(input.expectedClientAddress).toLowerCase() &&
      event.args.jobId === BigInt(input.expectedContractJobId) &&
      event.args.amount === input.expectedBudgetAmount
    );
  });
};

export const getGhostWireContractDetails = (chainId: GhostWireSupportedChainId) => {
  const contractAddress = resolveGhostWireContractAddress(chainId);
  if (!contractAddress) {
    throw new Error(`GhostWire contract address is not configured for chain ${chainId}.`);
  }

  return {
    chainId,
    contractAddress,
    paymentTokenAddress: resolveGhostWireUsdcAddress(chainId),
    settlementAsset: GHOSTWIRE_SUPPORTED_SETTLEMENT_ASSET,
    protocolFeeBps: GHOSTWIRE_PROTOCOL_FEE_BPS,
  };
};
