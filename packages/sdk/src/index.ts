import { randomUUID } from "node:crypto";
import { decodeXPaymentResponse, type PaymentRequirementsSelector, wrapFetchWithPayment } from "x402-fetch";
import { settle as settleX402Payment, verify as verifyX402Payment } from "x402/facilitator";
import {
  findMatchingPaymentRequirements,
  getDefaultAsset,
  getNetworkId,
  safeBase64Decode,
  safeBase64Encode,
  toJsonSafe,
} from "x402/shared";
import {
  createSigner,
  PaymentPayloadSchema,
  type PaymentPayload,
  type PaymentRequirements,
  type SettleResponse,
  type Signer,
  type VerifyResponse,
} from "x402/types";
import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { GhostFulfillmentMerchantConfig, VerifiedFulfillmentTicket } from "./fulfillment.js";
import { GhostFulfillmentMerchant } from "./fulfillment.js";

export * from "./fulfillment.js";

export type GhostAgentConfig = {
  apiKey?: string;
  agentId?: string;
  baseUrl?: string;
  privateKey?: `0x${string}`;
  chainId?: number;
  serviceSlug?: string;
  creditCost?: number;
};

export type ConnectResult = {
  connected: boolean;
  apiKeyPrefix: string;
  endpoint: string;
  status: number;
  payload: unknown;
};

export type TelemetryResult = {
  ok: boolean;
  endpoint: string;
  status: number;
  payload: unknown;
};

export type PulseInput = {
  apiKey?: string;
  agentId?: string | null;
  serviceSlug?: string | null;
  metadata?: Record<string, unknown>;
};

export type OutcomeInput = PulseInput & {
  success: boolean;
  statusCode?: number | null;
};

export type HeartbeatOptions = PulseInput & {
  intervalMs?: number;
  immediate?: boolean;
  onResult?: (result: TelemetryResult) => void;
  onError?: (error: unknown) => void;
};

export type HeartbeatController = {
  stop: () => void;
};

export type CanaryPayload = {
  ghostgate: "ready";
  service: string;
};

export type GhostMerchantConfig = GhostFulfillmentMerchantConfig & {
  serviceSlug: string;
  ownerPrivateKey?: `0x${string}`;
};

export type X402Network = "base" | "base-sepolia";

export type X402RequestInput = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  maxAmountAtomic?: bigint | number | string | null;
  network?: X402Network;
  paymentRequirementsSelector?: PaymentRequirementsSelector;
};

export type X402RequestResult = {
  ok: boolean;
  endpoint: string;
  status: number;
  payload: unknown;
  paymentResponseHeader: string | null;
  paymentResponse: ReturnType<typeof decodeXPaymentResponse> | null;
};

export type SettlementEvidenceInput = {
  requestId: string;
  paymentReference: string;
  payerIdentity: string;
  payerAddress?: `0x${string}` | string | null;
  scheme?: string;
  network?: string | null;
  chainId?: number | null;
  asset?: string;
  amountAtomic: bigint | number | string;
  decimals?: number;
  success: boolean;
  statusCode?: number | null;
  latencyMs?: number | null;
  occurredAt?: string | Date;
  metadata?: Record<string, unknown>;
};

export type SettlementEvidence = {
  requestId: string;
  paymentReference: string;
  payerIdentity: string;
  payerAddress: string | null;
  scheme: string;
  network: string | null;
  chainId: number | null;
  asset: string;
  amountAtomic: string;
  decimals: number;
  success: boolean;
  statusCode: number | null;
  latencyMs: number | null;
  occurredAt: string;
  metadata?: Record<string, unknown>;
};

export type X402ReporterRuntimeSupport = {
  runtime: "node_server" | "python_server" | "next_node" | "serverless_node" | "edge";
  support: "first_class" | "best_effort" | "manual_only";
  durability: "in_process_async_outbox" | "best_effort" | "manual_only";
  note: string;
};

export const X402_REPORTING_RUNTIME_SUPPORT: readonly X402ReporterRuntimeSupport[] = [
  {
    runtime: "node_server",
    support: "first_class",
    durability: "in_process_async_outbox",
    note: "Long-lived Node servers are the primary target for automatic x402 settlement reporting.",
  },
  {
    runtime: "python_server",
    support: "first_class",
    durability: "in_process_async_outbox",
    note: "Long-lived Python servers are the primary target for automatic x402 settlement reporting.",
  },
  {
    runtime: "next_node",
    support: "first_class",
    durability: "in_process_async_outbox",
    note: "Next.js support in MVP means Node runtime route handlers only.",
  },
  {
    runtime: "serverless_node",
    support: "best_effort",
    durability: "best_effort",
    note: "Short-lived Node runtimes can use best-effort auto-reporting or manual settlement reporting.",
  },
  {
    runtime: "edge",
    support: "manual_only",
    durability: "manual_only",
    note: "Edge runtimes are not first-class reporting targets in the MVP.",
  },
] as const;

export type X402SettlementReportInput = SettlementEvidenceInput & {
  agentId: string;
  serviceSlug: string;
};

export type X402SettlementReportResult = {
  ok: boolean;
  endpoint: string;
  status: number;
  payload: unknown;
  countedForRank: boolean;
  relatedParty: boolean;
  duplicate: boolean;
};

export type X402SettlementReporterRuntime = X402ReporterRuntimeSupport["runtime"];

export type X402SettlementReporterMode = "queued" | "best_effort" | "manual_only";

export type X402SettlementReporterEventName =
  | "payment_verified"
  | "report_enqueued"
  | "report_sent"
  | "report_accepted"
  | "duplicate"
  | "report_dropped";

export type X402SettlementReporterObservedPayment = {
  agentId: string;
  serviceSlug: string;
  requestId: string;
  paymentReference: string;
};

export type X402SettlementReporterCounters = {
  paymentVerified: number;
  reportEnqueued: number;
  duplicate: number;
  reportSent: number;
  reportAccepted: number;
  reportDropped: number;
};

export type X402SettlementReporterEvent = {
  name: X402SettlementReporterEventName;
  runtime: X402SettlementReporterRuntime;
  support: X402ReporterRuntimeSupport["support"];
  durability: X402ReporterRuntimeSupport["durability"];
  occurredAt: string;
  queueSize: number;
  agentId?: string;
  serviceSlug?: string;
  requestId?: string;
  paymentReference?: string;
  dedupeKey?: string;
  attempt?: number;
  status?: number;
  countedForRank?: boolean;
  relatedParty?: boolean;
  serverDuplicate?: boolean;
  error?: string;
};

export type X402SettlementReporterSnapshot = {
  runtime: X402SettlementReporterRuntime;
  support: X402ReporterRuntimeSupport["support"];
  durability: X402ReporterRuntimeSupport["durability"];
  queueSize: number;
  processing: boolean;
  lastError: string | null;
  counters: X402SettlementReporterCounters;
};

export type X402SettlementReporterConfig = {
  runtime: X402SettlementReporterRuntime;
  maxQueueSize?: number;
  retryDelaysMs?: readonly number[];
  onEvent?: (event: X402SettlementReporterEvent) => void;
};

export type X402SettlementReporterEnqueueResult = {
  accepted: boolean;
  duplicate: boolean;
  mode: X402SettlementReporterMode;
  requiresManualReporting: boolean;
  dedupeKey: string;
  queueSize: number;
};

export type GhostX402AdapterRuntime = "node_server" | "next_node";

export type GhostX402HandlerResult = Response | BodyInit | Record<string, unknown> | null | undefined;

export type GhostX402ResolvedPayment = {
  requestId: string;
  paymentReference: string;
  paymentRequirements: PaymentRequirements;
  paymentPayload: PaymentPayload;
  verifyResult: VerifyResponse;
  settleResult: SettleResponse;
  payerIdentity: string;
  payerAddress: string | null;
};

export type GhostX402AdapterCallbackArgs<TContext> = {
  request: Request;
  context: TContext;
  x402: GhostX402ResolvedPayment;
};

export type GhostX402DecodePaymentHeader = (paymentHeader: string) => PaymentPayload;

export type GhostX402VerifyPayment = (input: {
  client: Signer;
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}) => Promise<VerifyResponse>;

export type GhostX402SettlePayment = (input: {
  client: Signer;
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}) => Promise<SettleResponse>;

export type GhostX402PayerResolverArgs<TContext> = {
  request: Request;
  context: TContext;
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
  verifyResult: VerifyResponse;
  settleResult: SettleResponse;
};

export type GhostX402MetadataResolverArgs<TContext> = GhostX402PayerResolverArgs<TContext> & {
  response: Response;
};

export type GhostX402RequestIdResolverArgs<TContext> = {
  request: Request;
  context: TContext;
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
};

export type GhostX402AdapterConfig<TContext> = {
  merchant: GhostMerchant;
  agentId: string;
  serviceSlug?: string;
  reportingRuntime?: X402SettlementReporterRuntime;
  paymentRequirements: PaymentRequirements | readonly PaymentRequirements[];
  x402Client: Signer;
  reporter?: X402SettlementReporter;
  reporterConfig?: Omit<X402SettlementReporterConfig, "runtime">;
  decodePaymentHeader?: GhostX402DecodePaymentHeader;
  verifyPayment?: GhostX402VerifyPayment;
  settlePayment?: GhostX402SettlePayment;
  getRequestId?: (args: GhostX402RequestIdResolverArgs<TContext>) => string;
  getPayerIdentity?: (args: GhostX402PayerResolverArgs<TContext>) => string | Promise<string>;
  getPayerAddress?: (args: GhostX402PayerResolverArgs<TContext>) => string | null | Promise<string | null>;
  getMetadata?: (args: GhostX402MetadataResolverArgs<TContext>) => Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>;
};

export type GhostX402ExpressLikeRequest = {
  method?: string;
  url?: string;
  originalUrl?: string;
  protocol?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  rawBody?: unknown;
};

export type GhostX402ExpressLikeResponse = {
  status?: (statusCode: number) => GhostX402ExpressLikeResponse;
  setHeader?: (name: string, value: string) => unknown;
  send?: (body: string | Buffer) => unknown;
  end?: (body?: string | Buffer) => unknown;
};

export type GhostX402FastifyLikeRequest = {
  method?: string;
  url?: string;
  protocol?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  rawBody?: unknown;
};

export type GhostX402FastifyLikeReply = {
  code?: (statusCode: number) => GhostX402FastifyLikeReply;
  header?: (name: string, value: string) => GhostX402FastifyLikeReply;
  send?: (body: unknown) => unknown;
};

export type GhostHttpMonetizationRail = "x402" | "express" | "hybrid";

export type GhostHttpMonetizationConfig = {
  version: 1;
  service: {
    agentId: string;
    serviceSlug: string;
    endpointUrl?: string | null;
  };
  routes: Record<string, GhostHttpMonetizationRouteConfig>;
};

export type GhostHttpMonetizationRouteConfig = {
  method?: string;
  path: string;
  rail: GhostHttpMonetizationRail;
  x402?: {
    paymentRequirements: PaymentRequirements | readonly PaymentRequirements[];
    reportingRuntime?: X402SettlementReporterRuntime;
  };
  express?: {
    creditCost?: number | null;
  };
};

export type GhostHttpMonetizationRouteSelection =
  | string
  | {
      routeId: string;
      rail?: Exclude<GhostHttpMonetizationRail, "hybrid">;
    };

export type GhostResolvedHttpMonetizationRoute = {
  id: string;
  method: string;
  path: string;
  rail: Exclude<GhostHttpMonetizationRail, "hybrid">;
  routeRail: GhostHttpMonetizationRail;
  agentId: string;
  serviceSlug: string;
  endpointUrl: string | null;
  x402: {
    paymentRequirements: PaymentRequirements[];
    reportingRuntime: X402SettlementReporterRuntime | null;
  } | null;
  express: {
    creditCost: number | null;
  } | null;
};

export type GhostHttpMonetizationHandlerArgs<TContext> = {
  request: Request;
  context: TContext;
  route: GhostResolvedHttpMonetizationRoute;
} & (
  | {
      rail: "x402";
      x402: GhostX402ResolvedPayment;
      fulfillment?: never;
    }
  | {
      rail: "express";
      fulfillment: VerifiedFulfillmentTicket;
      x402?: never;
    }
);

export type GhostHttpMonetizationExpressHandlerArgs<TRequest> = {
  req: TRequest;
  request: Request;
  route: GhostResolvedHttpMonetizationRoute;
} & (
  | {
      rail: "x402";
      x402: GhostX402ResolvedPayment;
      fulfillment?: never;
    }
  | {
      rail: "express";
      fulfillment: VerifiedFulfillmentTicket;
      x402?: never;
    }
);

export type GhostHttpMonetizationFastifyHandlerArgs<TRequest> = {
  request: TRequest;
  rawRequest: Request;
  route: GhostResolvedHttpMonetizationRoute;
} & (
  | {
      rail: "x402";
      x402: GhostX402ResolvedPayment;
      fulfillment?: never;
    }
  | {
      rail: "express";
      fulfillment: VerifiedFulfillmentTicket;
      x402?: never;
    }
);

export type GhostHttpMonetizationKitConfig = {
  merchant: GhostMerchant;
  config: GhostHttpMonetizationConfig;
  x402?: {
    x402Client: Signer;
    reporter?: X402SettlementReporter;
    reporterConfig?: Omit<X402SettlementReporterConfig, "runtime">;
    reportingRuntime?: X402SettlementReporterRuntime;
    decodePaymentHeader?: GhostX402DecodePaymentHeader;
    verifyPayment?: GhostX402VerifyPayment;
    settlePayment?: GhostX402SettlePayment;
  };
};

export type GhostHttpMonetizationKit = {
  readonly config: GhostHttpMonetizationConfig;
  resolveRoute: (selection: GhostHttpMonetizationRouteSelection) => GhostResolvedHttpMonetizationRoute;
  withNextNode: <TContext = unknown>(
    selection: GhostHttpMonetizationRouteSelection,
    handler: (
      args: GhostHttpMonetizationHandlerArgs<TContext>,
    ) => Promise<GhostX402HandlerResult> | GhostX402HandlerResult,
  ) => (request: Request, context?: TContext) => Promise<Response>;
  withHono: <TContext extends { req?: { raw?: Request } }>(
    selection: GhostHttpMonetizationRouteSelection,
    handler: (
      args: GhostHttpMonetizationHandlerArgs<TContext>,
    ) => Promise<GhostX402HandlerResult> | GhostX402HandlerResult,
  ) => (context: TContext) => Promise<Response>;
  withExpress: <TRequest extends GhostX402ExpressLikeRequest>(
    selection: GhostHttpMonetizationRouteSelection,
    handler: (
      args: GhostHttpMonetizationExpressHandlerArgs<TRequest>,
    ) => Promise<GhostX402HandlerResult> | GhostX402HandlerResult,
  ) => (req: TRequest, res: GhostX402ExpressLikeResponse) => Promise<void>;
  withFastify: <TRequest extends GhostX402FastifyLikeRequest>(
    selection: GhostHttpMonetizationRouteSelection,
    handler: (
      args: GhostHttpMonetizationFastifyHandlerArgs<TRequest>,
    ) => Promise<GhostX402HandlerResult> | GhostX402HandlerResult,
  ) => (request: TRequest, reply: GhostX402FastifyLikeReply) => Promise<void>;
};

export type GhostMcpProxyToolConfig = {
  route: GhostHttpMonetizationRouteSelection;
  descriptionFallbackText?: boolean;
};

export type GhostMcpProxyConfig = {
  upstream: {
    url: string;
    timeoutMs?: number;
    headers?: Record<string, string>;
  };
  tools: Record<string, GhostMcpProxyToolConfig>;
};

export type GhostMcpToolPricingMetadata = {
  version: 1;
  routeId: string;
  rail: Exclude<GhostHttpMonetizationRail, "hybrid">;
  routeRail: GhostHttpMonetizationRail;
  serviceSlug: string;
  agentId: string;
  method: string;
  path: string;
  x402: {
    paymentRequirements: PaymentRequirements[];
    reportingRuntime: X402SettlementReporterRuntime | null;
  } | null;
  express: {
    creditCost: number | null;
  } | null;
};

export type GhostMcpProxy = {
  readonly config: GhostMcpProxyConfig;
  handleRequest: (request: Request) => Promise<Response>;
  withNextNode: <TContext = unknown>() => (request: Request, context?: TContext) => Promise<Response>;
  withHono: <TContext extends { req?: { raw?: Request } }>() => (context: TContext) => Promise<Response>;
  withExpress: <TRequest extends GhostX402ExpressLikeRequest>() => (
    req: TRequest,
    res: GhostX402ExpressLikeResponse,
  ) => Promise<void>;
  withFastify: <TRequest extends GhostX402FastifyLikeRequest>() => (
    request: TRequest,
    reply: GhostX402FastifyLikeReply,
  ) => Promise<void>;
};

type GhostFulfillmentAdapterCallbackArgs<TContext> = {
  request: Request;
  context: TContext;
  fulfillment: VerifiedFulfillmentTicket;
};

type GhostFulfillmentAdapterConfig<TContext> = {
  merchant: GhostMerchant;
  serviceSlug: string;
  method: string;
  path: string;
  creditCost?: number | null;
};

type X402SettlementReporterTransport = {
  reportX402Settlement(input: X402SettlementReportInput): Promise<X402SettlementReportResult>;
};

