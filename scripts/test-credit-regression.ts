import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { buildGateSettlementId, calculateSettlementAmounts } from "../lib/merchant-settlement";
import { resolveMerchantSettlementRollupConfig } from "../lib/merchant-settlement-config";
import { bootstrapPostgresEnv } from "../lib/postgres-env";

bootstrapPostgresEnv();

process.env.GHOST_CREDIT_LEDGER_ENABLED = "true";
process.env.GHOST_GATE_NONCE_STORE_ENABLED = "true";
process.env.GHOST_GATE_ENFORCE_NONCE_UNIQUENESS = "true";
process.env.GHOST_GATE_ALLOW_CLIENT_COST_OVERRIDE = "false";
process.env.GHOST_REQUEST_CREDIT_COST = "5";
process.env.GHOST_GATE_ENFORCE_LIVE_GATEWAY_READINESS = "true";
process.env.GHOST_SETTLEMENT_ROLLUP_MIN_FEE_WEI = "1";
const EXPRESS_COST = 5n;
const EXPRESS_COST_NUMBER = Number(EXPRESS_COST);
const DOMAIN = {
  name: "GhostGate",
  version: "1",
  chainId: 8453,
} as const;

const TYPES = {
  Access: [
    { name: "service", type: "string" },
    { name: "timestamp", type: "uint256" },
    { name: "nonce", type: "string" },
  ],
} as const;

const assert = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message);
};

type GateResponseBody = Record<string, unknown>;

const createLiveGatewayConfig = async (
  prisma: PrismaClient,
  input: { agentId: string; serviceSlug: string; ownerAddress: string },
): Promise<void> => {
  const ownerAddress = input.ownerAddress.toLowerCase();
  const agentAddress = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();

  await prisma.agent.create({
    data: {
      address: agentAddress,
      agentId: input.agentId,
      name: `Regression Agent ${input.agentId}`,
      creator: ownerAddress,
      owner: ownerAddress,
    },
  });

  await prisma.agentGatewayConfig.create({
    data: {
      agentId: input.agentId,
      ownerAddress,
      serviceSlug: input.serviceSlug,
      endpointUrl: `https://example.com/${input.serviceSlug}`,
      readinessStatus: "LIVE",
    },
  });
};

const callGate = async (
  gateGet: (request: NextRequest, context: { params: { slug: string[] } }) => Promise<Response>,
  input: {
    service: string;
    signature: `0x${string}`;
    payloadJson: string;
    requestId: string;
    requestScopedCost: string;
  },
): Promise<{ status: number; body: GateResponseBody }> => {
  const req = new NextRequest(`http://localhost/api/gate/${input.service}`, {
    method: "GET",
    headers: {
      "x-ghost-payload": input.payloadJson,
      "x-ghost-sig": input.signature,
      "x-ghost-request-id": input.requestId,
      "x-ghost-credit-cost": input.requestScopedCost,
    },
  });

  const res = await gateGet(req, { params: { slug: input.service.split("/") } });
  const body = (await res.json()) as GateResponseBody;
  return {
    status: res.status,
    body,
  };
};