type X402SettlementReporterQueueEntry = {
  dedupeKey: string;
  input: X402SettlementReportInput;
  attempt: number;
  nextAttemptAt: number;
};

const DEFAULT_X402_REPORTER_MAX_QUEUE_SIZE = 100;
const DEFAULT_X402_REPORTER_RETRY_DELAYS_MS = [250, 1000, 5000] as const;

type MerchantGatewayAuthAction =
  | "config"
  | "verify"
  | "delegated_signer_register"
  | "x402_settlement_report";

type MerchantGatewayAuthPayload = {
  scope: "agent_gateway";
  version: "1";
  action: MerchantGatewayAuthAction;
  agentId: string;
  ownerAddress: string;
  actorAddress: string;
  serviceSlug: string;
  nonce: string;
  issuedAt: number;
};

type MerchantGatewayConfigResponse = {
  configured: boolean;
  config: {
    ownerAddress: string;
    readinessStatus: "UNCONFIGURED" | "CONFIGURED" | "LIVE" | "DEGRADED";
  };
};

type MerchantGatewayVerifyResponse = {
  verified?: boolean;
  readinessStatus?: "UNCONFIGURED" | "CONFIGURED" | "LIVE" | "DEGRADED";
  error?: string;
  canaryUrl?: string;
  statusCode?: number | null;
  latencyMs?: number | null;
};

type MerchantGatewayDelegatedSignerRegisterResponse = {
  ok?: boolean;
  created?: boolean;
  alreadyActive?: boolean;
  error?: string;
};

export type MerchantActivateOptions = {
  agentId: string;
  serviceSlug: string;
  endpointUrl: string;
  canaryPath?: string;
  canaryMethod?: string;
  signerLabel?: string;
};

export type ActivateResult = {
  status: "LIVE";
  readiness: "LIVE";
  config: MerchantGatewayConfigResponse["config"];
  verify: MerchantGatewayVerifyResponse;
  signerRegistration: MerchantGatewayDelegatedSignerRegisterResponse;
  heartbeat: HeartbeatController;
};

export type WirePricingAmount = {
  asset: string;
  amount: string;
  decimals: number;
  bps?: number;
  chainId?: number;
};

export type GhostWireWalletTxRequest = {
  to: `0x${string}` | string;
  data: `0x${string}` | string;
  value: `0x${string}` | string;
  chainId: number;
};

export type GhostWireBalanceAnalysis = {
  asset: string;
  amount: string;
  decimals: number;
  requiredAmount?: string;
  sufficient?: boolean;
};

export type GhostWireRequestPayload = {
  version?: 1;
  prompt: string;
  walletAddress?: `0x${string}` | string | null;
  metadata?: Record<string, unknown> | null;
};

export type GhostWireDirectPrepare = {
  approvalMode: "exact" | "unlimited";
  contractAddress: string;
  paymentTokenAddress: string;
  expectedBudgetAmount: string;
  description?: string;
  allowance: GhostWireBalanceAnalysis;
  balance: GhostWireBalanceAnalysis;
  nativeBalance: GhostWireBalanceAnalysis;
  approveTxRequest: GhostWireWalletTxRequest | null;
  createTxRequest?: GhostWireWalletTxRequest | null;
  setBudgetTxRequest?: GhostWireWalletTxRequest | null;
  fundTxRequest?: GhostWireWalletTxRequest | null;
  nextAction: "submit_create_artifact" | "submit_fund_artifact";
};

export type WireQuoteResult = {
  ok: boolean;
  endpoint: string;
  status: number;
  payload: unknown;
  quoteId: string | null;
  expiresAt: string | null;
  chainId: number | null;
  contractAddress: string | null;
  paymentTokenAddress: string | null;
  pricing: {
    principal: WirePricingAmount;
    protocolFee: WirePricingAmount;
    networkReserve: WirePricingAmount;
    display?: unknown;
  } | null;
  confirmations: {
    min: number;
  } | null;
  directExecution: {
    customerFundsEscrow: boolean;
    customerPaysGas: boolean;
    sponsorshipSupported: boolean;
  } | null;
};

export type WireJobPrepareInput = {
  quoteId: string;
  client: `0x${string}` | string;
  provider: `0x${string}` | string;
  evaluator: `0x${string}` | string;
  providerAgentId?: string | null;
  providerServiceSlug?: string | null;
  specHash?: `0x${string}` | string | null;
  request?: GhostWireRequestPayload | null;
  metadataUri?: string | null;
  webhookUrl?: string | null;
  webhookSecret?: string | null;
  approvalMode?: "exact" | "unlimited";
};

export type WireJobPrepareResult = {
  ok: boolean;
  endpoint: string;
  status: number;
  payload: unknown;
  jobId: string | null;
  quoteId: string | null;
  chainId: number | null;
  jobExpiresAt: string | null;
  direct: GhostWireDirectPrepare | null;
};

export type WireArtifactRecordInput = {
  jobId: string;
  clientAddress: `0x${string}` | string;
  createTxHash?: `0x${string}` | string | null;
  fundTxHash?: `0x${string}` | string | null;
  createTxSender?: `0x${string}` | string | null;
  fundTxSender?: `0x${string}` | string | null;
  approvalMode?: "exact" | "unlimited";
  clientPrivateKey?: `0x${string}` | null;
};

export type WireArtifactRecordResult = {
  ok: boolean;
  endpoint: string;
  status: number;
  payload: unknown;
  job: WireJobSnapshot | null;
  direct: GhostWireDirectPrepare | null;
};

export type WireJobSnapshot = {
  id: string;
  jobId: string;
  quoteId: string;
  chainId: number;
  jobExpiresAt: string;
  state: string;
  contractState: string;
  terminalDisposition: string | null;
  clientAddress: string;
  providerAddress: string;
  providerAgentId?: string | null;
  providerServiceSlug?: string | null;
  evaluatorAddress: string;
  specHash: string;
  metadataUri: string | null;
  request?: GhostWireRequestPayload | null;
  contractAddress: string | null;
  contractJobId: string | null;
  createTxHash: string | null;
  createTxSender?: string | null;
  fundTxHash: string | null;
  fundTxSender?: string | null;
  terminalTxHash: string | null;
  artifactsRecordedAt?: string | null;
  artifactValidationState?: string | null;
  artifactValidationError?: string | null;
  recoveryAction?: string | null;
  recoveryHint?: string | null;
  createdAt: string;
  updatedAt: string;
  pricing: {
    principal: WirePricingAmount;
    protocolFee: WirePricingAmount;
    networkReserve: WirePricingAmount;
  };
  operator: {
    artifactStatus?: string | null;
    artifactCheckedAt?: string | null;
    createStatus: string | null;
    fundStatus: string | null;
    confirmationStatus: string | null;
    reconcileStatus: string | null;
    retryCount: number | null;
    nextRetryAt: string | null;
    lastError: string | null;
    manualReviewRequired?: boolean | null;
    manualReviewReason?: string | null;
  };
  settlement?: unknown;
  deliverable?: {
    available: boolean;
    locatorUrl: string | null;
    mode: "merchant_locator" | "gateway_standard" | "ipfs_gateway" | "none";
    state: "READY" | "PENDING" | "UNCONFIGURED";
  };
};

export type WireJobResult = {
  ok: boolean;
  endpoint: string;
  status: number;
  payload: unknown;
  job: WireJobSnapshot | null;
};

export type WireDeliverableResult = {
  ok: boolean;
  endpoint: string;
  status: number;
  job: WireJobSnapshot;
  contentType: string | null;
  bodyJson: unknown | null;
  bodyText: string | null;
  sourceUrl: string;
};

export type WireCompletionWaitOptions = {
  intervalMs?: number;
  timeoutMs?: number;
};

const DEFAULT_BASE_URL = "https://ghostprotocol.cc";
const DEFAULT_CHAIN_ID = 8453;
const DEFAULT_SERVICE_SLUG = "connect";
const DEFAULT_CREDIT_COST = 5;
const MIN_EXPRESS_CREDIT_COST = 5;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;
const DEFAULT_X402_SCHEME = "exact";
const DEFAULT_X402_ASSET = "USDC";
const DEFAULT_X402_DECIMALS = 6;
const DEFAULT_X402_MAX_AMOUNT_ATOMIC = 100_000n;
const DEFAULT_ACTIVATE_CANARY_PATH = "/health";
const DEFAULT_ACTIVATE_CANARY_METHOD = "GET";
const DEFAULT_ACTIVATE_SIGNER_LABEL = "sdk-auto";
const MERCHANT_GATEWAY_AUTH_SCOPE = "agent_gateway" as const;
const MERCHANT_GATEWAY_AUTH_VERSION = "1" as const;

const ACCESS_TYPES = {
  Access: [
    { name: "service", type: "string" },
    { name: "timestamp", type: "uint256" },
    { name: "nonce", type: "string" },
  ],
} as const;

const normalizeBaseUrl = (value: string): string => value.replace(/\/+$/, "");

const normalizeOptionalString = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const normalizeJsonValue = (value: unknown): unknown => {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("GhostWire request metadata contains a non-finite number.");
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeJsonValue);
  }
  if (typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        result[key] = normalizeJsonValue((value as Record<string, unknown>)[key]);
        return result;
      }, {});
  }
  throw new Error("GhostWire request metadata must be valid JSON data.");
};

const normalizeGhostWireRequestPayload = (
  value: GhostWireRequestPayload | null | undefined,
): GhostWireRequestPayload | null => {
  if (!value || typeof value !== "object") return null;
  const prompt = normalizeOptionalString(value.prompt);
  if (!prompt) {
    throw new Error("GhostWire request.prompt must be a non-empty string.");
  }

  const walletAddress = normalizeOptionalString(value.walletAddress ?? null);
  const normalizedMetadata =
    Object.prototype.hasOwnProperty.call(value, "metadata") ? normalizeJsonValue(value.metadata ?? null) : undefined;

  return {
    version: 1,
    prompt,
    ...(walletAddress ? { walletAddress } : {}),
    ...(normalizedMetadata !== undefined ? { metadata: normalizedMetadata as Record<string, unknown> | null } : {}),
  };
};

const canonicalizeGhostWireRequestPayload = (value: GhostWireRequestPayload): string => {
  const normalized = normalizeGhostWireRequestPayload(value);
  if (!normalized) {
    throw new Error("GhostWire request payload is required.");
  }

  return JSON.stringify({
    version: 1,
    prompt: normalized.prompt,
    ...(normalized.walletAddress ? { walletAddress: normalized.walletAddress } : {}),
    ...(normalized.metadata !== undefined ? { metadata: normalized.metadata } : {}),
  });
};

export const buildGhostWireRequestSpecHash = (value: GhostWireRequestPayload): `0x${string}` =>
  keccak256(toHex(canonicalizeGhostWireRequestPayload(value)));

const getApiKeyPrefix = (apiKey: string): string => {
  if (apiKey.length <= 8) return apiKey;
  return `${apiKey.slice(0, 8)}...`;
};

const parsePayload = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

const parseTextPayload = async (response: Response): Promise<string | null> => {
  try {
    return await response.text();
  } catch {
    return null;
  }
};

const deriveAgentId = (serviceSlug: string | null): string | null => {
  if (!serviceSlug) return null;
  const match = /^agent-(.+)$/i.exec(serviceSlug);
  return match?.[1] ?? null;
};

const resolveWireDeliverableLocator = (job: WireJobSnapshot): string | null => {
  const summaryLocator = normalizeOptionalString(job.deliverable?.locatorUrl ?? null);
  if (summaryLocator) return summaryLocator;

  const metadataLocator = normalizeOptionalString(job.metadataUri);
  if (!metadataLocator) return null;

  try {
    const parsed = new URL(metadataLocator);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
};

const toOptionalMetadata = (value: Record<string, unknown> | undefined): Record<string, unknown> | undefined =>
  value && Object.keys(value).length > 0 ? value : undefined;

const assertTelemetryIdentity = (input: {
  apiKey: string | null;
  agentId: string | null;
  serviceSlug: string | null;
}): void => {
  if (input.apiKey || input.agentId || input.serviceSlug) return;
  throw new Error("Telemetry calls require at least one of apiKey, agentId, or serviceSlug.");
};

const normalizeTelemetryStatusCode = (value: number | null | undefined): number | null => {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < 100 || value > 599) {
    throw new Error("statusCode must be an integer in the HTTP status range.");
  }
  return value;
};

const buildCanaryHeaders = (): Record<string, string> => ({
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
});

const CHAIN_ID_TO_X402_NETWORK: Partial<Record<number, X402Network>> = {
  8453: "base",
  84532: "base-sepolia",
};
const HEXISH_PATTERN = /^0x[a-fA-F0-9]+$/;

const assertPrivateKey = (value: `0x${string}` | null | undefined, name: string): `0x${string}` => {
  if (!value || !/^0x[a-fA-F0-9]{64}$/.test(value)) {
    throw new Error(`${name} must be a 0x-prefixed 32-byte hex private key.`);
  }
  return value;
};

const normalizeAddressLower = (value: string): string => value.trim().toLowerCase();

const normalizePositiveBigInt = (
  value: bigint | number | string | null | undefined,
  fallback: bigint,
  fieldName: string,
): bigint => {
  if (value == null) return fallback;
  if (typeof value === "bigint") {
    if (value <= 0n) throw new Error(`${fieldName} must be positive.`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
      throw new Error(`${fieldName} must be a positive integer.`);
    }
    return BigInt(value);
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${fieldName} must be a positive integer string.`);
  }
  const normalized = BigInt(trimmed);
  if (normalized <= 0n) {
    throw new Error(`${fieldName} must be positive.`);
  }
  return normalized;
};

const resolveX402Network = (network: X402Network | null | undefined, chainId: number): X402Network => {
  if (network) return network;
  const inferred = CHAIN_ID_TO_X402_NETWORK[chainId];
  if (inferred) return inferred;
  throw new Error(`Unsupported chainId ${chainId} for requestX402(). Pass network explicitly.`);
};

const normalizeX402Timestamp = (value: string | Date | null | undefined): string =>
  value instanceof Date ? value.toISOString() : normalizeOptionalString(value) ?? new Date().toISOString();

const normalizeOptionalIntegerRange = (
  value: number | null | undefined,
  fieldName: string,
  minimum: number,
  maximum: number,
): number | null => {
  if (value == null) return null;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${fieldName} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
};

const normalizePaymentReference = (value: string | null | undefined): string | null => {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return null;
  return HEXISH_PATTERN.test(normalized) ? normalized.toLowerCase() : normalized;
};

export const createSettlementEvidence = (input: SettlementEvidenceInput): SettlementEvidence => {
  const requestId = normalizeOptionalString(input.requestId);
  const rawPaymentReference = normalizeOptionalString(input.paymentReference);
  const payerIdentity = normalizeOptionalString(input.payerIdentity);
  const payerAddress = normalizeOptionalString(input.payerAddress ?? null);
  const scheme = normalizeOptionalString(input.scheme) ?? DEFAULT_X402_SCHEME;
  const network = normalizeOptionalString(input.network ?? null);
  const chainId = normalizeOptionalIntegerRange(input.chainId ?? null, "chainId", 1, 100_000_000);
  const asset = (normalizeOptionalString(input.asset) ?? DEFAULT_X402_ASSET).toUpperCase();
  if (input.amountAtomic == null) {
    throw new Error("SettlementEvidence(amountAtomic) requires a positive amountAtomic.");
  }
  const amountAtomic = normalizePositiveBigInt(input.amountAtomic, 1n, "amountAtomic");
  const decimals =
    normalizeOptionalIntegerRange(input.decimals ?? null, "decimals", 0, 18) ?? DEFAULT_X402_DECIMALS;
  const statusCode = normalizeOptionalIntegerRange(input.statusCode ?? null, "statusCode", 100, 599);
  const latencyMs = normalizeOptionalIntegerRange(input.latencyMs ?? null, "latencyMs", 0, 60 * 60 * 1000);
  const occurredAt = normalizeX402Timestamp(input.occurredAt);
  const metadata = toOptionalMetadata(input.metadata);
  const paymentReference = normalizePaymentReference(rawPaymentReference);

  if (!requestId) throw new Error("SettlementEvidence(requestId) requires a non-empty requestId.");
  if (!paymentReference) {
    throw new Error("SettlementEvidence(paymentReference) requires a non-empty paymentReference.");
  }
  if (!payerIdentity) throw new Error("SettlementEvidence(payerIdentity) requires a non-empty payerIdentity.");

  return {
    requestId,
    paymentReference,
    payerIdentity,
    payerAddress: payerAddress ? normalizeAddressLower(payerAddress) : null,
    scheme: scheme.toLowerCase(),
    network,
    chainId,
    asset,
    amountAtomic: amountAtomic.toString(),
    decimals,
    success: Boolean(input.success),
    statusCode,
    latencyMs,
    occurredAt,
    ...(metadata ? { metadata } : {}),
  };
};

const getX402ReportingRuntimeSupport = (
  runtime: X402SettlementReporterRuntime,
): X402ReporterRuntimeSupport => {
  const supportedRuntime = X402_REPORTING_RUNTIME_SUPPORT.find((entry) => entry.runtime === runtime);
  if (!supportedRuntime) {
    throw new Error(`Unsupported x402 reporting runtime: ${runtime}`);
  }
  return supportedRuntime;
};

const normalizePositiveInteger = (value: number | null | undefined, fieldName: string, fallback: number): number => {
  if (value == null) return fallback;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }
  return value;
};

const normalizeRetryDelaysMs = (value: readonly number[] | undefined): number[] => {
  if (!value) return [...DEFAULT_X402_REPORTER_RETRY_DELAYS_MS];
  return value.map((delayMs, index) => {
    if (!Number.isFinite(delayMs) || !Number.isInteger(delayMs) || delayMs < 0) {
      throw new Error(`retryDelaysMs[${index}] must be a non-negative integer.`);
    }
    return delayMs;
  });
};

const sleep = async (durationMs: number): Promise<void> => {
  if (durationMs <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, durationMs));
};

const buildSettlementReporterIdentity = (
  input: X402SettlementReporterObservedPayment,
): X402SettlementReporterObservedPayment & { dedupeKey: string } => {
  const agentId = normalizeOptionalString(input.agentId);
  const serviceSlug = normalizeOptionalString(input.serviceSlug);
  const requestId = normalizeOptionalString(input.requestId);
  const paymentReference = normalizePaymentReference(input.paymentReference);

  if (!agentId) {
    throw new Error("x402 settlement reporter requires a non-empty agentId.");
  }
  if (!serviceSlug) {
    throw new Error("x402 settlement reporter requires a non-empty serviceSlug.");
  }
  if (!requestId) {
    throw new Error("x402 settlement reporter requires a non-empty requestId.");
  }
  if (!paymentReference) {
    throw new Error("x402 settlement reporter requires a non-empty paymentReference.");
  }

  return {
    agentId,
    serviceSlug,
    requestId,
    paymentReference,
    dedupeKey: `${agentId}:${paymentReference}`,
  };
};

const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  const normalized = normalizeOptionalString(typeof error === "string" ? error : null);
  return normalized ?? "Unknown x402 reporting error.";
};

const buildSettlementReporterInput = (
  input: X402SettlementReportInput,
): { dedupeKey: string; normalizedInput: X402SettlementReportInput } => {
  const evidence = createSettlementEvidence(input);
  const identity = buildSettlementReporterIdentity({
    agentId: input.agentId,
    serviceSlug: input.serviceSlug,
    requestId: evidence.requestId,
    paymentReference: evidence.paymentReference,
  });

  return {
    dedupeKey: identity.dedupeKey,
    normalizedInput: {
      agentId: identity.agentId,
      serviceSlug: identity.serviceSlug,
      requestId: identity.requestId,
      paymentReference: identity.paymentReference,
      payerIdentity: evidence.payerIdentity,
      ...(evidence.payerAddress ? { payerAddress: evidence.payerAddress } : {}),
      scheme: evidence.scheme,
      ...(evidence.network ? { network: evidence.network } : {}),
      ...(evidence.chainId != null ? { chainId: evidence.chainId } : {}),
      asset: evidence.asset,
      amountAtomic: evidence.amountAtomic,
      decimals: evidence.decimals,
      success: evidence.success,
      ...(evidence.statusCode != null ? { statusCode: evidence.statusCode } : {}),
      ...(evidence.latencyMs != null ? { latencyMs: evidence.latencyMs } : {}),
      occurredAt: evidence.occurredAt,
      ...(evidence.metadata ? { metadata: evidence.metadata } : {}),
    },
  };
};

export class X402SettlementReporter {
  private readonly transport: X402SettlementReporterTransport;
  private readonly runtimeSupport: X402ReporterRuntimeSupport;
  private readonly retryDelaysMs: readonly number[];
  private readonly maxQueueSize: number;
  private readonly onEvent?: (event: X402SettlementReporterEvent) => void;
  private readonly queue: X402SettlementReporterQueueEntry[] = [];
  private readonly dedupeKeys = new Set<string>();
  private readonly counters: X402SettlementReporterCounters = {
    paymentVerified: 0,
    reportEnqueued: 0,
    duplicate: 0,
    reportSent: 0,
    reportAccepted: 0,
    reportDropped: 0,
  };
  private lastError: string | null = null;
  private drainPromise: Promise<void> | null = null;

  constructor(transport: X402SettlementReporterTransport, config: X402SettlementReporterConfig) {
    this.transport = transport;
    this.runtimeSupport = getX402ReportingRuntimeSupport(config.runtime);
    this.onEvent = config.onEvent;
    this.maxQueueSize = normalizePositiveInteger(
      config.maxQueueSize ?? null,
      "X402SettlementReporter.maxQueueSize",
      DEFAULT_X402_REPORTER_MAX_QUEUE_SIZE,
    );
    this.retryDelaysMs =
      this.runtimeSupport.support === "first_class"
        ? normalizeRetryDelaysMs(config.retryDelaysMs)
        : [];
  }

  recordPaymentVerified(input: X402SettlementReporterObservedPayment): { dedupeKey: string } {
    const identity = buildSettlementReporterIdentity(input);
    this.counters.paymentVerified += 1;
    this.emitEvent({
      name: "payment_verified",
      ...identity,
    });
    return {
      dedupeKey: identity.dedupeKey,
    };
  }

  recordDropped(input: X402SettlementReporterObservedPayment, error: unknown): { dedupeKey: string } {
    const identity = buildSettlementReporterIdentity(input);
    const message = toErrorMessage(error);
    this.lastError = message;
    this.counters.reportDropped += 1;
    this.emitEvent({
      name: "report_dropped",
      ...identity,
      error: message,
    });
    return {
      dedupeKey: identity.dedupeKey,
    };
  }

  enqueue(input: X402SettlementReportInput): X402SettlementReporterEnqueueResult {
    const { dedupeKey, normalizedInput } = buildSettlementReporterInput(input);
    const mode: X402SettlementReporterMode =
      this.runtimeSupport.support === "manual_only"
        ? "manual_only"
        : this.runtimeSupport.support === "best_effort"
          ? "best_effort"
          : "queued";

    if (this.runtimeSupport.support === "manual_only") {
      return {
        accepted: false,
        duplicate: false,
        mode,
        requiresManualReporting: true,
        dedupeKey,
        queueSize: this.queue.length,
      };
    }

    if (this.dedupeKeys.has(dedupeKey)) {
      this.counters.duplicate += 1;
      this.emitEvent({
        name: "duplicate",
        agentId: normalizedInput.agentId,
        serviceSlug: normalizedInput.serviceSlug,
        requestId: normalizedInput.requestId,
        paymentReference: normalizedInput.paymentReference,
        dedupeKey,
      });
      return {
        accepted: false,
        duplicate: true,
        mode,
        requiresManualReporting: false,
        dedupeKey,
        queueSize: this.queue.length,
      };
    }

    if (this.queue.length >= this.maxQueueSize) {
      this.lastError = `X402SettlementReporter queue is full (maxQueueSize=${this.maxQueueSize}).`;
      this.counters.reportDropped += 1;
      this.emitEvent({
        name: "report_dropped",
        agentId: normalizedInput.agentId,
        serviceSlug: normalizedInput.serviceSlug,
        requestId: normalizedInput.requestId,
        paymentReference: normalizedInput.paymentReference,
        dedupeKey,
        error: this.lastError,
      });
      return {
        accepted: false,
        duplicate: false,
        mode,
        requiresManualReporting: false,
        dedupeKey,
        queueSize: this.queue.length,
      };
    }

    this.dedupeKeys.add(dedupeKey);
    this.queue.push({
      dedupeKey,
      input: normalizedInput,
      attempt: 0,
      nextAttemptAt: Date.now(),
    });
    this.counters.reportEnqueued += 1;
    this.emitEvent({
      name: "report_enqueued",
      agentId: normalizedInput.agentId,
      serviceSlug: normalizedInput.serviceSlug,
      requestId: normalizedInput.requestId,
      paymentReference: normalizedInput.paymentReference,
      dedupeKey,
    });
    this.ensureDrain();

    return {
      accepted: true,
      duplicate: false,
      mode,
      requiresManualReporting: false,
      dedupeKey,
      queueSize: this.queue.length,
    };
  }

  async flush(): Promise<void> {
    if (this.runtimeSupport.support === "manual_only") return;

    while (this.queue.length > 0 || this.drainPromise) {
      this.ensureDrain();
      if (!this.drainPromise) break;
      await this.drainPromise;
    }
  }

  getSnapshot(): X402SettlementReporterSnapshot {
    return {
      runtime: this.runtimeSupport.runtime,
      support: this.runtimeSupport.support,
      durability: this.runtimeSupport.durability,
      queueSize: this.queue.length,
      processing: this.drainPromise !== null,
      lastError: this.lastError,
      counters: {
        ...this.counters,
      },
    };
  }

  private emitEvent(
    event: Omit<X402SettlementReporterEvent, "runtime" | "support" | "durability" | "occurredAt" | "queueSize">,
  ): void {
    if (!this.onEvent) return;
    try {
      this.onEvent({
        ...event,
        runtime: this.runtimeSupport.runtime,
        support: this.runtimeSupport.support,
        durability: this.runtimeSupport.durability,
        occurredAt: new Date().toISOString(),
        queueSize: this.queue.length,
      });
    } catch {
      // Observability hooks must never block the merchant response path or reporter state machine.
    }
  }

  private ensureDrain(): void {
    if (this.runtimeSupport.support === "manual_only") return;
    if (this.drainPromise || this.queue.length === 0) return;
    this.drainPromise = this.processQueue();
  }

  private async processQueue(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        this.queue.sort((left, right) => left.nextAttemptAt - right.nextAttemptAt);
        const next = this.queue[0];
        if (!next) break;

        const waitMs = next.nextAttemptAt - Date.now();
        if (waitMs > 0) {
          await sleep(Math.min(waitMs, 25));
          continue;
        }

        this.queue.shift();
        await this.sendEntry(next);
      }
    } finally {
      this.drainPromise = null;
      if (this.queue.length > 0) {
        this.ensureDrain();
      }
    }
  }

  private async sendEntry(entry: X402SettlementReporterQueueEntry): Promise<void> {
    try {
      this.counters.reportSent += 1;
      this.emitEvent({
        name: "report_sent",
        agentId: entry.input.agentId,
        serviceSlug: entry.input.serviceSlug,
        requestId: entry.input.requestId,
        paymentReference: entry.input.paymentReference,
        dedupeKey: entry.dedupeKey,
        attempt: entry.attempt + 1,
      });
      const result = await this.transport.reportX402Settlement(entry.input);
      if (!result.ok) {
        throw new Error(`Ghost settlement report failed with status ${result.status}.`);
      }
      this.lastError = null;
      this.counters.reportAccepted += 1;
      this.emitEvent({
        name: "report_accepted",
        agentId: entry.input.agentId,
        serviceSlug: entry.input.serviceSlug,
        requestId: entry.input.requestId,
        paymentReference: entry.input.paymentReference,
        dedupeKey: entry.dedupeKey,
        attempt: entry.attempt + 1,
        status: result.status,
        countedForRank: result.countedForRank,
        relatedParty: result.relatedParty,
        serverDuplicate: result.duplicate,
      });
      this.dedupeKeys.delete(entry.dedupeKey);
    } catch (error) {
      const message = toErrorMessage(error);
      this.lastError = message;
      const retryDelayMs = this.retryDelaysMs[entry.attempt] ?? null;
      if (retryDelayMs == null) {
        this.counters.reportDropped += 1;
        this.emitEvent({
          name: "report_dropped",
          agentId: entry.input.agentId,
          serviceSlug: entry.input.serviceSlug,
          requestId: entry.input.requestId,
          paymentReference: entry.input.paymentReference,
          dedupeKey: entry.dedupeKey,
          attempt: entry.attempt + 1,
          error: message,
        });
        this.dedupeKeys.delete(entry.dedupeKey);
        return;
      }
      this.queue.push({
        ...entry,
        attempt: entry.attempt + 1,
        nextAttemptAt: Date.now() + retryDelayMs,
      });
    }
  }
}

const GHOST_X402_RAIL_SCHEME = "x402";
const X402_REQUEST_HEADER_NAME = "X-PAYMENT";
const X402_RESPONSE_HEADER_NAME = "X-PAYMENT-RESPONSE";
const X402_PROTOCOL_VERSION = 1;

const encodeSettlementResponseHeader = (response: SettleResponse): string =>
  safeBase64Encode(JSON.stringify(toJsonSafe(response as unknown as object)));

const normalizePaymentRequirementsList = (
  value: PaymentRequirements | readonly PaymentRequirements[],
): PaymentRequirements[] => {
  const normalized = Array.isArray(value) ? [...value] : [value];
  if (normalized.length === 0) {
    throw new Error("Ghost x402 adapters require at least one payment requirement.");
  }
  return normalized;
};

const decodePaymentHeader = (paymentHeader: string): PaymentPayload => {
  const decoded = safeBase64Decode(paymentHeader);
  const parsed = JSON.parse(decoded) as unknown;
  return PaymentPayloadSchema.parse(parsed);
};

const createPaymentRequiredResponse = (
  accepts: PaymentRequirements[],
  error?: string | null,
  payer?: string | null,
): Response =>
  Response.json(
    {
      x402Version: X402_PROTOCOL_VERSION,
      ...(normalizeOptionalString(error ?? null) ? { error: normalizeOptionalString(error ?? null) } : {}),
      accepts,
      ...(normalizeOptionalString(payer ?? null) ? { payer: normalizeOptionalString(payer ?? null) } : {}),
    },
    {
      status: 402,
      headers: {
        "cache-control": "no-store",
      },
    },
  );

const createPaymentInfrastructureErrorResponse = (
  accepts: PaymentRequirements[],
  error: string,
  payer?: string | null,
): Response =>
  Response.json(
    {
      x402Version: X402_PROTOCOL_VERSION,
      error,
      accepts,
      ...(normalizeOptionalString(payer ?? null) ? { payer: normalizeOptionalString(payer ?? null) } : {}),
    },
    {
      status: 502,
      headers: {
        "cache-control": "no-store",
      },
    },
  );

const appendHeaderToken = (headers: Headers, name: string, token: string): void => {
  const existing = headers.get(name);
  if (!existing) {
    headers.set(name, token);
    return;
  }
  const tokens = existing
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (tokens.some((value) => value.toLowerCase() === token.toLowerCase())) {
    headers.set(name, tokens.join(", "));
    return;
  }
  headers.set(name, [...tokens, token].join(", "));
};

const withSettlementResponseHeaders = (response: Response, settleResult: SettleResponse): Response => {
  const headers = new Headers(response.headers);
  headers.set(X402_RESPONSE_HEADER_NAME, encodeSettlementResponseHeader(settleResult));
  appendHeaderToken(headers, "Access-Control-Expose-Headers", X402_RESPONSE_HEADER_NAME);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const isReadableStream = (value: unknown): value is ReadableStream =>
  typeof ReadableStream !== "undefined" && value instanceof ReadableStream;

const toHandlerResponse = async (value: GhostX402HandlerResult): Promise<Response> => {
  if (value instanceof Response) return value;
  if (value == null) return new Response(null, { status: 204 });
  if (
    typeof value === "string" ||
    value instanceof Blob ||
    value instanceof FormData ||
    value instanceof URLSearchParams ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    isReadableStream(value)
  ) {
    return new Response(value);
  }
  return Response.json(value);
};

const buildAbsoluteRequestUrl = (input: {
  url?: string;
  protocol?: string;
  headers?: Record<string, string | string[] | undefined>;
}): string => {
  const rawUrl = normalizeOptionalString(input.url) ?? "/";
  try {
    return new URL(rawUrl).toString();
  } catch {
    const hostHeader = input.headers?.host;
    const host =
      typeof hostHeader === "string"
        ? hostHeader
        : Array.isArray(hostHeader) && hostHeader.length > 0
          ? hostHeader[0]!
          : "localhost";
    const protocol = normalizeOptionalString(input.protocol) ?? "http";
    const path = rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`;
    return `${protocol}://${host}${path}`;
  }
};

const normalizeNodeLikeHeaders = (
  headers: Record<string, string | string[] | undefined> | undefined,
): Record<string, string> => {
  if (!headers) return {};
  return Object.entries(headers).reduce<Record<string, string>>((result, [name, value]) => {
    if (typeof value === "string" && value.length > 0) {
      result[name] = value;
      return result;
    }
    if (Array.isArray(value) && value.length > 0) {
      result[name] = value.join(", ");
    }
    return result;
  }, {});
};

const createNodeLikeRequest = (input: {
  method?: string;
  url?: string;
  protocol?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
}): Request => {
  const method = normalizeOptionalString(input.method)?.toUpperCase() ?? "GET";
  const url = buildAbsoluteRequestUrl(input);
  const headers = normalizeNodeLikeHeaders(input.headers);

  if (method === "GET" || method === "HEAD" || input.body == null) {
    return new Request(url, {
      method,
      headers,
    });
  }

  if (
    typeof input.body === "string" ||
    input.body instanceof ArrayBuffer ||
    ArrayBuffer.isView(input.body) ||
    input.body instanceof Blob ||
    input.body instanceof FormData ||
    input.body instanceof URLSearchParams ||
    isReadableStream(input.body)
  ) {
    return new Request(url, {
      method,
      headers,
      body: input.body as BodyInit,
    });
  }

  const nextHeaders = { ...headers };
  if (!Object.keys(nextHeaders).some((key) => key.toLowerCase() === "content-type")) {
    nextHeaders["content-type"] = "application/json";
  }

  return new Request(url, {
    method,
    headers: nextHeaders,
    body: JSON.stringify(input.body),
  });
};