const run = async (): Promise<void> => {
  const { GET: gateGet } = await import("../app/api/gate/[...slug]/route");
  const { prisma, updateUserCredits, getUserCredits, consumeUserCreditsForGate, createMerchantSettlementRollups } = await import("../lib/db");
  const { reconcileMerchantSettlementRows } = await import("../lib/merchant-settlement-reconcile");

  const cleanupWallets = new Set<string>();
  const cleanupAgentIds = new Set<string>();
  const cleanupMerchantOwners = new Set<string>();
  const cleanupBatchIds = new Set<string>();

  try {
    {
      const account = privateKeyToAccount(generatePrivateKey());
      const signer = account.address;
      const signerKey = signer.toLowerCase();
      cleanupWallets.add(signerKey);

      await updateUserCredits(signer, EXPRESS_COST + 2n);

      const agentId = `${Date.now()}01`;
      const service = `agent-${agentId}`;
      const ownerAddress = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
      cleanupAgentIds.add(agentId);
      await createLiveGatewayConfig(prisma, { agentId, serviceSlug: service, ownerAddress });

      const nonce = `reg-nonce-${Date.now()}`;
      const timestamp = BigInt(Math.floor(Date.now() / 1000));
      const signature = await account.signTypedData({
        domain: DOMAIN,
        types: TYPES,
        primaryType: "Access",
        message: { service, timestamp, nonce },
      });

      const payloadJson = JSON.stringify({
        service,
        timestamp: timestamp.toString(),
        nonce,
      });

      const firstRequestId = `reg-replay-1-${Date.now()}`;
      const first = await callGate(gateGet, {
        service,
        signature,
        payloadJson,
        requestId: firstRequestId,
        requestScopedCost: "999",
      });
      const second = await callGate(gateGet, {
        service,
        signature,
        payloadJson,
        requestId: `reg-replay-2-${Date.now()}`,
        requestScopedCost: "999",
      });

      const balanceAfter = await getUserCredits(signer);
      const nonceCount = await prisma.accessNonce.count({
        where: { signer: signerKey, service, nonce },
      });
      const gateDebitCount = await prisma.creditLedger.count({
        where: { walletAddress: signerKey, reason: "gate_debit" },
      });
      const expectedAmounts = calculateSettlementAmounts({ grossCredits: EXPRESS_COST });
      const earnings = await prisma.merchantEarning.findMany({
        where: { walletAddress: signerKey, serviceSlug: service, sourceType: "GATE_DEBIT" },
        orderBy: { createdAt: "asc" },
        select: {
          merchantOwnerAddress: true,
          sourceId: true,
          grossCredits: true,
          grossWei: true,
          feeWei: true,
          netWei: true,
        },
      });

      assert(first.status === 200, `Expected first gate call 200, got ${first.status}`);
      assert(second.status === 409, `Expected replay gate call 409, got ${second.status}`);
      assert(balanceAfter === 2n, `Expected balance 2 after replay test, got ${balanceAfter.toString()}`);
      assert(nonceCount === 1, `Expected nonce count 1, got ${nonceCount}`);
      assert(gateDebitCount === 1, `Expected one gate debit row, got ${gateDebitCount}`);
      assert(earnings.length === 1, `Expected one merchant earning row, got ${earnings.length}`);
      const recordedRequestId =
        typeof first.body?.requestId === "string" && first.body.requestId.length > 0 ? first.body.requestId : null;
      assert(recordedRequestId !== null, "Expected first gate response to include a server-derived requestId.");
      assert(
        earnings[0]?.merchantOwnerAddress === ownerAddress,
        `Expected merchant owner ${ownerAddress}, got ${earnings[0]?.merchantOwnerAddress ?? "missing"}`,
      );
      assert(
        earnings[0]?.sourceId === `${signerKey}:${recordedRequestId}`,
        `Expected gate sourceId ${signerKey}:${recordedRequestId}, got ${earnings[0]?.sourceId ?? "missing"}`,
      );
      assert(
        earnings[0]?.grossCredits === EXPRESS_COST_NUMBER,
        `Expected grossCredits ${EXPRESS_COST_NUMBER}, got ${String(earnings[0]?.grossCredits)}`,
      );
      assert(
        earnings[0]?.grossWei === expectedAmounts.grossWei,
        `Expected grossWei ${expectedAmounts.grossWei}, got ${String(earnings[0]?.grossWei)}`,
      );
      assert(
        earnings[0]?.feeWei === expectedAmounts.feeWei,
        `Expected feeWei ${expectedAmounts.feeWei}, got ${String(earnings[0]?.feeWei)}`,
      );
      assert(
        earnings[0]?.netWei === expectedAmounts.netWei,
        `Expected netWei ${expectedAmounts.netWei}, got ${String(earnings[0]?.netWei)}`,
      );
    }

    {
      const account = privateKeyToAccount(generatePrivateKey());
      const signer = account.address;
      const signerKey = signer.toLowerCase();
      cleanupWallets.add(signerKey);

      await updateUserCredits(signer, EXPRESS_COST + 2n);

      const agentId = `${Date.now()}02`;
      const service = `agent-${agentId}`;
      const ownerAddress = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
      cleanupAgentIds.add(agentId);
      await createLiveGatewayConfig(prisma, { agentId, serviceSlug: service, ownerAddress });

      const nonce = `reg-cost-${Date.now()}`;
      const timestamp = BigInt(Math.floor(Date.now() / 1000));
      const signature = await account.signTypedData({
        domain: DOMAIN,
        types: TYPES,
        primaryType: "Access",
        message: { service, timestamp, nonce },
      });

      const payloadJson = JSON.stringify({
        service,
        timestamp: timestamp.toString(),
        nonce,
      });

      const res = await callGate(gateGet, {
        service,
        signature,
        payloadJson,
        requestId: `reg-cost-1-${Date.now()}`,
        requestScopedCost: "999",
      });

      const latestDebit = await prisma.creditLedger.findFirst({
        where: { walletAddress: signerKey, reason: "gate_debit" },
        orderBy: { createdAt: "desc" },
        select: { amount: true, direction: true },
      });
      const earnings = await prisma.merchantEarning.count({
        where: { walletAddress: signerKey, serviceSlug: service, sourceType: "GATE_DEBIT" },
      });

      assert(res.status === 200, `Expected cost test status 200, got ${res.status}`);
      assert(res.body?.cost === EXPRESS_COST.toString(), `Expected cost '${EXPRESS_COST}', got ${String(res.body?.cost)}`);
      assert(
        res.body?.costSource === "default",
        `Expected costSource 'default', got ${String(res.body?.costSource)}`,
      );
      assert(
        latestDebit?.amount === EXPRESS_COST_NUMBER,
        `Expected ledger debit amount ${EXPRESS_COST_NUMBER}, got ${String(latestDebit?.amount)}`,
      );
      assert(latestDebit?.direction === "DEBIT", `Expected debit direction DEBIT, got ${String(latestDebit?.direction)}`);
      assert(earnings === 1, `Expected one merchant earning for cost flow, got ${earnings}`);
    }

    {
      const account = privateKeyToAccount(generatePrivateKey());
      const signer = account.address;
      const signerKey = signer.toLowerCase();
      cleanupWallets.add(signerKey);

      await updateUserCredits(signer, 0n);

      const agentId = `${Date.now()}03`;
      const service = `agent-${agentId}`;
      const ownerAddress = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
      cleanupAgentIds.add(agentId);
      await createLiveGatewayConfig(prisma, { agentId, serviceSlug: service, ownerAddress });

      const nonce = `reg-insufficient-${Date.now()}`;
      const timestamp = BigInt(Math.floor(Date.now() / 1000));
      const signature = await account.signTypedData({
        domain: DOMAIN,
        types: TYPES,
        primaryType: "Access",
        message: { service, timestamp, nonce },
      });

      const payloadJson = JSON.stringify({
        service,
        timestamp: timestamp.toString(),
        nonce,
      });

      const res = await callGate(gateGet, {
        service,
        signature,
        payloadJson,
        requestId: `reg-insufficient-1-${Date.now()}`,
        requestScopedCost: "999",
      });

      const earnings = await prisma.merchantEarning.count({
        where: { walletAddress: signerKey, serviceSlug: service, sourceType: "GATE_DEBIT" },
      });

      assert(res.status === 402, `Expected insufficient credits status 402, got ${res.status}`);
      assert(earnings === 0, `Expected no merchant earnings for insufficient credits, got ${earnings}`);
    }

    {
      const account = privateKeyToAccount(generatePrivateKey());
      const signer = account.address;
      const signerKey = signer.toLowerCase();
      cleanupWallets.add(signerKey);

      await updateUserCredits(signer, EXPRESS_COST * 3n);

      const agentId = `${Date.now()}04`;
      const service = `agent-${agentId}`;
      const ownerAddress = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
      cleanupAgentIds.add(agentId);
      await createLiveGatewayConfig(prisma, { agentId, serviceSlug: service, ownerAddress });

      const requestId = `reg-rollback-${Date.now()}`;
      const settlementId = buildGateSettlementId({ walletAddress: signer, requestId });
      const amounts = calculateSettlementAmounts({ grossCredits: EXPRESS_COST });
      await prisma.merchantEarning.create({
        data: {
          settlementId,
          walletAddress: signerKey,
          merchantOwnerAddress: ownerAddress,
          agentId,
          serviceSlug: service,
          sourceType: "GATE_DEBIT",
          sourceId: `${signerKey}:${requestId}`,
          grossCredits: EXPRESS_COST_NUMBER,
          grossWei: amounts.grossWei,
          feeWei: amounts.feeWei,
          netWei: amounts.netWei,
        },
      });

      const nonce = `reg-rollback-nonce-${Date.now()}`;
      const timestamp = BigInt(Math.floor(Date.now() / 1000));
      const beforeBalance = await getUserCredits(signer);

      const result = await consumeUserCreditsForGate(signer, 1n, {
        service,
        nonce,
        payloadTimestamp: timestamp,
        requestId,
        merchantOwnerAddress: ownerAddress,
        agentId,
        enforceNonceUniqueness: true,
      });

      const balanceAfter = await getUserCredits(signer);
      const nonceCount = await prisma.accessNonce.count({
        where: { signer: signerKey, service, nonce },
      });
      const gateDebitCount = await prisma.creditLedger.count({
        where: { walletAddress: signerKey, reason: "gate_debit", requestId },
      });

      assert(result.status === "replay", `Expected duplicate earning source to return replay, got ${result.status}`);
      assert(balanceAfter === beforeBalance, `Expected balance rollback to ${beforeBalance}, got ${balanceAfter}`);
      assert(nonceCount === 0, `Expected nonce rollback on earning conflict, got ${nonceCount}`);
      assert(gateDebitCount === 0, `Expected no gate ledger debit on earning conflict, got ${gateDebitCount}`);
    }

    {
      const account = privateKeyToAccount(generatePrivateKey());
      const signer = account.address;
      const signerKey = signer.toLowerCase();
      cleanupWallets.add(signerKey);

      await updateUserCredits(signer, 5n);

      const agentId = `${Date.now()}05`;
      const service = `agent-${agentId}`;
      const ownerAddress = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
      cleanupMerchantOwners.add(ownerAddress);
      cleanupAgentIds.add(agentId);
      await createLiveGatewayConfig(prisma, { agentId, serviceSlug: service, ownerAddress });

      for (let index = 0; index < 3; index += 1) {
        const nonce = `rollup-nonce-${index}-${Date.now()}`;
        const timestamp = BigInt(Math.floor(Date.now() / 1000));
        const signature = await account.signTypedData({
          domain: DOMAIN,
          types: TYPES,
          primaryType: "Access",
          message: { service, timestamp, nonce },
        });

        const payloadJson = JSON.stringify({
          service,
          timestamp: timestamp.toString(),
          nonce,
        });

        const response = await callGate(gateGet, {
          service,
          signature,
          payloadJson,
          requestId: `rollup-request-${index}-${Date.now()}`,
          requestScopedCost: EXPRESS_COST.toString(),
        });
        assert(response.status === 200, `Expected rollup setup gate call ${index} to return 200, got ${response.status}`);
      }

      const rollupResult = await createMerchantSettlementRollups({
        config: resolveMerchantSettlementRollupConfig(),
        maxRollups: 5,
      });

      const rollups = await prisma.merchantSettlementRollup.findMany({
        where: { merchantOwnerAddress: ownerAddress },
        select: {
          id: true,
          status: true,
          earningCount: true,
          grossWei: true,
          feeWei: true,
          netWei: true,
        },
      });
      const attachedEarnings = await prisma.merchantEarning.findMany({
        where: { walletAddress: signerKey, serviceSlug: service, settlementRollupId: { not: null } },
        select: { settlementRollupId: true },
      });

      assert(rollupResult.createdCount >= 1, `Expected at least one created rollup, got ${rollupResult.createdCount}`);
      assert(rollups.length === 1, `Expected one persisted rollup, got ${rollups.length}`);
      assert(rollups[0]?.status === "PENDING", `Expected rollup to remain PENDING, got ${rollups[0]?.status ?? "missing"}`);
      assert(rollups[0]?.earningCount === 3, `Expected rollup earningCount 3, got ${String(rollups[0]?.earningCount)}`);
      const singleSettlementAmounts = calculateSettlementAmounts({ grossCredits: EXPRESS_COST });
      assert(
        rollups[0]?.grossWei === singleSettlementAmounts.grossWei * 3n,
        `Expected rollup grossWei ${String(singleSettlementAmounts.grossWei * 3n)}, got ${String(rollups[0]?.grossWei)}`,
      );
      assert(
        rollups[0]?.feeWei === singleSettlementAmounts.feeWei * 3n,
        `Expected rollup feeWei ${String(singleSettlementAmounts.feeWei * 3n)}, got ${String(rollups[0]?.feeWei)}`,
      );
      assert(
        rollups[0]?.netWei === singleSettlementAmounts.netWei * 3n,
        `Expected rollup netWei ${String(singleSettlementAmounts.netWei * 3n)}, got ${String(rollups[0]?.netWei)}`,
      );
      assert(attachedEarnings.length === 3, `Expected three earnings attached to the rollup, got ${attachedEarnings.length}`);
      assert(
        new Set(attachedEarnings.map((row) => row.settlementRollupId)).size === 1,
        "Expected all attached earnings to point at the same settlement rollup.",
      );
    }

    {
      const walletAddress = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
      cleanupWallets.add(walletAddress);
      const merchantOwnerAddress = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
      cleanupMerchantOwners.add(merchantOwnerAddress);
      const agentId = `${Date.now()}06`;
      const serviceSlug = `agent-${agentId}`;
      cleanupAgentIds.add(agentId);
      await createLiveGatewayConfig(prisma, { agentId, serviceSlug, ownerAddress: merchantOwnerAddress });
      await updateUserCredits(walletAddress as `0x${string}`, EXPRESS_COST);

      const amounts = calculateSettlementAmounts({ grossCredits: EXPRESS_COST });
      const earningIds: string[] = [];
      for (let index = 0; index < 2; index += 1) {
        const requestId = `requeue-request-${index}-${Date.now()}`;
        const settlementId = buildGateSettlementId({ walletAddress: walletAddress as `0x${string}`, requestId });
        const earning = await prisma.merchantEarning.create({
          data: {
            settlementId,
            walletAddress,
            merchantOwnerAddress,
            agentId,
            serviceSlug,
            sourceType: "GATE_DEBIT",
            sourceId: `${walletAddress}:${requestId}`,
          grossCredits: EXPRESS_COST_NUMBER,
            grossWei: amounts.grossWei,
            feeWei: amounts.feeWei,
            netWei: amounts.netWei,
          },
          select: { id: true },
        });
        earningIds.push(earning.id);
      }

      await createMerchantSettlementRollups({
        config: resolveMerchantSettlementRollupConfig(),
        maxRollups: 5,
      });

      const initialRollup = await prisma.merchantSettlementRollup.findFirst({
        where: { merchantOwnerAddress, status: "PENDING" },
        orderBy: { createdAt: "asc" },
        select: { id: true, settlementId: true },
      });
      assert(initialRollup != null, "Expected an initial pending rollup for requeue regression.");
      if (!initialRollup) {
        throw new Error("Expected an initial pending rollup for requeue regression.");
      }

      const batch = await prisma.merchantSettlementBatch.create({
        data: { status: "SUBMITTED", submittedAt: new Date(), txHash: `0x${"ab".repeat(32)}` },
        select: { id: true },
      });
      cleanupBatchIds.add(batch.id);

      await prisma.merchantSettlementRollup.update({
        where: { id: initialRollup.id },
        data: {
          status: "SUBMITTED",
          allocatorBatchId: batch.id,
          txHash: `0x${"ab".repeat(32)}`,
        },
      });
      await prisma.merchantEarning.updateMany({
        where: { id: { in: earningIds } },
        data: {
          status: "SUBMITTED",
          allocatorBatchId: batch.id,
          settlementRollupId: initialRollup.id,
          txHash: `0x${"ab".repeat(32)}`,
        },
      });

      const fakePublicClient = {
        readContract: async () => false,
        getBlockNumber: async () => 10n,
        getTransactionReceipt: async () => ({
          status: "reverted",
          blockNumber: 9n,
        }),
      };

      const reconcileResult = await reconcileMerchantSettlementRows({
        config: { minConfirmations: 2 },
        batchId: batch.id,
        publicClient: fakePublicClient as never,
      });

      const requeuedEarnings = await prisma.merchantEarning.findMany({
        where: { id: { in: earningIds } },
        select: { status: true, settlementRollupId: true, allocatorBatchId: true },
      });
      const failedRollup = await prisma.merchantSettlementRollup.findUnique({
        where: { id: initialRollup.id },
        select: { status: true, allocatorBatchId: true },
      });

      await createMerchantSettlementRollups({
        config: resolveMerchantSettlementRollupConfig(),
        maxRollups: 5,
      });

      const pendingRollups = await prisma.merchantSettlementRollup.findMany({
        where: { merchantOwnerAddress, status: "PENDING" },
        orderBy: { createdAt: "asc" },
        select: { id: true, settlementId: true },
      });

      assert(reconcileResult.requeuedCount === 1, `Expected one requeued rollup, got ${reconcileResult.requeuedCount}`);
      assert(
        requeuedEarnings.every((row) => row.status === "PENDING" && row.settlementRollupId == null && row.allocatorBatchId == null),
        "Expected all member earnings to return to PENDING with no active rollup or batch after requeue.",
      );
      assert(failedRollup?.status === "FAILED", `Expected original rollup to be FAILED, got ${failedRollup?.status ?? "missing"}`);
      assert(
        pendingRollups.some((row) => row.id !== initialRollup.id && row.settlementId !== initialRollup.settlementId),
        "Expected a fresh pending rollup with a new settlement id after requeue.",
      );
    }

    console.log("Credit regression tests passed.");
  } finally {
    for (const walletAddress of cleanupWallets) {
      await prisma.merchantEarning.deleteMany({ where: { walletAddress } });
      await prisma.accessNonce.deleteMany({ where: { signer: walletAddress } });
      await prisma.creditLedger.deleteMany({ where: { walletAddress } });
      try {
        await prisma.gateAccessEvent.deleteMany({ where: { signer: walletAddress } });
      } catch {
        // Table may not exist before migration.
      }
      await prisma.creditBalance.deleteMany({ where: { walletAddress } });
    }

    // Deep fixture cleanup is opt-in because local Prisma teardown on Agent rows can hang in this environment.
    if (process.env.GHOST_CREDIT_REGRESSION_DEEP_CLEANUP === "true") {
      for (const agentId of cleanupAgentIds) {
        await prisma.agent.deleteMany({ where: { agentId } });
      }
    }

    for (const merchantOwnerAddress of cleanupMerchantOwners) {
      await prisma.merchantSettlementRollup.deleteMany({ where: { merchantOwnerAddress } });
    }

    for (const batchId of cleanupBatchIds) {
      await prisma.merchantSettlementBatch.deleteMany({ where: { id: batchId } });
    }

    await prisma.$disconnect();
  }
};

run().catch((error) => {
  console.error("Credit regression tests failed.");
  console.error(error);
  process.exitCode = 1;
});