const responseHasBody = (response: Response): boolean => response.status !== 204 && response.status !== 205 && response.status !== 304;

const readNodeResponsePayload = async (
  response: Response,
): Promise<{ text: string | null; parsed: unknown; buffer: Buffer | null }> => {
  if (!responseHasBody(response)) {
    return {
      text: null,
      parsed: null,
      buffer: null,
    };
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) {
    return {
      text: "",
      parsed: "",
      buffer,
    };
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("application/json")) {
    const text = buffer.toString("utf8");
    return {
      text,
      parsed: JSON.parse(text),
      buffer,
    };
  }
  if (contentType.startsWith("text/") || contentType.includes("javascript") || contentType.includes("xml")) {
    const text = buffer.toString("utf8");
    return {
      text,
      parsed: text,
      buffer,
    };
  }
  return {
    text: null,
    parsed: buffer,
    buffer,
  };
};

const writeExpressLikeResponse = async (response: Response, res: GhostX402ExpressLikeResponse): Promise<void> => {
  if (typeof res.status === "function") {
    res.status(response.status);
  } else {
    (res as { statusCode?: number }).statusCode = response.status;
  }
  response.headers.forEach((value, name) => {
    res.setHeader?.(name, value);
  });

  if (!responseHasBody(response)) {
    res.end?.();
    return;
  }

  const payload = await readNodeResponsePayload(response);
  if (typeof res.send === "function") {
    res.send(payload.text ?? payload.buffer ?? "");
    return;
  }
  res.end?.(payload.text ?? payload.buffer ?? undefined);
};

const writeFastifyLikeResponse = async (response: Response, reply: GhostX402FastifyLikeReply): Promise<void> => {
  if (typeof reply.code === "function") {
    reply.code(response.status);
  } else {
    (reply as { statusCode?: number }).statusCode = response.status;
  }
  response.headers.forEach((value, name) => {
    reply.header?.(name, value);
  });

  if (!responseHasBody(response)) {
    reply.send?.(null);
    return;
  }

  const payload = await readNodeResponsePayload(response);
  reply.send?.(payload.parsed);
};

const resolveSettlementReporter = (
  merchant: GhostMerchant,
  runtime: X402SettlementReporterRuntime,
  reporter: X402SettlementReporter | undefined,
  reporterConfig: Omit<X402SettlementReporterConfig, "runtime"> | undefined,
): X402SettlementReporter =>
  reporter ??
  merchant.createX402SettlementReporter({
    runtime,
    ...reporterConfig,
  });

const resolveAdapterReportingRuntime = <TContext>(
  config: GhostX402AdapterConfig<TContext>,
  fallback: GhostX402AdapterRuntime,
): X402SettlementReporterRuntime => config.reportingRuntime ?? fallback;

const resolveSettlementAsset = (
  paymentRequirement: PaymentRequirements,
): { asset: string; decimals: number } => {
  const extra = paymentRequirement.extra ?? {};
  try {
    const defaultAsset = getDefaultAsset(paymentRequirement.network);
    const requirementAsset = normalizeOptionalString(String(paymentRequirement.asset))?.toLowerCase();
    const defaultAssetAddress = normalizeOptionalString(String(defaultAsset.address))?.toLowerCase();
    if (requirementAsset && defaultAssetAddress && requirementAsset === defaultAssetAddress) {
      return {
        asset: DEFAULT_X402_ASSET,
        decimals: defaultAsset.decimals,
      };
    }
  } catch {
    // Ignore unsupported-network inference and fall back to the raw requirement asset.
  }

  return {
    asset: String(paymentRequirement.asset),
    decimals:
      typeof extra.decimals === "number" && Number.isFinite(extra.decimals) ? Math.trunc(extra.decimals) : DEFAULT_X402_DECIMALS,
  };
};

const resolveServiceSlug = <TContext>(config: GhostX402AdapterConfig<TContext>): string => {
  const configured = normalizeOptionalString(config.serviceSlug);
  if (configured) return configured;
  return config.merchant.serviceSlug;
};

const defaultVerifyPayment: GhostX402VerifyPayment = async ({ client, paymentPayload, paymentRequirements }) =>
  verifyX402Payment(client, paymentPayload, paymentRequirements);

const defaultSettlePayment: GhostX402SettlePayment = async ({ client, paymentPayload, paymentRequirements }) =>
  settleX402Payment(client, paymentPayload, paymentRequirements);

const executeGhostX402Adapter = async <TContext>(
  config: GhostX402AdapterConfig<TContext>,
  request: Request,
  context: TContext,
  handler: (args: GhostX402AdapterCallbackArgs<TContext>) => Promise<GhostX402HandlerResult> | GhostX402HandlerResult,
): Promise<Response> => {
  const accepts = normalizePaymentRequirementsList(config.paymentRequirements);
  const paymentHeader = normalizeOptionalString(request.headers.get(X402_REQUEST_HEADER_NAME));
  if (!paymentHeader) {
    return createPaymentRequiredResponse(accepts);
  }
  const startedAt = Date.now();

  const decodeHeader = config.decodePaymentHeader ?? decodePaymentHeader;
  const verifyPayment = config.verifyPayment ?? defaultVerifyPayment;
  const settlePayment = config.settlePayment ?? defaultSettlePayment;

  let paymentPayload: PaymentPayload;
  try {
    paymentPayload = decodeHeader(paymentHeader);
  } catch {
    return createPaymentRequiredResponse(accepts, "invalid_payload");
  }

  const paymentRequirement = (findMatchingPaymentRequirements(accepts, paymentPayload) as PaymentRequirements | undefined) ?? null;
  if (!paymentRequirement) {
    return createPaymentRequiredResponse(accepts, "invalid_payment_requirements");
  }

  let verifyResult: VerifyResponse;
  try {
    verifyResult = await verifyPayment({
      client: config.x402Client,
      paymentPayload,
      paymentRequirements: paymentRequirement,
    });
  } catch {
    return createPaymentInfrastructureErrorResponse(accepts, "unexpected_verify_error");
  }
  if (!verifyResult.isValid) {
    return createPaymentRequiredResponse(accepts, verifyResult.invalidReason ?? "invalid_payment", verifyResult.payer ?? null);
  }

  let settleResult: SettleResponse;
  try {
    settleResult = await settlePayment({
      client: config.x402Client,
      paymentPayload,
      paymentRequirements: paymentRequirement,
    });
  } catch {
    return createPaymentInfrastructureErrorResponse(
      accepts,
      "unexpected_settle_error",
      verifyResult.payer ?? null,
    );
  }
  if (!settleResult.success) {
    return createPaymentRequiredResponse(
      accepts,
      settleResult.errorReason ?? "unexpected_settle_error",
      settleResult.payer ?? verifyResult.payer ?? null,
    );
  }

  const requestId =
    normalizeOptionalString(
      config.getRequestId?.({
        request,
        context,
        paymentPayload,
        paymentRequirements: paymentRequirement,
      }) ?? null,
    ) ?? randomUUID();
  const defaultPayerIdentity =
    normalizeOptionalString(String(settleResult.payer ?? verifyResult.payer ?? "")) ?? "payer_unavailable";
  const defaultPayerAddress = normalizeOptionalString(String(settleResult.payer ?? verifyResult.payer ?? ""));
  const payerArgs: GhostX402PayerResolverArgs<TContext> = {
    request,
    context,
    paymentPayload,
    paymentRequirements: paymentRequirement,
    verifyResult,
    settleResult,
  };
  const payerIdentity =
    normalizeOptionalString((await config.getPayerIdentity?.(payerArgs)) ?? null) ?? defaultPayerIdentity;
  const payerAddress =
    normalizeOptionalString((await config.getPayerAddress?.(payerArgs)) ?? null) ?? defaultPayerAddress ?? null;
  const paymentReference = normalizeOptionalString(String(settleResult.transaction ?? "")) ?? requestId;
  const serviceSlug = resolveServiceSlug(config);
  const x402: GhostX402ResolvedPayment = {
    requestId,
    paymentReference,
    paymentRequirements: paymentRequirement,
    paymentPayload,
    verifyResult,
    settleResult,
    payerIdentity,
    payerAddress,
  };

  const reporter = config.reporter;
  if (reporter) {
    try {
      reporter.recordPaymentVerified({
        agentId: config.agentId,
        serviceSlug,
        requestId,
        paymentReference,
      });
    } catch {
      // Observability must never block the paid request path.
    }
  }

  let handlerResponse: Response;
  try {
    handlerResponse = await toHandlerResponse(
      await handler({
        request,
        context,
        x402,
      }),
    );
  } catch {
    handlerResponse = Response.json({ error: "internal_server_error" }, { status: 500 });
  }

  const response = withSettlementResponseHeaders(handlerResponse, settleResult);
  const occurredAt = new Date().toISOString();
  const latencyMs = Math.max(0, Date.now() - startedAt);
  const { asset, decimals } = resolveSettlementAsset(paymentRequirement);
  const chainId = getNetworkId(paymentRequirement.network);

  if (reporter) {
    void (async () => {
      try {
        const metadata = config.getMetadata
          ? await config.getMetadata({
              ...payerArgs,
              response,
            })
          : undefined;

        reporter.enqueue({
          agentId: config.agentId,
          serviceSlug,
          requestId,
          paymentReference,
          payerIdentity,
          ...(payerAddress ? { payerAddress } : {}),
          scheme: GHOST_X402_RAIL_SCHEME,
          network: paymentRequirement.network,
          chainId,
          asset,
          amountAtomic: paymentRequirement.maxAmountRequired,
          decimals,
          success: response.status < 400,
          statusCode: response.status,
          latencyMs,
          occurredAt,
          ...(toOptionalMetadata(metadata) ? { metadata } : {}),
        });
      } catch (error) {
        try {
          reporter.recordDropped(
            {
              agentId: config.agentId,
              serviceSlug,
              requestId,
              paymentReference,
            },
            error,
          );
        } catch {
          // Reporting is best-effort and must never block the merchant response path.
        }
      }
    })();
  }

  return response;
};

export const withGhostX402NextNode = <TContext = unknown>(
  config: GhostX402AdapterConfig<TContext>,
  handler: (args: GhostX402AdapterCallbackArgs<TContext>) => Promise<GhostX402HandlerResult> | GhostX402HandlerResult,
) => {
  const adapterConfig = {
    ...config,
    reporter: resolveSettlementReporter(
      config.merchant,
      resolveAdapterReportingRuntime(config, "next_node"),
      config.reporter,
      config.reporterConfig,
    ),
  } satisfies GhostX402AdapterConfig<TContext>;

  return async (request: Request, context: TContext = undefined as TContext): Promise<Response> =>
    executeGhostX402Adapter(adapterConfig, request, context, handler);
};

export const withGhostX402Hono = <TContext extends { req?: { raw?: Request } }>(
  config: GhostX402AdapterConfig<TContext>,
  handler: (args: GhostX402AdapterCallbackArgs<TContext>) => Promise<GhostX402HandlerResult> | GhostX402HandlerResult,
) => {
  const adapterConfig = {
    ...config,
    reporter: resolveSettlementReporter(
      config.merchant,
      resolveAdapterReportingRuntime(config, "node_server"),
      config.reporter,
      config.reporterConfig,
    ),
  } satisfies GhostX402AdapterConfig<TContext>;

  return async (context: TContext): Promise<Response> => {
    const request = context.req?.raw;
    if (!(request instanceof Request)) {
      throw new Error("withGhostX402Hono requires context.req.raw to be a Request.");
    }
    return executeGhostX402Adapter(adapterConfig, request, context, handler);
  };
};

export const withGhostX402Express = <TRequest extends GhostX402ExpressLikeRequest>(
  config: GhostX402AdapterConfig<TRequest>,
  handler: (args: {
    req: TRequest;
    request: Request;
    x402: GhostX402ResolvedPayment;
  }) => Promise<GhostX402HandlerResult> | GhostX402HandlerResult,
) => {
  const adapterConfig = {
    ...config,
    reporter: resolveSettlementReporter(
      config.merchant,
      resolveAdapterReportingRuntime(config, "node_server"),
      config.reporter,
      config.reporterConfig,
    ),
  } satisfies GhostX402AdapterConfig<TRequest>;

  return async (req: TRequest, res: GhostX402ExpressLikeResponse): Promise<void> => {
    const request = createNodeLikeRequest({
      method: req.method,
      url: req.originalUrl ?? req.url,
      protocol: req.protocol,
      headers: req.headers,
      body: req.rawBody ?? req.body,
    });
    const response = await executeGhostX402Adapter(adapterConfig, request, req, ({ request: rawRequest, x402 }) =>
      handler({
        req,
        request: rawRequest,
        x402,
      }),
    );
    await writeExpressLikeResponse(response, res);
  };
};

export const withGhostX402Fastify = <TRequest extends GhostX402FastifyLikeRequest>(
  config: GhostX402AdapterConfig<TRequest>,
  handler: (args: {
    request: TRequest;
    rawRequest: Request;
    x402: GhostX402ResolvedPayment;
  }) => Promise<GhostX402HandlerResult> | GhostX402HandlerResult,
) => {
  const adapterConfig = {
    ...config,
    reporter: resolveSettlementReporter(
      config.merchant,
      resolveAdapterReportingRuntime(config, "node_server"),
      config.reporter,
      config.reporterConfig,
    ),
  } satisfies GhostX402AdapterConfig<TRequest>;

  return async (request: TRequest, reply: GhostX402FastifyLikeReply): Promise<void> => {
    const rawRequest = createNodeLikeRequest({
      method: request.method,
      url: request.url,
      protocol: request.protocol,
      headers: request.headers,
      body: request.rawBody ?? request.body,
    });
    const response = await executeGhostX402Adapter(
      adapterConfig,
      rawRequest,
      request,
      ({ request: normalizedRequest, x402 }) =>
        handler({
          request,
          rawRequest: normalizedRequest,
          x402,
        }),
    );
    await writeFastifyLikeResponse(response, reply);
  };
};

const GHOST_FULFILLMENT_RESPONSE_TICKET_ID_HEADER = "x-ghost-fulfillment-ticket-id" as const;
const GHOST_FULFILLMENT_RESPONSE_DELIVERY_PROOF_ID_HEADER = "x-ghost-fulfillment-delivery-proof-id" as const;

const normalizeGhostHttpMonetizationMethod = (value: string | undefined): string =>
  normalizeOptionalString(value)?.toUpperCase() ?? "GET";

const normalizeGhostHttpMonetizationPath = (value: string): string => {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new Error("ghost.config route path must be a non-empty absolute path.");
  }
  if (!normalized.startsWith("/")) {
    throw new Error(`ghost.config route path must start with '/'. Received: ${value}`);
  }
  if (normalized.includes("?")) {
    throw new Error(`ghost.config route path must not include a query string. Received: ${value}`);
  }
  return normalized;
};

const normalizeGhostHttpEndpointUrl = (value: string | null | undefined): string | null => {
  const normalized = normalizeOptionalString(value ?? null);
  if (!normalized) return null;
  return normalizeBaseUrl(normalized);
};

const normalizeGhostHttpCreditCost = (value: number | null | undefined): number | null => {
  if (value == null) return null;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("ghost.config express.creditCost must be a positive integer when provided.");
  }
  const normalized = Math.trunc(value);
  if (normalized < MIN_EXPRESS_CREDIT_COST) {
    throw new Error(`ghost.config express.creditCost must be at least ${MIN_EXPRESS_CREDIT_COST} credits.`);
  }
  return normalized;
};

const resolveGhostHttpMonetizationSelection = (
  selection: GhostHttpMonetizationRouteSelection,
): { routeId: string; rail: Exclude<GhostHttpMonetizationRail, "hybrid"> | null } => {
  if (typeof selection === "string") {
    const routeId = normalizeOptionalString(selection);
    if (!routeId) {
      throw new Error("ghost.config route selection requires a non-empty route id.");
    }
    return {
      routeId,
      rail: null,
    };
  }

  const routeId = normalizeOptionalString(selection.routeId);
  if (!routeId) {
    throw new Error("ghost.config route selection requires a non-empty routeId.");
  }
  return {
    routeId,
    rail: selection.rail ?? null,
  };
};

const resolveGhostHttpPaymentRequirements = (
  paymentRequirements: PaymentRequirements | readonly PaymentRequirements[],
  endpointUrl: string | null,
  routePath: string,
): PaymentRequirements[] =>
  normalizePaymentRequirementsList(paymentRequirements).map((requirement) => {
    const resource = normalizeOptionalString(requirement.resource);
    if (endpointUrl && resource?.startsWith("/")) {
      return {
        ...requirement,
        resource: new URL(resource, `${endpointUrl}/`).toString(),
      };
    }
    if (endpointUrl && !resource) {
      return {
        ...requirement,
        resource: new URL(routePath, `${endpointUrl}/`).toString(),
      };
    }
    return requirement;
  });

const validateGhostHttpMonetizationConfig = (config: GhostHttpMonetizationConfig): void => {
  if (config.version !== 1) {
    throw new Error(`Unsupported ghost.config version: ${String((config as { version?: unknown }).version ?? "")}`);
  }

  const agentId = normalizeOptionalString(config.service.agentId);
  const serviceSlug = normalizeOptionalString(config.service.serviceSlug);
  if (!agentId) throw new Error("ghost.config service.agentId is required.");
  if (!serviceSlug) throw new Error("ghost.config service.serviceSlug is required.");

  const routeIds = Object.keys(config.routes);
  if (routeIds.length === 0) {
    throw new Error("ghost.config requires at least one route.");
  }

  for (const routeId of routeIds) {
    const routeConfig = config.routes[routeId];
    normalizeGhostHttpMonetizationMethod(routeConfig.method);
    normalizeGhostHttpMonetizationPath(routeConfig.path);
    if (routeConfig.rail === "x402" && !routeConfig.x402) {
      throw new Error(`ghost.config route '${routeId}' is missing x402 configuration.`);
    }
    if (routeConfig.rail === "express" && !routeConfig.express) {
      throw new Error(`ghost.config route '${routeId}' is missing express configuration.`);
    }
    if (routeConfig.rail === "hybrid") {
      if (!routeConfig.x402) {
        throw new Error(`ghost.config route '${routeId}' is missing x402 configuration.`);
      }
      if (!routeConfig.express) {
        throw new Error(`ghost.config route '${routeId}' is missing express configuration.`);
      }
    }
    if (routeConfig.x402) {
      resolveGhostHttpPaymentRequirements(
        routeConfig.x402.paymentRequirements,
        normalizeGhostHttpEndpointUrl(config.service.endpointUrl),
        routeConfig.path,
      );
    }
    if (routeConfig.express) {
      normalizeGhostHttpCreditCost(routeConfig.express.creditCost);
    }
  }
};

const resolveGhostHttpMonetizationRoute = (
  config: GhostHttpMonetizationConfig,
  selection: GhostHttpMonetizationRouteSelection,
): GhostResolvedHttpMonetizationRoute => {
  validateGhostHttpMonetizationConfig(config);

  const agentId = normalizeOptionalString(config.service.agentId)!;
  const serviceSlug = normalizeOptionalString(config.service.serviceSlug)!;

  const endpointUrl = normalizeGhostHttpEndpointUrl(config.service.endpointUrl);
  const { routeId, rail: requestedRail } = resolveGhostHttpMonetizationSelection(selection);
  const routeConfig = config.routes[routeId];
  if (!routeConfig) {
    throw new Error(`ghost.config route '${routeId}' was not found.`);
  }

  const method = normalizeGhostHttpMonetizationMethod(routeConfig.method);
  const path = normalizeGhostHttpMonetizationPath(routeConfig.path);
  const routeRail = routeConfig.rail;

  if (routeRail === "hybrid" && !requestedRail) {
    throw new Error(`ghost.config route '${routeId}' is hybrid and requires an explicit rail selection.`);
  }

  const resolvedRail = routeRail === "hybrid" ? requestedRail : routeRail;
  if (!resolvedRail) {
    throw new Error(`ghost.config route '${routeId}' could not resolve a monetization rail.`);
  }

  if (resolvedRail === "x402") {
    if (!routeConfig.x402) {
      throw new Error(`ghost.config route '${routeId}' is missing x402 configuration.`);
    }
    return {
      id: routeId,
      method,
      path,
      rail: "x402",
      routeRail,
      agentId,
      serviceSlug,
      endpointUrl,
      x402: {
        paymentRequirements: resolveGhostHttpPaymentRequirements(routeConfig.x402.paymentRequirements, endpointUrl, path),
        reportingRuntime: routeConfig.x402.reportingRuntime ?? null,
      },
      express: routeConfig.express
        ? {
            creditCost: normalizeGhostHttpCreditCost(routeConfig.express.creditCost),
          }
        : null,
    };
  }

  if (!routeConfig.express) {
    throw new Error(`ghost.config route '${routeId}' is missing express configuration.`);
  }

  return {
    id: routeId,
    method,
    path,
    rail: "express",
    routeRail,
    agentId,
    serviceSlug,
    endpointUrl,
    x402: routeConfig.x402
      ? {
          paymentRequirements: resolveGhostHttpPaymentRequirements(routeConfig.x402.paymentRequirements, endpointUrl, path),
          reportingRuntime: routeConfig.x402.reportingRuntime ?? null,
        }
      : null,
    express: {
      creditCost: normalizeGhostHttpCreditCost(routeConfig.express.creditCost),
    },
  };
};

const readFulfillmentExpectedBody = async (request: Request): Promise<unknown> => {
  if (request.method === "GET" || request.method === "HEAD") {
    return {};
  }

  const text = await request.text();
  if (!text) {
    return {};
  }

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  return text;
};

const headersToRecord = (headers: Headers): Record<string, string> => {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
};

const readFulfillmentCaptureBody = async (
  response: Response,
): Promise<{ responseBodyJson?: unknown; responseBodyText?: string | null }> => {
  if (!responseHasBody(response)) {
    return {};
  }

  const payload = await readNodeResponsePayload(response);
  if (payload.buffer && payload.text == null) {
    return {};
  }
  if ((response.headers.get("content-type")?.toLowerCase() ?? "").includes("application/json")) {
    return {
      responseBodyJson: payload.parsed,
    };
  }
  return {
    responseBodyText: payload.text,
  };
};

const withFulfillmentCaptureHeaders = (
  response: Response,
  ticketId: string,
  deliveryProofId: string,
): Response => {
  const headers = new Headers(response.headers);
  headers.set(GHOST_FULFILLMENT_RESPONSE_TICKET_ID_HEADER, ticketId);
  headers.set(GHOST_FULFILLMENT_RESPONSE_DELIVERY_PROOF_ID_HEADER, deliveryProofId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const createFulfillmentTicketErrorResponse = (error: unknown): Response =>
  Response.json(
    {
      error: "invalid_fulfillment_ticket",
      ...(normalizeOptionalString(error instanceof Error ? error.message : null) ? { detail: error instanceof Error ? error.message : null } : {}),
    },
    { status: 401 },
  );

const createFulfillmentCaptureErrorResponse = (): Response =>
  Response.json(
    {
      error: "fulfillment_capture_failed",
    },
    { status: 502 },
  );

const executeGhostFulfillmentAdapter = async <TContext>(
  config: GhostFulfillmentAdapterConfig<TContext>,
  request: Request,
  context: TContext,
  handler: (
    args: GhostFulfillmentAdapterCallbackArgs<TContext>,
  ) => Promise<GhostX402HandlerResult> | GhostX402HandlerResult,
): Promise<Response> => {
  const startedAt = Date.now();
  const requestUrl = new URL(request.url);
  const expectedRequest = request.clone();

  let fulfillment: VerifiedFulfillmentTicket;
  try {
    fulfillment = await config.merchant.requireFulfillmentTicket({
      headers: headersToRecord(request.headers),
      expected: {
        serviceSlug: config.serviceSlug,
        method: config.method,
        path: config.path,
        query: requestUrl.search.startsWith("?") ? requestUrl.search.slice(1) : requestUrl.search,
        body: await readFulfillmentExpectedBody(expectedRequest),
        ...(config.creditCost != null ? { cost: config.creditCost } : {}),
      },
    });
  } catch (error) {
    return createFulfillmentTicketErrorResponse(error);
  }

  let handlerResponse: Response;
  try {
    handlerResponse = await toHandlerResponse(
      await handler({
        request,
        context,
        fulfillment,
      }),
    );
  } catch {
    handlerResponse = Response.json({ error: "internal_server_error" }, { status: 500 });
  }

  const latencyMs = Math.max(0, Date.now() - startedAt);
  const captureBody = await readFulfillmentCaptureBody(handlerResponse.clone());

  try {
    const captureResult = await config.merchant.captureCompletion({
      ticketId: fulfillment.ticketId,
      serviceSlug: config.serviceSlug,
      statusCode: handlerResponse.status,
      latencyMs,
      ...(captureBody.responseBodyJson !== undefined ? { responseBodyJson: captureBody.responseBodyJson } : {}),
      ...(captureBody.responseBodyText !== undefined ? { responseBodyText: captureBody.responseBodyText } : {}),
    });
    return withFulfillmentCaptureHeaders(
      handlerResponse,
      fulfillment.ticketId,
      String(captureResult.debug.deliveryProofId),
    );
  } catch {
    return createFulfillmentCaptureErrorResponse();
  }
};

const withGhostFulfillmentNextNode = <TContext = unknown>(
  config: GhostFulfillmentAdapterConfig<TContext>,
  handler: (
    args: GhostFulfillmentAdapterCallbackArgs<TContext>,
  ) => Promise<GhostX402HandlerResult> | GhostX402HandlerResult,
) => async (request: Request, context: TContext = undefined as TContext): Promise<Response> =>
  executeGhostFulfillmentAdapter(config, request, context, handler);

const withGhostFulfillmentHono = <TContext extends { req?: { raw?: Request } }>(
  config: GhostFulfillmentAdapterConfig<TContext>,
  handler: (
    args: GhostFulfillmentAdapterCallbackArgs<TContext>,
  ) => Promise<GhostX402HandlerResult> | GhostX402HandlerResult,
) => {
  return async (context: TContext): Promise<Response> => {
    const request = context.req?.raw;
    if (!(request instanceof Request)) {
      throw new Error("withGhostFulfillmentHono requires context.req.raw to be a Request.");
    }
    return executeGhostFulfillmentAdapter(config, request, context, handler);
  };
};

const withGhostFulfillmentExpress = <TRequest extends GhostX402ExpressLikeRequest>(
  config: GhostFulfillmentAdapterConfig<TRequest>,
  handler: (args: {
    req: TRequest;
    request: Request;
    fulfillment: VerifiedFulfillmentTicket;
  }) => Promise<GhostX402HandlerResult> | GhostX402HandlerResult,
) => {
  return async (req: TRequest, res: GhostX402ExpressLikeResponse): Promise<void> => {
    const request = createNodeLikeRequest({
      method: req.method,
      url: req.originalUrl ?? req.url,
      protocol: req.protocol,
      headers: req.headers,
      body: req.rawBody ?? req.body,
    });
    const response = await executeGhostFulfillmentAdapter(config, request, req, ({ request: normalizedRequest, fulfillment }) =>
      handler({
        req,
        request: normalizedRequest,
        fulfillment,
      }),
    );
    await writeExpressLikeResponse(response, res);
  };
};

const withGhostFulfillmentFastify = <TRequest extends GhostX402FastifyLikeRequest>(
  config: GhostFulfillmentAdapterConfig<TRequest>,
  handler: (args: {
    request: TRequest;
    rawRequest: Request;
    fulfillment: VerifiedFulfillmentTicket;
  }) => Promise<GhostX402HandlerResult> | GhostX402HandlerResult,
) => {
  return async (request: TRequest, reply: GhostX402FastifyLikeReply): Promise<void> => {
    const rawRequest = createNodeLikeRequest({
      method: request.method,
      url: request.url,
      protocol: request.protocol,
      headers: request.headers,
      body: request.rawBody ?? request.body,
    });
    const response = await executeGhostFulfillmentAdapter(
      config,
      rawRequest,
      request,
      ({ request: normalizedRequest, fulfillment }) =>
        handler({
          request,
          rawRequest: normalizedRequest,
          fulfillment,
        }),
    );
    await writeFastifyLikeResponse(response, reply);
  };
};

export const defineGhostConfig = <T extends GhostHttpMonetizationConfig>(config: T): T => {
  validateGhostHttpMonetizationConfig(config);
  return config;
};

export const createGhostHttpMonetizationKit = (
  input: GhostHttpMonetizationKitConfig,
): GhostHttpMonetizationKit => {
  const resolveRoute = (selection: GhostHttpMonetizationRouteSelection): GhostResolvedHttpMonetizationRoute =>
    resolveGhostHttpMonetizationRoute(input.config, selection);

  const resolveX402Config = <TContext>(
    route: GhostResolvedHttpMonetizationRoute,
  ): GhostX402AdapterConfig<TContext> => {
    if (route.rail !== "x402" || !route.x402) {
      throw new Error(`ghost.config route '${route.id}' does not resolve to x402.`);
    }
    if (!input.x402?.x402Client) {
      throw new Error("createGhostHttpMonetizationKit requires x402.x402Client for x402 routes.");
    }
    return {
      merchant: input.merchant,
      agentId: route.agentId,
      serviceSlug: route.serviceSlug,
      paymentRequirements: route.x402.paymentRequirements,
      x402Client: input.x402.x402Client,
      reporter: input.x402.reporter,
      reporterConfig: input.x402.reporterConfig,
      reportingRuntime: route.x402.reportingRuntime ?? input.x402.reportingRuntime,
      decodePaymentHeader: input.x402.decodePaymentHeader,
      verifyPayment: input.x402.verifyPayment,
      settlePayment: input.x402.settlePayment,
    };
  };

  const resolveExpressConfig = <TContext>(
    route: GhostResolvedHttpMonetizationRoute,
  ): GhostFulfillmentAdapterConfig<TContext> => {
    if (route.rail !== "express") {
      throw new Error(`ghost.config route '${route.id}' does not resolve to express.`);
    }
    return {
      merchant: input.merchant,
      serviceSlug: route.serviceSlug,
      method: route.method,
      path: route.path,
      creditCost: route.express?.creditCost ?? null,
    };
  };

  return {
    config: input.config,
    resolveRoute,
    withNextNode: <TContext = unknown>(
      selection: GhostHttpMonetizationRouteSelection,
      handler: (
        args: GhostHttpMonetizationHandlerArgs<TContext>,
      ) => Promise<GhostX402HandlerResult> | GhostX402HandlerResult,
    ) => {
      const route = resolveRoute(selection);
      if (route.rail === "x402") {
        return withGhostX402NextNode(resolveX402Config<TContext>(route), ({ request, context, x402 }) =>
          handler({
            rail: "x402",
            request,
            context,
            route,
            x402,
          }),
        );
      }
      return withGhostFulfillmentNextNode(resolveExpressConfig<TContext>(route), ({ request, context, fulfillment }) =>
        handler({
          rail: "express",
          request,
          context,
          route,
          fulfillment,
        }),
      );
    },
    withHono: <TContext extends { req?: { raw?: Request } }>(
      selection: GhostHttpMonetizationRouteSelection,
      handler: (
        args: GhostHttpMonetizationHandlerArgs<TContext>,
      ) => Promise<GhostX402HandlerResult> | GhostX402HandlerResult,
    ) => {
      const route = resolveRoute(selection);
      if (route.rail === "x402") {
        return withGhostX402Hono(resolveX402Config<TContext>(route), ({ request, context, x402 }) =>
          handler({
            rail: "x402",
            request,
            context,
            route,
            x402,
          }),
        );
      }
      return withGhostFulfillmentHono(resolveExpressConfig<TContext>(route), ({ request, context, fulfillment }) =>
        handler({
          rail: "express",
          request,
          context,
          route,
          fulfillment,
        }),
      );
    },
    withExpress: <TRequest extends GhostX402ExpressLikeRequest>(
      selection: GhostHttpMonetizationRouteSelection,
      handler: (
        args: GhostHttpMonetizationExpressHandlerArgs<TRequest>,
      ) => Promise<GhostX402HandlerResult> | GhostX402HandlerResult,
    ) => {
      const route = resolveRoute(selection);
      if (route.rail === "x402") {
        return withGhostX402Express(resolveX402Config<TRequest>(route), ({ req, request, x402 }) =>
          handler({
            rail: "x402",
            req,
            request,
            route,
            x402,
          }),
        );
      }
      return withGhostFulfillmentExpress(resolveExpressConfig<TRequest>(route), ({ req, request, fulfillment }) =>
        handler({
          rail: "express",
          req,
          request,
          route,
          fulfillment,
        }),
      );
    },
    withFastify: <TRequest extends GhostX402FastifyLikeRequest>(
      selection: GhostHttpMonetizationRouteSelection,
      handler: (
        args: GhostHttpMonetizationFastifyHandlerArgs<TRequest>,
      ) => Promise<GhostX402HandlerResult> | GhostX402HandlerResult,
    ) => {
      const route = resolveRoute(selection);
      if (route.rail === "x402") {
        return withGhostX402Fastify(resolveX402Config<TRequest>(route), ({ request, rawRequest, x402 }) =>
          handler({
            rail: "x402",
            request,
            rawRequest,
            route,
            x402,
          }),
        );
      }
      return withGhostFulfillmentFastify(
        resolveExpressConfig<TRequest>(route),
        ({ request, rawRequest, fulfillment }) =>
          handler({
            rail: "express",
            request,
            rawRequest,
            route,
            fulfillment,
          }),
      );
    },
  };
};

type GhostMcpJsonRpcId = string | number | null;

type GhostMcpJsonRpcRequest = {
  jsonrpc?: string;
  id?: GhostMcpJsonRpcId;
  method?: string;
  params?: Record<string, unknown> | null;
};

type GhostMcpProxyToolEntry = {
  config: GhostMcpProxyToolConfig;
  route: GhostResolvedHttpMonetizationRoute;
};

type GhostMcpParsedRequest =
  | {
      kind: "invalid";
    }
  | {
      kind: "batch";
    }
  | {
      kind: "single";
      message: GhostMcpJsonRpcRequest;
    };

type GhostMcpProxyRequestResolution =
  | {
      kind: "response";
      response: Response;
    }
  | {
      kind: "tool_call";
      entry: GhostMcpProxyToolEntry;
    };

const DEFAULT_GHOST_MCP_PROXY_TIMEOUT_MS = 15_000;

const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeGhostMcpProxyTimeoutMs = (value: number | undefined): number =>
  Number.isFinite(value) && (value ?? 0) > 0 ? Math.trunc(value as number) : DEFAULT_GHOST_MCP_PROXY_TIMEOUT_MS;

const normalizeGhostMcpProxyConfig = (config: GhostMcpProxyConfig): GhostMcpProxyConfig => {
  const upstreamUrl = normalizeOptionalString(config.upstream.url);
  if (!upstreamUrl) {
    throw new Error("Ghost MCP proxy requires upstream.url.");
  }

  let parsedUpstreamUrl: URL;
  try {
    parsedUpstreamUrl = new URL(upstreamUrl);
  } catch {
    throw new Error(`Ghost MCP proxy upstream.url must be an absolute URL. Received: ${upstreamUrl}`);
  }

  const tools: Record<string, GhostMcpProxyToolConfig> = {};
  for (const [toolName, toolConfig] of Object.entries(config.tools)) {
    const normalizedToolName = normalizeOptionalString(toolName);
    if (!normalizedToolName) {
      throw new Error("Ghost MCP proxy tool names must be non-empty.");
    }
    resolveGhostHttpMonetizationSelection(toolConfig.route);
    tools[normalizedToolName] = {
      route: toolConfig.route,
      descriptionFallbackText: Boolean(toolConfig.descriptionFallbackText),
    };
  }

  return {
    upstream: {
      url: parsedUpstreamUrl.toString(),
      timeoutMs: normalizeGhostMcpProxyTimeoutMs(config.upstream.timeoutMs),
      headers: config.upstream.headers ?? {},
    },
    tools,
  };
};

const buildGhostMcpUpstreamUrl = (upstreamUrl: string, request: Request): string => {
  const target = new URL(upstreamUrl);
  const incoming = new URL(request.url);
  if (!target.search && incoming.search) {
    target.search = incoming.search;
  }
  return target.toString();
};

const buildGhostMcpForwardHeaders = (
  request: Request,
  configuredHeaders: Record<string, string> | undefined,
  includeContentType: boolean,
): Record<string, string> => {
  const headers: Record<string, string> = {
    "cache-control": "no-store",
    ...(configuredHeaders ?? {}),
  };

  const accept = normalizeOptionalString(request.headers.get("accept"));
  if (accept) headers.accept = accept;

  if (includeContentType) {
    const contentType = normalizeOptionalString(request.headers.get("content-type"));
    if (contentType) headers["content-type"] = contentType;
  }

  const lastEventId = normalizeOptionalString(request.headers.get("last-event-id"));
  if (lastEventId) headers["last-event-id"] = lastEventId;

  return headers;
};

const forwardGhostMcpUpstreamRequest = async (
  upstream: GhostMcpProxyConfig["upstream"],
  request: Request,
): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), upstream.timeoutMs ?? DEFAULT_GHOST_MCP_PROXY_TIMEOUT_MS);
  try {
    const method = normalizeOptionalString(request.method)?.toUpperCase() ?? "GET";
    const body = method === "GET" || method === "HEAD" ? undefined : await request.text();
    const response = await fetch(buildGhostMcpUpstreamUrl(upstream.url, request), {
      method,
      headers: buildGhostMcpForwardHeaders(request, upstream.headers, body !== undefined),
      ...(body !== undefined ? { body } : {}),
      signal: controller.signal,
      cache: "no-store",
    });
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    });
  } finally {
    clearTimeout(timeout);
  }
};

const parseGhostMcpJsonRpcRequest = async (request: Request): Promise<GhostMcpParsedRequest> => {
  try {
    const parsed = await request.json();
    if (Array.isArray(parsed)) {
      return {
        kind: "batch",
      };
    }
    if (!isJsonRecord(parsed)) {
      return {
        kind: "invalid",
      };
    }
    return {
      kind: "single",
      message: parsed as GhostMcpJsonRpcRequest,
    };
  } catch {
    return {
      kind: "invalid",
    };
  }
};

const createGhostMcpJsonRpcErrorResponse = (
  id: GhostMcpJsonRpcId,
  code: number,
  message: string,
): Response =>
  Response.json(
    {
      jsonrpc: "2.0",
      id,
      error: {
        code,
        message,
      },
    },
    {
      status: 400,
      headers: {
        "cache-control": "no-store",
      },
    },
  );

const buildGhostMcpToolPricingMetadata = (
  route: GhostResolvedHttpMonetizationRoute,
): GhostMcpToolPricingMetadata => ({
  version: 1,
  routeId: route.id,
  rail: route.rail,
  routeRail: route.routeRail,
  serviceSlug: route.serviceSlug,
  agentId: route.agentId,
  method: route.method,
  path: route.path,
  x402: route.x402
    ? {
        paymentRequirements: route.x402.paymentRequirements,
        reportingRuntime: route.x402.reportingRuntime,
      }
    : null,
  express: route.express
    ? {
        creditCost: route.express.creditCost,
      }
    : null,
});

const formatGhostMcpPricingSummary = (metadata: GhostMcpToolPricingMetadata): string => {
  if (metadata.rail === "express") {
    const costLabel = metadata.express?.creditCost != null ? `${metadata.express.creditCost} credits` : "managed credits";
    return `Ghost pricing: Express (${costLabel})`;
  }

  const primaryRequirement = metadata.x402?.paymentRequirements[0] ?? null;
  if (!primaryRequirement) {
    return "Ghost pricing: x402";
  }
  return `Ghost pricing: x402 (${primaryRequirement.maxAmountRequired} ${String(primaryRequirement.asset)} on ${primaryRequirement.network})`;
};

const augmentGhostMcpToolDefinition = (
  tool: Record<string, unknown>,
  entry: GhostMcpProxyToolEntry,
): Record<string, unknown> => {
  const metadata = buildGhostMcpToolPricingMetadata(entry.route);
  const annotations = isJsonRecord(tool.annotations) ? { ...tool.annotations } : {};
  const ghostAnnotation = isJsonRecord(annotations.ghost) ? { ...annotations.ghost } : {};
  ghostAnnotation.pricing = metadata;
  annotations.ghost = ghostAnnotation;

  const augmented: Record<string, unknown> = {
    ...tool,
    annotations,
  };

  if (entry.config.descriptionFallbackText) {
    const description = normalizeOptionalString(String(tool.description ?? "")) ?? "";
    const summary = formatGhostMcpPricingSummary(metadata);
    augmented.description = description ? `${description} [${summary}]` : summary;
  }

  return augmented;
};

const augmentGhostMcpToolListPayload = (
  payload: Record<string, unknown>,
  toolEntries: Map<string, GhostMcpProxyToolEntry>,
): Record<string, unknown> | null => {
  const result = isJsonRecord(payload.result) ? payload.result : null;
  const tools = Array.isArray(result?.tools) ? result.tools : null;
  if (!result || !tools) return null;

  return {
    ...payload,
    result: {
      ...result,
      tools: tools.map((tool) => {
        if (!isJsonRecord(tool)) return tool;
        const toolName = normalizeOptionalString(String(tool.name ?? ""));
        if (!toolName) return tool;
        const entry = toolEntries.get(toolName);
        return entry ? augmentGhostMcpToolDefinition(tool, entry) : tool;
      }),
    },
  };
};

const resolveGhostMcpProxyRequest = async (
  request: Request,
  upstream: GhostMcpProxyConfig["upstream"],
  toolEntries: Map<string, GhostMcpProxyToolEntry>,
): Promise<GhostMcpProxyRequestResolution> => {
  const method = normalizeOptionalString(request.method)?.toUpperCase() ?? "GET";
  if (method !== "POST") {
    return {
      kind: "response",
      response: await forwardGhostMcpUpstreamRequest(upstream, request),
    };
  }

  const parsedRequest = await parseGhostMcpJsonRpcRequest(request.clone());
  if (parsedRequest.kind === "batch") {
    return {
      kind: "response",
      response: createGhostMcpJsonRpcErrorResponse(
        null,
        -32600,
        "JSON-RPC batch requests are not supported by the Ghost MCP proxy.",
      ),
    };
  }

  if (parsedRequest.kind !== "single" || !normalizeOptionalString(parsedRequest.message.method)) {
    return {
      kind: "response",
      response: await forwardGhostMcpUpstreamRequest(upstream, request),
    };
  }

  const message = parsedRequest.message;
  const rpcMethod = normalizeOptionalString(message.method)!;
  if (rpcMethod === "tools/list") {
    const upstreamResponse = await forwardGhostMcpUpstreamRequest(upstream, request);
    const contentType = normalizeOptionalString(upstreamResponse.headers.get("content-type"))?.toLowerCase() ?? "";
    if (!contentType.includes("application/json")) {
      return {
        kind: "response",
        response: upstreamResponse,
      };
    }

    let payload: unknown;
    try {
      payload = await upstreamResponse.clone().json();
    } catch {
      return {
        kind: "response",
        response: upstreamResponse,
      };
    }

    if (!isJsonRecord(payload)) {
      return {
        kind: "response",
        response: upstreamResponse,
      };
    }

    const augmented = augmentGhostMcpToolListPayload(payload, toolEntries);
    if (!augmented) {
      return {
        kind: "response",
        response: upstreamResponse,
      };
    }

    const headers = new Headers(upstreamResponse.headers);
    headers.set("cache-control", "no-store");
    headers.set("content-type", "application/json");
    return {
      kind: "response",
      response: new Response(JSON.stringify(augmented), {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers,
      }),
    };
  }

  if (rpcMethod !== "tools/call") {
    return {
      kind: "response",
      response: await forwardGhostMcpUpstreamRequest(upstream, request),
    };
  }

  const params = isJsonRecord(message.params) ? message.params : {};
  const toolName = normalizeOptionalString(String(params.name ?? ""));
  if (!toolName) {
    return {
      kind: "response",
      response: createGhostMcpJsonRpcErrorResponse(message.id ?? null, -32602, "tools/call requires params.name."),
    };
  }

  const entry = toolEntries.get(toolName);
  if (!entry) {
    return {
      kind: "response",
      response: createGhostMcpJsonRpcErrorResponse(
        message.id ?? null,
        -32000,
        `Tool '${toolName}' is not configured for Ghost monetization.`,
      ),
    };
  }

  return {
    kind: "tool_call",
    entry,
  };
};

export const createGhostMcpProxy = (input: {
  kit: GhostHttpMonetizationKit;
  config: GhostMcpProxyConfig;
}): GhostMcpProxy => {
  const config = normalizeGhostMcpProxyConfig(input.config);
  const toolEntries = new Map<string, GhostMcpProxyToolEntry>();
  const requestToolHandlers = new Map<string, (request: Request) => Promise<Response>>();
  const honoToolHandlers = new Map<string, (context: { req?: { raw?: Request } }) => Promise<Response>>();
  const expressToolHandlers = new Map<
    string,
    (req: GhostX402ExpressLikeRequest, res: GhostX402ExpressLikeResponse) => Promise<void>
  >();
  const fastifyToolHandlers = new Map<
    string,
    (request: GhostX402FastifyLikeRequest, reply: GhostX402FastifyLikeReply) => Promise<void>
  >();

  for (const [toolName, toolConfig] of Object.entries(config.tools)) {
    const route = input.kit.resolveRoute(toolConfig.route);
    toolEntries.set(toolName, {
      config: toolConfig,
      route,
    });
  }

  const getRequestToolHandler = (entry: GhostMcpProxyToolEntry): ((request: Request) => Promise<Response>) => {
    const cached = requestToolHandlers.get(entry.route.id);
    if (cached) return cached;

    const handler = input.kit.withNextNode(entry.route.id, async ({ request }) =>
      forwardGhostMcpUpstreamRequest(config.upstream, request),
    );
    requestToolHandlers.set(entry.route.id, handler);
    return handler;
  };

  const getHonoToolHandler = (
    entry: GhostMcpProxyToolEntry,
  ): ((context: { req?: { raw?: Request } }) => Promise<Response>) => {
    const cached = honoToolHandlers.get(entry.route.id);
    if (cached) return cached;

    const handler = input.kit.withHono(entry.route.id, async ({ request }) =>
      forwardGhostMcpUpstreamRequest(config.upstream, request),
    );
    honoToolHandlers.set(entry.route.id, handler);
    return handler;
  };

  const getExpressToolHandler = (
    entry: GhostMcpProxyToolEntry,
  ): ((req: GhostX402ExpressLikeRequest, res: GhostX402ExpressLikeResponse) => Promise<void>) => {
    const cached = expressToolHandlers.get(entry.route.id);
    if (cached) return cached;

    const handler = input.kit.withExpress(entry.route.id, async ({ request }) =>
      forwardGhostMcpUpstreamRequest(config.upstream, request),
    );
    expressToolHandlers.set(entry.route.id, handler);
    return handler;
  };

  const getFastifyToolHandler = (
    entry: GhostMcpProxyToolEntry,
  ): ((request: GhostX402FastifyLikeRequest, reply: GhostX402FastifyLikeReply) => Promise<void>) => {
    const cached = fastifyToolHandlers.get(entry.route.id);
    if (cached) return cached;

    const handler = input.kit.withFastify(entry.route.id, async ({ rawRequest }) =>
      forwardGhostMcpUpstreamRequest(config.upstream, rawRequest),
    );
    fastifyToolHandlers.set(entry.route.id, handler);
    return handler;
  };

  const handleRequest = async (request: Request): Promise<Response> => {
    const resolution = await resolveGhostMcpProxyRequest(request, config.upstream, toolEntries);
    if (resolution.kind === "response") {
      return resolution.response;
    }
    return getRequestToolHandler(resolution.entry)(request);
  };

  return {
    config,
    handleRequest,
    withNextNode: <TContext = unknown>() => async (request: Request, _context?: TContext): Promise<Response> =>
      handleRequest(request),
    withHono: <TContext extends { req?: { raw?: Request } }>() =>
      async (context: TContext): Promise<Response> => {
        const request = context.req?.raw;
        if (!(request instanceof Request)) {
          throw new Error("Ghost MCP proxy Hono binding requires context.req.raw to be a Request.");
        }
        const resolution = await resolveGhostMcpProxyRequest(request, config.upstream, toolEntries);
        if (resolution.kind === "response") {
          return resolution.response;
        }
        return getHonoToolHandler(resolution.entry)(context);
      },
    withExpress: <TRequest extends GhostX402ExpressLikeRequest>() =>
      async (req: TRequest, res: GhostX402ExpressLikeResponse): Promise<void> => {
        const request = createNodeLikeRequest({
          method: req.method,
          url: req.originalUrl ?? req.url,
          protocol: req.protocol,
          headers: req.headers,
          body: req.rawBody ?? req.body,
        });
        const resolution = await resolveGhostMcpProxyRequest(request, config.upstream, toolEntries);
        if (resolution.kind === "response") {
          await writeExpressLikeResponse(resolution.response, res);
          return;
        }
        await getExpressToolHandler(resolution.entry)(req, res);
      },
    withFastify: <TRequest extends GhostX402FastifyLikeRequest>() =>
      async (request: TRequest, reply: GhostX402FastifyLikeReply): Promise<void> => {
        const rawRequest = createNodeLikeRequest({
          method: request.method,
          url: request.url,
          protocol: request.protocol,
          headers: request.headers,
          body: request.rawBody ?? request.body,
        });
        const resolution = await resolveGhostMcpProxyRequest(rawRequest, config.upstream, toolEntries);
        if (resolution.kind === "response") {
          await writeFastifyLikeResponse(resolution.response, reply);
          return;
        }
        await getFastifyToolHandler(resolution.entry)(request, reply);
      },
  };
};

const normalizeX402RequestBody = (input: {
  body: unknown;
  headers: Record<string, string>;
}): { body: BodyInit | undefined; headers: Record<string, string> } => {
  if (input.body == null) {
    return { body: undefined, headers: input.headers };
  }

  if (
    typeof input.body === "string" ||
    input.body instanceof ArrayBuffer ||
    ArrayBuffer.isView(input.body) ||
    input.body instanceof Blob ||
    input.body instanceof FormData ||
    input.body instanceof URLSearchParams ||
    input.body instanceof ReadableStream
  ) {
    return {
      body: input.body as BodyInit,
      headers: input.headers,
    };
  }

  const nextHeaders = { ...input.headers };
  if (!Object.keys(nextHeaders).some((key) => key.toLowerCase() === "content-type")) {
    nextHeaders["content-type"] = "application/json";
  }
  return {
    body: JSON.stringify(input.body),
    headers: nextHeaders,
  };
};

const createMerchantGatewayAuthPayload = (input: {
  action: MerchantGatewayAuthAction;
  agentId: string;
  ownerAddress: string;
  actorAddress: string;
  serviceSlug: string;
}): MerchantGatewayAuthPayload => ({
  scope: MERCHANT_GATEWAY_AUTH_SCOPE,
  version: MERCHANT_GATEWAY_AUTH_VERSION,
  action: input.action,
  agentId: input.agentId,
  ownerAddress: normalizeAddressLower(input.ownerAddress),
  actorAddress: normalizeAddressLower(input.actorAddress),
  serviceSlug: input.serviceSlug,
  nonce: randomUUID().replace(/-/g, ""),
  issuedAt: Math.floor(Date.now() / 1000),
});

const buildMerchantGatewayAuthMessage = (payload: MerchantGatewayAuthPayload): string =>
  [
    "Ghost Protocol Merchant Gateway Authorization",
    `scope:${payload.scope}`,
    `version:${payload.version}`,
    `action:${payload.action}`,
    `agentId:${payload.agentId}`,
    `serviceSlug:${payload.serviceSlug}`,
    `ownerAddress:${payload.ownerAddress}`,
    `actorAddress:${payload.actorAddress}`,
    `issuedAt:${payload.issuedAt}`,
    `nonce:${payload.nonce}`,
  ].join("\n");

const normalizeWireHash = (value: string | null | undefined): `0x${string}` | null => {
  const trimmed = value?.trim().toLowerCase();
  return trimmed && /^0x[a-f0-9]{64}$/.test(trimmed) ? (trimmed as `0x${string}`) : null;
};

const buildWireArtifactAuthPayload = (input: {
  jobId: string;
  clientAddress: string;
  createTxHash?: string | null;
  fundTxHash?: string | null;
  issuedAt?: number;
  nonce?: string;
}) => ({
  scope: "ghostwire_artifacts" as const,
  version: "1" as const,
  jobId: input.jobId,
  clientAddress: normalizeAddressLower(input.clientAddress),
  createTxHash: normalizeWireHash(input.createTxHash ?? null),
  fundTxHash: normalizeWireHash(input.fundTxHash ?? null),
  issuedAt: input.issuedAt ?? Math.floor(Date.now() / 1000),
  nonce: input.nonce ?? randomUUID().replace(/-/g, ""),
});

const buildWireArtifactAuthMessage = (payload: ReturnType<typeof buildWireArtifactAuthPayload>): string =>
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

export const buildCanaryPayload = (serviceSlug: string): CanaryPayload => {
  const normalized = normalizeOptionalString(serviceSlug);
  if (!normalized) throw new Error("serviceSlug is required for canary payloads.");
  return {
    ghostgate: "ready",
    service: normalized,
  };
};

export const createCanaryHandler = (serviceSlug: string) => {
  const payload = buildCanaryPayload(serviceSlug);
  return (_req?: unknown, res?: unknown): unknown => {
    const headers = buildCanaryHeaders();
    if (res && typeof res === "object") {
      const response = res as {
        setHeader?: (name: string, value: string) => unknown;
        status?: (statusCode: number) => { json?: (body: unknown) => unknown } | unknown;
        json?: (body: unknown) => unknown;
        writeHead?: (statusCode: number, headers?: Record<string, string>) => unknown;
        end?: (body?: string) => unknown;
      };

      if (typeof response.status === "function" && typeof response.json === "function") {
        for (const [key, value] of Object.entries(headers)) {
          response.setHeader?.(key, value);
        }
        response.status(200);
        return response.json(payload);
      }

      if (typeof response.writeHead === "function" && typeof response.end === "function") {
        response.writeHead(200, headers);
        return response.end(JSON.stringify(payload));
      }
    }

    return {
      status: 200,
      headers,
      body: payload,
    };
  };
};

export class GhostAgent {
  private apiKey: string | null;
  private readonly agentId: string | null;
  private readonly baseUrl: string;
  private readonly privateKey: `0x${string}` | null;
  private readonly chainId: number;
  private readonly telemetryServiceSlug: string | null;
  private readonly serviceSlug: string;
  private readonly creditCost: number;

  constructor(config: GhostAgentConfig = {}) {
    const normalizedServiceSlug = normalizeOptionalString(config.serviceSlug);
    this.apiKey = normalizeOptionalString(config.apiKey) ?? null;
    this.agentId = normalizeOptionalString(config.agentId);
    this.baseUrl = normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL);
    this.privateKey = config.privateKey ?? null;
    this.chainId = config.chainId ?? DEFAULT_CHAIN_ID;
    this.telemetryServiceSlug = normalizedServiceSlug;
    this.serviceSlug = normalizedServiceSlug ?? DEFAULT_SERVICE_SLUG;
    this.creditCost = Number.isFinite(config.creditCost) && (config.creditCost ?? 0) > 0
      ? Math.max(MIN_EXPRESS_CREDIT_COST, Math.trunc(config.creditCost as number))
      : DEFAULT_CREDIT_COST;
  }

  async connect(apiKey?: string): Promise<ConnectResult> {
    const normalizedApiKey = normalizeOptionalString(apiKey) ?? this.apiKey;
    if (!normalizedApiKey) {
      throw new Error("connect(apiKey?) requires a non-empty API key via argument or constructor config.");
    }
    if (!this.privateKey) {
      throw new Error(
        "GhostAgent requires a signing privateKey in constructor config to call /api/gate/[...slug].",
      );
    }

    const timestamp = BigInt(Math.floor(Date.now() / 1000));
    const signedPayload = {
      service: this.serviceSlug,
      timestamp,
      nonce: randomUUID().replace(/-/g, ""),
    } as const;
    const headerPayload = {
      service: this.serviceSlug,
      timestamp: timestamp.toString(),
      nonce: signedPayload.nonce,
    } as const;

    const account = privateKeyToAccount(this.privateKey);
    const signature = await account.signTypedData({
      domain: {
        name: "GhostGate",
        version: "1",
        chainId: this.chainId,
      },
      types: ACCESS_TYPES,
      primaryType: "Access",
      message: signedPayload,
    });

    const endpoint = `${this.baseUrl}/api/gate/${encodeURIComponent(this.serviceSlug)}`;
    const gateHeaders: Record<string, string> = {
      accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      "x-ghost-sig": signature,
      "x-ghost-payload": JSON.stringify(headerPayload),
      "x-ghost-credit-cost": String(this.creditCost),
    };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: gateHeaders,
      cache: "no-store",
    });

    const responsePayload = await parsePayload(response);
    if (response.ok) {
      this.apiKey = normalizedApiKey;
    }

    return {
      connected: response.ok,
      apiKeyPrefix: getApiKeyPrefix(normalizedApiKey),
      endpoint,
      status: response.status,
      payload: responsePayload,
    };
  }

  async requestX402(input: X402RequestInput): Promise<X402RequestResult> {
    const privateKey = assertPrivateKey(this.privateKey, "privateKey");
    const network = resolveX402Network(input.network, this.chainId);
    const signer = await createSigner(network, privateKey);
    const maxAmountAtomic = normalizePositiveBigInt(
      input.maxAmountAtomic,
      DEFAULT_X402_MAX_AMOUNT_ATOMIC,
      "maxAmountAtomic",
    );
    const fetchWithPayment = wrapFetchWithPayment(
      globalThis.fetch,
      signer,
      maxAmountAtomic,
      input.paymentRequirementsSelector,
    );
    const method = normalizeOptionalString(input.method)?.toUpperCase() ?? "GET";
    const normalizedHeaders = {
      accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      ...(input.headers ?? {}),
    };
    const preparedBody = normalizeX402RequestBody({
      body: input.body,
      headers: normalizedHeaders,
    });
    const response = await fetchWithPayment(input.url, {
      method,
      headers: preparedBody.headers,
      ...(preparedBody.body !== undefined ? { body: preparedBody.body } : {}),
      cache: "no-store",
    });
    const paymentResponseHeader =
      normalizeOptionalString(response.headers.get("x-payment-response")) ??
      normalizeOptionalString(response.headers.get("X-PAYMENT-RESPONSE"));
    const payload = await parsePayload(response.clone());

    return {
      ok: response.ok,
      endpoint: response.url || input.url,
      status: response.status,
      payload,
      paymentResponseHeader,
      paymentResponse: paymentResponseHeader ? decodeXPaymentResponse(paymentResponseHeader) : null,
    };
  }

  async pulse(input: PulseInput = {}): Promise<TelemetryResult> {
    const apiKey = normalizeOptionalString(input.apiKey) ?? this.apiKey;
    const serviceSlug = normalizeOptionalString(input.serviceSlug) ?? this.telemetryServiceSlug;
    const agentId = normalizeOptionalString(input.agentId) ?? this.agentId ?? deriveAgentId(serviceSlug);

    assertTelemetryIdentity({ apiKey, agentId, serviceSlug });

    const endpoint = `${this.baseUrl}/api/telemetry/pulse`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      },
      body: JSON.stringify({
        ...(apiKey ? { apiKey } : {}),
        ...(agentId ? { agentId } : {}),
        ...(serviceSlug ? { serviceSlug } : {}),
        ...(toOptionalMetadata(input.metadata) ? { metadata: input.metadata } : {}),
      }),
      cache: "no-store",
    });

    return {
      ok: response.ok,
      endpoint,
      status: response.status,
      payload: await parsePayload(response),
    };
  }

  async outcome(input: OutcomeInput): Promise<TelemetryResult> {
    const apiKey = normalizeOptionalString(input.apiKey) ?? this.apiKey;
    const serviceSlug = normalizeOptionalString(input.serviceSlug) ?? this.telemetryServiceSlug;
    const agentId = normalizeOptionalString(input.agentId) ?? this.agentId ?? deriveAgentId(serviceSlug);
    const statusCode = normalizeTelemetryStatusCode(input.statusCode);

    assertTelemetryIdentity({ apiKey, agentId, serviceSlug });

    const endpoint = `${this.baseUrl}/api/telemetry/outcome`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      },
      body: JSON.stringify({
        ...(apiKey ? { apiKey } : {}),
        ...(agentId ? { agentId } : {}),
        ...(serviceSlug ? { serviceSlug } : {}),
        success: Boolean(input.success),
        ...(statusCode != null ? { statusCode } : {}),
        ...(toOptionalMetadata(input.metadata) ? { metadata: input.metadata } : {}),
      }),
      cache: "no-store",
    });

    return {
      ok: response.ok,
      endpoint,
      status: response.status,
      payload: await parsePayload(response),
    };
  }

  async createWireQuote(input: {
    provider: `0x${string}` | string;
    evaluator: `0x${string}` | string;
    principalAmount: string;
    chainId?: number;
    client: `0x${string}` | string;
    providerAgentId?: string | null;
    providerServiceSlug?: string | null;
  }): Promise<WireQuoteResult> {
    const endpoint = `${this.baseUrl}/api/wire/quote`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      },
      body: JSON.stringify({
        provider: input.provider,
        evaluator: input.evaluator,
        principalAmount: input.principalAmount,
        settlementAsset: "USDC",
        chainId: input.chainId ?? this.chainId,
        ...(normalizeOptionalString(input.client ?? null) ? { client: input.client } : {}),
        ...(normalizeOptionalString(input.providerAgentId ?? null)
          ? { providerAgentId: input.providerAgentId }
          : {}),
        ...(normalizeOptionalString(input.providerServiceSlug ?? null)
          ? { providerServiceSlug: input.providerServiceSlug }
          : {}),
      }),
      cache: "no-store",
    });
    const payload = await parsePayload(response);
    const record =
      typeof payload === "object" && payload !== null && "quoteId" in payload
        ? (payload as {
            quoteId?: unknown;
            expiresAt?: unknown;
            chainId?: unknown;
            contractAddress?: unknown;
            paymentTokenAddress?: unknown;
            pricing?: unknown;
            confirmations?: unknown;
            directExecution?: unknown;
          })
        : null;

    return {
      ok: response.ok,
      endpoint,
      status: response.status,
      payload,
      quoteId: typeof record?.quoteId === "string" ? record.quoteId : null,
      expiresAt: typeof record?.expiresAt === "string" ? record.expiresAt : null,
      chainId: typeof record?.chainId === "number" ? record.chainId : null,
      contractAddress: typeof record?.contractAddress === "string" ? record.contractAddress : null,
      paymentTokenAddress: typeof record?.paymentTokenAddress === "string" ? record.paymentTokenAddress : null,
      pricing:
        typeof record?.pricing === "object" && record.pricing !== null
          ? (record.pricing as WireQuoteResult["pricing"])
          : null,
      confirmations:
        typeof record?.confirmations === "object" && record.confirmations !== null
          ? (record.confirmations as WireQuoteResult["confirmations"])
          : null,
      directExecution:
        typeof record?.directExecution === "object" && record.directExecution !== null
          ? (record.directExecution as WireQuoteResult["directExecution"])
          : null,
    };
  }

  async prepareWireJob(input: WireJobPrepareInput): Promise<WireJobPrepareResult> {
    const endpoint = `${this.baseUrl}/api/wire/jobs`;
    const normalizedRequest = normalizeGhostWireRequestPayload(input.request ?? null);
    const normalizedSpecHash = normalizeOptionalString(input.specHash ?? null);
    if (normalizedSpecHash && normalizedRequest) {
      const derivedSpecHash = buildGhostWireRequestSpecHash(normalizedRequest);
      if (normalizedSpecHash.toLowerCase() !== derivedSpecHash.toLowerCase()) {
        throw new Error("prepareWireJob(...) request does not match the supplied specHash.");
      }
    }
    const resolvedSpecHash = normalizedSpecHash ?? (normalizedRequest ? buildGhostWireRequestSpecHash(normalizedRequest) : null);

    if (!resolvedSpecHash) {
      throw new Error("prepareWireJob(...) requires either specHash or request.");
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      },
      body: JSON.stringify({
        quoteId: input.quoteId,
        client: input.client,
        provider: input.provider,
        evaluator: input.evaluator,
        ...(normalizeOptionalString(input.providerAgentId ?? null)
          ? { providerAgentId: input.providerAgentId }
          : {}),
        ...(normalizeOptionalString(input.providerServiceSlug ?? null)
          ? { providerServiceSlug: input.providerServiceSlug }
          : {}),
        specHash: resolvedSpecHash,
        ...(normalizedRequest ? { request: normalizedRequest } : {}),
        ...(normalizeOptionalString(input.metadataUri ?? null) ? { metadataUri: input.metadataUri } : {}),
        ...(normalizeOptionalString(input.webhookUrl ?? null) ? { webhookUrl: input.webhookUrl } : {}),
        ...(normalizeOptionalString(input.webhookSecret ?? null) ? { webhookSecret: input.webhookSecret } : {}),
        ...(input.approvalMode ? { approvalMode: input.approvalMode } : {}),
      }),
      cache: "no-store",
    });
    const payload = await parsePayload(response);
    const record =
      typeof payload === "object" && payload !== null && "jobId" in payload
        ? (payload as {
            jobId?: unknown;
            quoteId?: unknown;
            chainId?: unknown;
            jobExpiresAt?: unknown;
            direct?: unknown;
          })
        : null;

    return {
      ok: response.ok,
      endpoint,
      status: response.status,
      payload,
      jobId: typeof record?.jobId === "string" ? record.jobId : null,
      quoteId: typeof record?.quoteId === "string" ? record.quoteId : null,
      chainId: typeof record?.chainId === "number" ? record.chainId : null,
      jobExpiresAt: typeof record?.jobExpiresAt === "string" ? record.jobExpiresAt : null,
      direct:
        typeof record?.direct === "object" && record.direct !== null
          ? (record.direct as GhostWireDirectPrepare)
          : null,
    };
  }

  async recordWireArtifacts(input: WireArtifactRecordInput): Promise<WireArtifactRecordResult> {
    const normalizedJobId = normalizeOptionalString(input.jobId);
    if (!normalizedJobId) {
      throw new Error("recordWireArtifacts(jobId, ...) requires a non-empty GhostWire job id.");
    }

    const createTxHash = normalizeWireHash(input.createTxHash ?? null);
    const fundTxHash = normalizeWireHash(input.fundTxHash ?? null);
    if (!createTxHash && !fundTxHash) {
      throw new Error("recordWireArtifacts requires at least one of createTxHash or fundTxHash.");
    }

    const clientPrivateKey = input.clientPrivateKey ?? this.privateKey;
    if (!clientPrivateKey) {
      throw new Error("recordWireArtifacts requires a clientPrivateKey or GhostAgent.privateKey.");
    }

    const clientAccount = privateKeyToAccount(clientPrivateKey);
    if (normalizeAddressLower(clientAccount.address) !== normalizeAddressLower(input.clientAddress)) {
      throw new Error("recordWireArtifacts clientPrivateKey does not match the provided clientAddress.");
    }

    const authPayload = buildWireArtifactAuthPayload({
      jobId: normalizedJobId,
      clientAddress: input.clientAddress,
      createTxHash,
      fundTxHash,
    });
    const authSignature = await clientAccount.signMessage({
      message: buildWireArtifactAuthMessage(authPayload),
    });

    const endpoint = `${this.baseUrl}/api/wire/jobs/${encodeURIComponent(normalizedJobId)}/artifacts`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      },
      body: JSON.stringify({
        ...(createTxHash ? { createTxHash } : {}),
        ...(fundTxHash ? { fundTxHash } : {}),
        ...(normalizeOptionalString(input.createTxSender ?? null) ? { createTxSender: input.createTxSender } : {}),
        ...(normalizeOptionalString(input.fundTxSender ?? null) ? { fundTxSender: input.fundTxSender } : {}),
        ...(input.approvalMode ? { approvalMode: input.approvalMode } : {}),
        authPayload,
        authSignature,
      }),
      cache: "no-store",
    });
    const payload = await parsePayload(response);
    const record =
      typeof payload === "object" && payload !== null
        ? (payload as {
            job?: unknown;
            direct?: unknown;
          })
        : null;

    return {
      ok: response.ok,
      endpoint,
      status: response.status,
      payload,
      job:
        typeof record?.job === "object" && record.job !== null
          ? (record.job as WireJobSnapshot)
          : null,
      direct:
        typeof record?.direct === "object" && record.direct !== null
          ? (record.direct as GhostWireDirectPrepare)
          : null,
    };
  }

  async getWireJob(jobId: string): Promise<WireJobResult> {
    const normalizedJobId = normalizeOptionalString(jobId);
    if (!normalizedJobId) {
      throw new Error("getWireJob(jobId) requires a non-empty GhostWire job id.");
    }

    const endpoint = `${this.baseUrl}/api/wire/jobs/${encodeURIComponent(normalizedJobId)}`;
    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      },
      cache: "no-store",
    });
    const payload = await parsePayload(response);
    const job =
      typeof payload === "object" &&
      payload !== null &&
      "job" in payload &&
      typeof (payload as { job?: unknown }).job === "object" &&
      (payload as { job?: unknown }).job !== null
        ? ((payload as { job: WireJobSnapshot }).job)
        : null;

    return {
      ok: response.ok,
      endpoint,
      status: response.status,
      payload,
      job,
    };
  }

  async waitForWireTerminal(jobId: string, options: WireCompletionWaitOptions = {}): Promise<WireJobSnapshot> {
    const intervalMs =
      Number.isFinite(options.intervalMs) && (options.intervalMs ?? 0) > 0
        ? Math.trunc(options.intervalMs as number)
        : 5_000;
    const timeoutMs =
      Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
        ? Math.trunc(options.timeoutMs as number)
        : 5 * 60_000;
    const startedAt = Date.now();

    while (true) {
      const result = await this.getWireJob(jobId);
      if (!result.ok || !result.job) {
        throw new Error(`waitForWireTerminal failed to fetch job ${jobId} (status ${result.status}).`);
      }
      if (["COMPLETED", "REJECTED", "EXPIRED"].includes(result.job.contractState)) {
        return result.job;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`GhostWire job ${jobId} did not reach a terminal state before timeout.`);
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  async getWireDeliverable(jobId: string): Promise<WireDeliverableResult> {
    const jobResult = await this.getWireJob(jobId);
    if (!jobResult.ok || !jobResult.job) {
      throw new Error(`getWireDeliverable failed to fetch job ${jobId} (status ${jobResult.status}).`);
    }

    const job = jobResult.job;
    if (job.contractState !== "COMPLETED") {
      throw new Error(`GhostWire job ${jobId} is not completed yet.`);
    }

    const sourceUrl = resolveWireDeliverableLocator(job);
    if (!sourceUrl) {
      throw new Error(`GhostWire job ${jobId} does not expose a deliverable locator.`);
    }

    const response = await fetch(sourceUrl, {
      method: "GET",
      headers: {
        accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      },
      cache: "no-store",
    });
    const contentType = normalizeOptionalString(response.headers.get("content-type"));
    const bodyText = await parseTextPayload(response);
    let bodyJson: unknown | null = null;
    if (bodyText) {
      try {
        bodyJson = JSON.parse(bodyText) as unknown;
      } catch {
        bodyJson = null;
      }
    }

    if (!response.ok) {
      throw new Error(
        `GhostWire deliverable fetch failed for ${jobId} from ${sourceUrl} (status ${response.status}).`,
      );
    }

    return {
      ok: response.ok,
      endpoint: sourceUrl,
      status: response.status,
      job,
      contentType,
      bodyJson,
      bodyText,
      sourceUrl,
    };
  }

  startHeartbeat(options: HeartbeatOptions = {}): HeartbeatController {
    const intervalMs = Number.isFinite(options.intervalMs) && (options.intervalMs ?? 0) > 0
      ? Math.trunc(options.intervalMs as number)
      : DEFAULT_HEARTBEAT_INTERVAL_MS;
    const immediate = options.immediate ?? true;
    let stopped = false;
    let inFlight = false;

    const tick = async (): Promise<void> => {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        const result = await this.pulse(options);
        options.onResult?.(result);
      } catch (error) {
        options.onError?.(error);
      } finally {
        inFlight = false;
      }
    };

    const timer = setInterval(() => {
      void tick();
    }, intervalMs);

    if (immediate) {
      void tick();
    }

    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
      },
    };
  }

  get isConnected(): boolean {
    return this.apiKey !== null;
  }

  get endpoint(): string {
    return `${this.baseUrl}/api/gate`;
  }
}

export class GhostMerchant extends GhostFulfillmentMerchant {
  private readonly merchantServiceSlug: string;
  private readonly merchantBaseUrl: string;
  private readonly ownerPrivateKey: `0x${string}` | null;
  private readonly settlementDelegatedPrivateKey: `0x${string}` | null;
  private readonly ownerAddress: string | null;
  private readonly delegatedSignerAddress: string | null;
  private heartbeatController: HeartbeatController | null = null;

  constructor(config: GhostMerchantConfig) {
    super(config);
    const normalizedServiceSlug = normalizeOptionalString(config.serviceSlug);
    if (!normalizedServiceSlug) {
      throw new Error("GhostMerchant.serviceSlug is required.");
    }
    this.merchantServiceSlug = normalizedServiceSlug;
    this.merchantBaseUrl = normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL);
    this.ownerPrivateKey = config.ownerPrivateKey ? assertPrivateKey(config.ownerPrivateKey, "ownerPrivateKey") : null;
    this.settlementDelegatedPrivateKey = config.delegatedPrivateKey
      ? assertPrivateKey(config.delegatedPrivateKey, "delegatedPrivateKey")
      : null;
    this.ownerAddress = this.ownerPrivateKey ? privateKeyToAccount(this.ownerPrivateKey).address.toLowerCase() : null;
    this.delegatedSignerAddress = this.settlementDelegatedPrivateKey
      ? privateKeyToAccount(this.settlementDelegatedPrivateKey).address.toLowerCase()
      : null;
  }

  get serviceSlug(): string {
    return this.merchantServiceSlug;
  }

  canaryPayload(): CanaryPayload {
    return buildCanaryPayload(this.merchantServiceSlug);
  }

  canaryHandler() {
    return createCanaryHandler(this.merchantServiceSlug);
  }

  createX402SettlementReporter(config: X402SettlementReporterConfig): X402SettlementReporter {
    return new X402SettlementReporter(this, config);
  }

  async activate(options: MerchantActivateOptions): Promise<ActivateResult> {
    const agentId = normalizeOptionalString(options.agentId);
    const serviceSlug = normalizeOptionalString(options.serviceSlug);
    const endpointUrl = normalizeOptionalString(options.endpointUrl);
    const canaryPath = normalizeOptionalString(options.canaryPath) ?? DEFAULT_ACTIVATE_CANARY_PATH;
    const canaryMethod = (normalizeOptionalString(options.canaryMethod) ?? DEFAULT_ACTIVATE_CANARY_METHOD).toUpperCase();
    const signerLabel = normalizeOptionalString(options.signerLabel) ?? DEFAULT_ACTIVATE_SIGNER_LABEL;

    if (!agentId) throw new Error("[activate:validate] agentId is required.");
    if (!serviceSlug) throw new Error("[activate:validate] serviceSlug is required.");
    if (!endpointUrl) throw new Error("[activate:validate] endpointUrl is required.");
    if (!canaryPath.startsWith("/")) {
      throw new Error("[activate:validate] canaryPath must start with '/'.");
    }
    if (canaryMethod !== "GET") {
      throw new Error("[activate:validate] canaryMethod must be GET.");
    }
    if (!this.ownerPrivateKey || !this.ownerAddress) {
      throw new Error(
        "[activate:owner] ownerPrivateKey is required on GhostMerchant config and must match the indexed agent owner.",
      );
    }

    const ownerConfig = await this.fetchGatewayOwnerConfig(agentId);
    const indexedOwnerAddress = normalizeAddressLower(ownerConfig.config.ownerAddress);
    if (indexedOwnerAddress !== this.ownerAddress) {
      throw new Error(
        `[activate:owner] ownerPrivateKey address ${this.ownerAddress} does not match indexed owner ${indexedOwnerAddress} for agent ${agentId}.`,
      );
    }

    const configPayload = (await this.postMerchantSignedWrite("config", {
      path: "/api/agent-gateway/config",
      agentId,
      serviceSlug,
      ownerAddress: indexedOwnerAddress,
      body: {
        endpointUrl,
        canaryPath,
        canaryMethod: "GET",
      },
    })) as { config?: MerchantGatewayConfigResponse["config"] };

    const verifyPayload = (await this.postMerchantSignedWrite("verify", {
      path: "/api/agent-gateway/verify",
      agentId,
      serviceSlug,
      ownerAddress: indexedOwnerAddress,
      body: {},
    })) as MerchantGatewayVerifyResponse;

    const readiness = verifyPayload.readinessStatus;
    if (verifyPayload.verified !== true || readiness !== "LIVE") {
      const detailParts = [
        verifyPayload.error ? `error=${verifyPayload.error}` : null,
        verifyPayload.canaryUrl ? `canaryUrl=${verifyPayload.canaryUrl}` : null,
        typeof verifyPayload.statusCode === "number" ? `statusCode=${verifyPayload.statusCode}` : null,
        typeof verifyPayload.latencyMs === "number" ? `latencyMs=${verifyPayload.latencyMs}` : null,
      ].filter(Boolean);
      throw new Error(
        `[activate:verify] canary verification did not reach LIVE readiness${detailParts.length ? ` (${detailParts.join(", ")})` : ""}.`,
      );
    }

    const signerAddress = this.delegatedSignerAddress ?? indexedOwnerAddress;
    const signerRegistration = (await this.postMerchantSignedWrite("delegated_signer_register", {
      path: "/api/agent-gateway/delegated-signers/register",
      agentId,
      serviceSlug,
      ownerAddress: indexedOwnerAddress,
      body: {
        signerAddress,
        label: signerLabel,
      },
    })) as MerchantGatewayDelegatedSignerRegisterResponse;

    this.heartbeatController?.stop();
    const heartbeatAgent = new GhostAgent({
      baseUrl: this.merchantBaseUrl,
      agentId,
      serviceSlug,
    });
    this.heartbeatController = heartbeatAgent.startHeartbeat({
      agentId,
      serviceSlug,
      immediate: false,
    });

    return {
      status: "LIVE",
      readiness: "LIVE",
      config: configPayload.config ?? ownerConfig.config,
      verify: verifyPayload,
      signerRegistration,
      heartbeat: this.heartbeatController,
    };
  }

  async reportX402Settlement(input: X402SettlementReportInput): Promise<X402SettlementReportResult> {
    const agentId = normalizeOptionalString(input.agentId);
    const serviceSlug = normalizeOptionalString(input.serviceSlug);
    const evidence = createSettlementEvidence(input);

    if (!agentId) throw new Error("reportX402Settlement(agentId) requires a non-empty agentId.");
    if (!serviceSlug) throw new Error("reportX402Settlement(serviceSlug) requires a non-empty serviceSlug.");

    const ownerConfig = await this.fetchGatewayOwnerConfig(agentId);
    const ownerAddress = normalizeAddressLower(ownerConfig.config.ownerAddress);
    const actorKey = this.settlementDelegatedPrivateKey ?? this.ownerPrivateKey;
    if (!actorKey) {
      throw new Error(
        "reportX402Settlement requires delegatedPrivateKey or ownerPrivateKey on GhostMerchant config.",
      );
    }
    const actorAddress = privateKeyToAccount(actorKey).address.toLowerCase();
    const authPayload = createMerchantGatewayAuthPayload({
      action: "x402_settlement_report",
      agentId,
      ownerAddress,
      actorAddress,
      serviceSlug,
    });
    const authSignature = await privateKeyToAccount(actorKey).signMessage({
      message: buildMerchantGatewayAuthMessage(authPayload),
    });
    const endpoint = `${this.merchantBaseUrl}/api/telemetry/x402/settlements`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      },
      body: JSON.stringify({
        agentId,
        ownerAddress,
        actorAddress,
        serviceSlug,
        requestId: evidence.requestId,
        paymentReference: evidence.paymentReference,
        payerIdentity: evidence.payerIdentity,
        ...(evidence.payerAddress ? { payerAddress: evidence.payerAddress } : {}),
        scheme: evidence.scheme,
        ...(evidence.network ? { network: evidence.network } : {}),
        ...(evidence.chainId != null ? { chainId: evidence.chainId } : {}),
        asset: evidence.asset,
        amountAtomic: evidence.amountAtomic,
        decimals: evidence.decimals,
        success: evidence.success,
        ...(evidence.statusCode != null ? { statusCode: evidence.statusCode } : {}),
        ...(evidence.latencyMs != null ? { latencyMs: evidence.latencyMs } : {}),
        occurredAt: evidence.occurredAt,
        ...(evidence.metadata ? { metadata: evidence.metadata } : {}),
        authPayload,
        authSignature,
      }),
      cache: "no-store",
    });
    const payload = await parsePayload(response);

    return {
      ok: response.ok,
      endpoint,
      status: response.status,
      payload,
      countedForRank:
        typeof payload === "object" &&
        payload !== null &&
        "countedForRank" in payload &&
        typeof (payload as { countedForRank?: unknown }).countedForRank === "boolean"
          ? Boolean((payload as { countedForRank: boolean }).countedForRank)
          : false,
      relatedParty:
        typeof payload === "object" &&
        payload !== null &&
        "relatedParty" in payload &&
        typeof (payload as { relatedParty?: unknown }).relatedParty === "boolean"
          ? Boolean((payload as { relatedParty: boolean }).relatedParty)
          : false,
      duplicate:
        typeof payload === "object" &&
        payload !== null &&
        "duplicate" in payload &&
        typeof (payload as { duplicate?: unknown }).duplicate === "boolean"
          ? Boolean((payload as { duplicate: boolean }).duplicate)
          : false,
    };
  }

  async reportX402Settlements(inputs: X402SettlementReportInput[]): Promise<X402SettlementReportResult[]> {
    return Promise.all(inputs.map((input) => this.reportX402Settlement(input)));
  }

  private async fetchGatewayOwnerConfig(agentId: string): Promise<MerchantGatewayConfigResponse> {
    const params = new URLSearchParams({ agentId });
    const endpoint = `${this.merchantBaseUrl}/api/agent-gateway/config?${params.toString()}`;
    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      },
      cache: "no-store",
    });
    const payload = await parsePayload(response);
    if (!response.ok) {
      const message = this.extractApiErrorMessage(payload, "Failed to load gateway owner config.");
      throw new Error(`[activate:config_lookup] ${message}`);
    }
    const config =
      typeof payload === "object" &&
      payload !== null &&
      "config" in payload &&
      typeof (payload as { config?: unknown }).config === "object" &&
      (payload as { config?: unknown }).config !== null
        ? ((payload as { config: MerchantGatewayConfigResponse["config"] }).config)
        : null;
    if (!config || !normalizeOptionalString(config.ownerAddress)) {
      throw new Error("[activate:config_lookup] gateway config response missing ownerAddress.");
    }
    return {
      configured:
        typeof payload === "object" && payload !== null && "configured" in payload
          ? Boolean((payload as { configured?: unknown }).configured)
          : false,
      config,
    };
  }

  private async postMerchantSignedWrite(
    action: MerchantGatewayAuthAction,
    input: {
      path: string;
      agentId: string;
      serviceSlug: string;
      ownerAddress: string;
      body: Record<string, unknown>;
    },
  ): Promise<unknown> {
    const ownerKey = assertPrivateKey(this.ownerPrivateKey, "ownerPrivateKey");
    const ownerAddress = normalizeAddressLower(input.ownerAddress);
    const authPayload = createMerchantGatewayAuthPayload({
      action,
      agentId: input.agentId,
      ownerAddress,
      actorAddress: ownerAddress,
      serviceSlug: input.serviceSlug,
    });
    const account = privateKeyToAccount(ownerKey);
    const authSignature = await account.signMessage({
      message: buildMerchantGatewayAuthMessage(authPayload),
    });

    const endpoint = `${this.merchantBaseUrl}${input.path}`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      },
      body: JSON.stringify({
        agentId: input.agentId,
        ownerAddress,
        actorAddress: ownerAddress,
        serviceSlug: input.serviceSlug,
        authPayload,
        authSignature,
        ...input.body,
      }),
      cache: "no-store",
    });
    const payload = await parsePayload(response);
    if (!response.ok) {
      const message = this.extractApiErrorMessage(payload, `Request failed for ${action}.`);
      throw new Error(`[activate:${action}] ${message}`);
    }
    return payload;
  }

  private extractApiErrorMessage(payload: unknown, fallback: string): string {
    if (typeof payload === "object" && payload !== null && "error" in payload) {
      const maybeError = (payload as { error?: unknown }).error;
      if (typeof maybeError === "string" && maybeError.trim().length > 0) {
        return maybeError.trim();
      }
    }
    return fallback;
  }
}

export default GhostAgent;
