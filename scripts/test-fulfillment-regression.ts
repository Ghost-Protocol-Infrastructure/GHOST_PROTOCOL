import { randomBytes } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { PrismaClient } from "@prisma/client";
import {
  buildFulfillmentCaptureSettlementId,
  buildGateSettlementId,
  calculateSettlementAmounts,
} from "../lib/merchant-settlement";
import { resolveMerchantSettlementRollupConfig } from "../lib/merchant-settlement-config";
import { bootstrapPostgresEnv } from "../lib/postgres-env";

bootstrapPostgresEnv();

process.env.GHOST_CREDIT_LEDGER_ENABLED = "true";
process.env.GHOST_GATE_NONCE_STORE_ENABLED = "true";
process.env.GHOST_SETTLEMENT_ROLLUP_MIN_FEE_WEI = "1";

const assert = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message);
};

const createGatewayFixture = async (
  prisma: PrismaClient,
  input: { agentId: string; serviceSlug: string },
): Promise<{
  agentId: string;
  gatewayConfigId: string;
  merchantOwnerAddress: string;
  merchantSignerAddress: string;
}> => {
  const merchantOwnerAddress = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
  const merchantSignerAddress = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
  const agentAddress = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();

  await prisma.agent.create({
    data: {
      address: agentAddress,
      agentId: input.agentId,
      name: `Fulfillment Regression Agent ${input.agentId}`,
      creator: merchantOwnerAddress,
      owner: merchantOwnerAddress,
    },
  });

  const gatewayConfig = await prisma.agentGatewayConfig.create({
    data: {
      agentId: input.agentId,
      ownerAddress: merchantOwnerAddress,
      serviceSlug: input.serviceSlug,
      endpointUrl: `https://example.com/${input.serviceSlug}`,
      readinessStatus: "LIVE",
    },
    select: { id: true },
  });

  await prisma.agentGatewayDelegatedSigner.create({
    data: {
      gatewayConfigId: gatewayConfig.id,
      ownerAddress: merchantOwnerAddress,
      signerAddress: merchantSignerAddress,
      status: "ACTIVE",
      label: "Regression signer",
    },
  });

  return {
    agentId: input.agentId,
    gatewayConfigId: gatewayConfig.id,
    merchantOwnerAddress,
    merchantSignerAddress,
  };
};

const run = async (): Promise<void> => {
  const { prisma, createFulfillmentHold, captureFulfillmentHold, updateUserCredits, createMerchantSettlementRollups } = await import("../lib/db");
  const { GhostFulfillmentMerchant } = await import("../packages/sdk/src/fulfillment");

  const cleanupWallets = new Set<string>();
  const cleanupAgentIds = new Set<string>();
  const cleanupMerchantOwners = new Set<string>();
  const cleanupBatchIds = new Set<string>();

  try {
    {
      const consumer = privateKeyToAccount(generatePrivateKey());
      const consumerWallet = consumer.address.toLowerCase();
      cleanupWallets.add(consumerWallet);
      const agentId = `${Date.now()}11`;
      const serviceSlug = `agent-${agentId}`;
      cleanupAgentIds.add(agentId);

      const { gatewayConfigId, merchantOwnerAddress, merchantSignerAddress } = await createGatewayFixture(prisma, {
        agentId,
        serviceSlug,
      });

      const now = Date.now();
      const ticketIdA = `0x${randomBytes(32).toString("hex")}` as `0x${string}`;
      const ticketIdB = `0x${randomBytes(32).toString("hex")}` as `0x${string}`;
      const requestNonceA = `nonce-a-${Date.now()}`;
      const requestNonceB = `nonce-b-${Date.now()}`;

      await updateUserCredits(consumer.address, 3n);

      const firstHold = await createFulfillmentHold({
        walletAddress: consumer.address,
        serviceSlug,
        agentId,
        gatewayConfigId,
        merchantOwnerAddress,
        requestMethod: "POST",
        requestPath: "/ask",
        queryHash: `0x${"00".repeat(32)}`,
        bodyHash: `0x${"11".repeat(32)}`,
        cost: 1n,
        ticketId: ticketIdA,
        issuedAt: new Date(now - 120_000),
        expiresAt: new Date(now - 60_000),
        requestNonce: requestNonceA,
        requestAuthIssuedAtSeconds: BigInt(Math.floor((now - 120_000) / 1000)),
        walletHoldCap: 3,
      });

      assert(firstHold.status === "ok", `Expected first hold creation to succeed, got ${firstHold.status}`);

      const secondHold = await createFulfillmentHold({
        walletAddress: consumer.address,
        serviceSlug,
        agentId,
        gatewayConfigId,
        merchantOwnerAddress,
        requestMethod: "POST",
        requestPath: "/ask",
        queryHash: `0x${"00".repeat(32)}`,
        bodyHash: `0x${"22".repeat(32)}`,
        cost: 1n,
        ticketId: ticketIdB,
        issuedAt: new Date(now),
        expiresAt: new Date(now + 60_000),
        requestNonce: requestNonceB,
        requestAuthIssuedAtSeconds: BigInt(Math.floor(now / 1000)),
        walletHoldCap: 3,
      });

      assert(
        secondHold.status === "ok",
        `Expected expired prior hold to be released before issuing a new one, got ${secondHold.status}`,
      );

      const holds = await prisma.fulfillmentHold.findMany({
        where: { walletAddress: consumerWallet, serviceSlug },
        orderBy: { createdAt: "asc" },
        select: {
          ticketId: true,
          state: true,
        },
      });

      assert(holds.length === 2, `Expected two holds for regression wallet, got ${holds.length}`);
      assert(
        holds[0]?.ticketId === ticketIdA && holds[0]?.state === "EXPIRED",
        `Expected first hold ${ticketIdA} to be EXPIRED, got ${holds[0]?.ticketId ?? "missing"} / ${holds[0]?.state ?? "missing"}`,
      );
      assert(
        holds[1]?.ticketId === ticketIdB && holds[1]?.state === "HELD",
        `Expected second hold ${ticketIdB} to remain HELD, got ${holds[1]?.ticketId ?? "missing"} / ${holds[1]?.state ?? "missing"}`,
      );

      const balance = await prisma.creditBalance.findUnique({
        where: { walletAddress: consumerWallet },
        select: { credits: true, heldCredits: true },
      });

      assert(balance?.credits === 2, `Expected credits to settle at 2 after hold rollover, got ${String(balance?.credits)}`);
      assert(
        balance?.heldCredits === 1,
        `Expected heldCredits to settle at 1 after hold rollover, got ${String(balance?.heldCredits)}`,
      );

      const earningsBeforeCapture = await prisma.merchantEarning.count({
        where: { walletAddress: consumerWallet, serviceSlug, sourceType: "FULFILLMENT_CAPTURE" },
      });
      assert(
        earningsBeforeCapture === 0,
        `Expected no merchant earning at ticket issuance, got ${earningsBeforeCapture}`,
      );

      const captureResult = await captureFulfillmentHold({
        ticketId: ticketIdB,
        deliveryProofId: `0x${randomBytes(32).toString("hex")}` as `0x${string}`,
        merchantSigner: merchantSignerAddress,
        serviceSlug,
        completedAt: new Date(now + 10_000),
        statusCode: 200n,
        latencyMs: 250n,
        responseHash: null,
        proofTypedHash: `0x${"33".repeat(32)}`,
      });

      if (captureResult.status !== "captured") {
        throw new Error(`Expected capture success, got ${captureResult.status}`);
      }

      const expectedAmounts = calculateSettlementAmounts({ grossCredits: 1n });
      const capturedEarnings = await prisma.merchantEarning.findMany({
        where: { walletAddress: consumerWallet, serviceSlug, sourceType: "FULFILLMENT_CAPTURE" },
        select: {
          sourceId: true,
          merchantOwnerAddress: true,
          grossCredits: true,
          grossWei: true,
          feeWei: true,
          netWei: true,
        },
      });

      assert(capturedEarnings.length === 1, `Expected one fulfillment earning, got ${capturedEarnings.length}`);
      assert(
        capturedEarnings[0]?.sourceId === ticketIdB,
        `Expected fulfillment sourceId ${ticketIdB}, got ${capturedEarnings[0]?.sourceId ?? "missing"}`,
      );
      assert(
        capturedEarnings[0]?.merchantOwnerAddress === merchantOwnerAddress,
        `Expected merchant owner ${merchantOwnerAddress}, got ${capturedEarnings[0]?.merchantOwnerAddress ?? "missing"}`,
      );
      assert(
        capturedEarnings[0]?.grossCredits === 1,
        `Expected fulfillment grossCredits 1, got ${String(capturedEarnings[0]?.grossCredits)}`,
      );
      assert(
        capturedEarnings[0]?.grossWei === expectedAmounts.grossWei,
        `Expected fulfillment grossWei ${expectedAmounts.grossWei}, got ${String(capturedEarnings[0]?.grossWei)}`,
      );
      assert(
        capturedEarnings[0]?.feeWei === expectedAmounts.feeWei,
        `Expected fulfillment feeWei ${expectedAmounts.feeWei}, got ${String(capturedEarnings[0]?.feeWei)}`,
      );
      assert(
        capturedEarnings[0]?.netWei === expectedAmounts.netWei,
        `Expected fulfillment netWei ${expectedAmounts.netWei}, got ${String(capturedEarnings[0]?.netWei)}`,
      );

      const replayResult = await captureFulfillmentHold({
        ticketId: ticketIdB,
        deliveryProofId: captureResult.deliveryProofId,
        merchantSigner: merchantSignerAddress,
        serviceSlug,
        completedAt: new Date(now + 15_000),
        statusCode: 200n,
        latencyMs: 260n,
        responseHash: null,
        proofTypedHash: `0x${"44".repeat(32)}`,
      });

      assert(
        replayResult.status === "idempotent_replay",
        `Expected idempotent replay, got ${replayResult.status}`,
      );

      const earningsAfterReplay = await prisma.merchantEarning.count({
        where: { walletAddress: consumerWallet, serviceSlug, sourceType: "FULFILLMENT_CAPTURE" },
      });
      assert(earningsAfterReplay === 1, `Expected replay to keep one earning row, got ${earningsAfterReplay}`);
    }

    {
      {
        const consumer = privateKeyToAccount(generatePrivateKey());
        const consumerWallet = consumer.address.toLowerCase();
        cleanupWallets.add(consumerWallet);
        const agentId = `${Date.now()}12`;
        const serviceSlug = `agent-${agentId}`;
        cleanupAgentIds.add(agentId);

        const { gatewayConfigId, merchantOwnerAddress, merchantSignerAddress } = await createGatewayFixture(prisma, {
          agentId,
          serviceSlug,
        });

        await updateUserCredits(consumer.address, 1n);

        const baseNow = Date.now();
        const mismatchedTicketId = `0x${randomBytes(32).toString("hex")}` as `0x${string}`;
        const mismatchHold = await createFulfillmentHold({
          walletAddress: consumer.address,
          serviceSlug,
          agentId,
          gatewayConfigId,
          merchantOwnerAddress,
          requestMethod: "POST",
          requestPath: "/ask",
          queryHash: `0x${"55".repeat(32)}`,
          bodyHash: `0x${"66".repeat(32)}`,
          cost: 1n,
          ticketId: mismatchedTicketId,
          issuedAt: new Date(baseNow),
          expiresAt: new Date(baseNow + 60_000),
          requestNonce: `nonce-mismatch-${Date.now()}`,
          requestAuthIssuedAtSeconds: BigInt(Math.floor(baseNow / 1000)),
          walletHoldCap: 3,
        });
        assert(mismatchHold.status === "ok", `Expected mismatch hold creation success, got ${mismatchHold.status}`);

        const mismatchCapture = await captureFulfillmentHold({
          ticketId: mismatchedTicketId,
          deliveryProofId: `0x${randomBytes(32).toString("hex")}` as `0x${string}`,
          merchantSigner: merchantSignerAddress,
          serviceSlug: `${serviceSlug}-other`,
          completedAt: new Date(baseNow + 10_000),
          statusCode: 200n,
          latencyMs: 150n,
          responseHash: null,
          proofTypedHash: `0x${"77".repeat(32)}`,
        });
        assert(
          mismatchCapture.status === "service_mismatch",
          `Expected service mismatch result, got ${mismatchCapture.status}`,
        );

        const mismatchEarnings = await prisma.merchantEarning.count({
          where: { walletAddress: consumerWallet, sourceType: "FULFILLMENT_CAPTURE", sourceId: mismatchedTicketId },
        });
        assert(mismatchEarnings === 0, `Expected no earning for service mismatch, got ${mismatchEarnings}`);
      }

      {
        const consumer = privateKeyToAccount(generatePrivateKey());
        const consumerWallet = consumer.address.toLowerCase();
        cleanupWallets.add(consumerWallet);
        const agentId = `${Date.now()}13`;
        const serviceSlug = `agent-${agentId}`;
        cleanupAgentIds.add(agentId);

        const { gatewayConfigId, merchantOwnerAddress, merchantSignerAddress } = await createGatewayFixture(prisma, {
          agentId,
          serviceSlug,
        });

        await updateUserCredits(consumer.address, 1n);

        const baseNow = Date.now();
        const expiredTicketId = `0x${randomBytes(32).toString("hex")}` as `0x${string}`;
        const expiredHold = await createFulfillmentHold({
          walletAddress: consumer.address,
          serviceSlug,
          agentId,
          gatewayConfigId,
          merchantOwnerAddress,
          requestMethod: "POST",
          requestPath: "/ask",
          queryHash: `0x${"88".repeat(32)}`,
          bodyHash: `0x${"99".repeat(32)}`,
          cost: 1n,
          ticketId: expiredTicketId,
          issuedAt: new Date(baseNow - 60_000),
          expiresAt: new Date(baseNow - 1_000),
          requestNonce: `nonce-expired-${Date.now()}`,
          requestAuthIssuedAtSeconds: BigInt(Math.floor((baseNow - 60_000) / 1000)),
          walletHoldCap: 3,
        });
        assert(expiredHold.status === "ok", `Expected expired hold creation success, got ${expiredHold.status}`);

        const expiredCapture = await captureFulfillmentHold({
          ticketId: expiredTicketId,
          deliveryProofId: `0x${randomBytes(32).toString("hex")}` as `0x${string}`,
          merchantSigner: merchantSignerAddress,
          serviceSlug,
          completedAt: new Date(baseNow + 5_000),
          statusCode: 200n,
          latencyMs: 175n,
          responseHash: null,
          proofTypedHash: `0x${"aa".repeat(32)}`,
        });
        assert(expiredCapture.status === "expired_due", `Expected expired_due, got ${expiredCapture.status}`);

        const expiredEarnings = await prisma.merchantEarning.count({
          where: { walletAddress: consumerWallet, sourceType: "FULFILLMENT_CAPTURE", sourceId: expiredTicketId },
        });
        assert(expiredEarnings === 0, `Expected no earning for expired hold, got ${expiredEarnings}`);
      }

      {
        const consumer = privateKeyToAccount(generatePrivateKey());
        const consumerWallet = consumer.address.toLowerCase();
        cleanupWallets.add(consumerWallet);
        const agentId = `${Date.now()}14`;
        const serviceSlug = `agent-${agentId}`;
        cleanupAgentIds.add(agentId);

        const { gatewayConfigId, merchantOwnerAddress, merchantSignerAddress } = await createGatewayFixture(prisma, {
          agentId,
          serviceSlug,
        });

        await updateUserCredits(consumer.address, 1n);

        const baseNow = Date.now();
        const releasedTicketId = `0x${randomBytes(32).toString("hex")}` as `0x${string}`;
        const releasedHold = await createFulfillmentHold({
          walletAddress: consumer.address,
          serviceSlug,
          agentId,
          gatewayConfigId,
          merchantOwnerAddress,
          requestMethod: "POST",
          requestPath: "/ask",
          queryHash: `0x${"bb".repeat(32)}`,
          bodyHash: `0x${"cc".repeat(32)}`,
          cost: 1n,
          ticketId: releasedTicketId,
          issuedAt: new Date(baseNow),
          expiresAt: new Date(baseNow + 60_000),
          requestNonce: `nonce-released-${Date.now()}`,
          requestAuthIssuedAtSeconds: BigInt(Math.floor(baseNow / 1000)),
          walletHoldCap: 3,
        });
        assert(releasedHold.status === "ok", `Expected released hold creation success, got ${releasedHold.status}`);

        await prisma.fulfillmentHold.update({
          where: { ticketId: releasedTicketId },
          data: {
            state: "RELEASED",
            releasedAt: new Date(baseNow + 1_000),
            releaseReason: "MANUAL",
          },
        });

        const releasedCapture = await captureFulfillmentHold({
          ticketId: releasedTicketId,
          deliveryProofId: `0x${randomBytes(32).toString("hex")}` as `0x${string}`,
          merchantSigner: merchantSignerAddress,
          serviceSlug,
          completedAt: new Date(baseNow + 10_000),
          statusCode: 200n,
          latencyMs: 200n,
          responseHash: null,
          proofTypedHash: `0x${"dd".repeat(32)}`,
        });
        assert(
          releasedCapture.status === "terminal",
          `Expected terminal released hold result, got ${releasedCapture.status}`,
        );

        const releasedEarnings = await prisma.merchantEarning.count({
          where: { walletAddress: consumerWallet, sourceType: "FULFILLMENT_CAPTURE", sourceId: releasedTicketId },
        });
        assert(releasedEarnings === 0, `Expected no earning for released hold, got ${releasedEarnings}`);
      }
    }

    {
      const consumer = privateKeyToAccount(generatePrivateKey());
      const consumerWallet = consumer.address.toLowerCase();
      cleanupWallets.add(consumerWallet);
      const agentId = `${Date.now()}15`;
      const serviceSlug = `agent-${agentId}`;
      cleanupAgentIds.add(agentId);

      const { gatewayConfigId, merchantOwnerAddress, merchantSignerAddress } = await createGatewayFixture(prisma, {
        agentId,
        serviceSlug,
      });

      await updateUserCredits(consumer.address, 2n);

      const now = Date.now();
      const ticketId = `0x${randomBytes(32).toString("hex")}` as `0x${string}`;
      const hold = await createFulfillmentHold({
        walletAddress: consumer.address,
        serviceSlug,
        agentId,
        gatewayConfigId,
        merchantOwnerAddress,
        requestMethod: "POST",
        requestPath: "/ask",
        queryHash: `0x${"ee".repeat(32)}`,
        bodyHash: `0x${"ff".repeat(32)}`,
        cost: 1n,
        ticketId,
        issuedAt: new Date(now),
        expiresAt: new Date(now + 60_000),
        requestNonce: `nonce-rollback-${Date.now()}`,
        requestAuthIssuedAtSeconds: BigInt(Math.floor(now / 1000)),
        walletHoldCap: 3,
      });
      assert(hold.status === "ok", `Expected rollback hold creation success, got ${hold.status}`);

      const settlementId = buildFulfillmentCaptureSettlementId({ ticketId });
      const amounts = calculateSettlementAmounts({ grossCredits: 1n });
      await prisma.merchantEarning.create({
        data: {
          settlementId,
          walletAddress: consumerWallet,
          merchantOwnerAddress,
          agentId,
          serviceSlug,
          sourceType: "FULFILLMENT_CAPTURE",
          sourceId: ticketId,
          grossCredits: 1,
          grossWei: amounts.grossWei,
          feeWei: amounts.feeWei,
          netWei: amounts.netWei,
        },
      });

      let captureFailed = false;
      try {
        await captureFulfillmentHold({
          ticketId,
          deliveryProofId: `0x${randomBytes(32).toString("hex")}` as `0x${string}`,
          merchantSigner: merchantSignerAddress,
          serviceSlug,
          completedAt: new Date(now + 10_000),
          statusCode: 200n,
          latencyMs: 220n,
          responseHash: null,
          proofTypedHash: `0x${"12".repeat(32)}`,
        });
      } catch {
        captureFailed = true;
      }

      const heldRow = await prisma.fulfillmentHold.findUnique({
        where: { ticketId },
        select: { state: true, captureDeliveryProofId: true },
      });
      const balance = await prisma.creditBalance.findUnique({
        where: { walletAddress: consumerWallet },
        select: { credits: true, heldCredits: true },
      });
      const attempts = await prisma.fulfillmentCaptureAttempt.count({
        where: { ticketId },
      });

      assert(captureFailed, "Expected duplicate settlement insertion to fail fulfillment capture.");
      assert(heldRow?.state === "HELD", `Expected hold to remain HELD after rollback, got ${heldRow?.state ?? "missing"}`);
      assert(
        heldRow?.captureDeliveryProofId == null,
        `Expected no capture delivery proof persisted after rollback, got ${heldRow?.captureDeliveryProofId ?? "present"}`,
      );
      assert(balance?.credits === 1, `Expected available credits to remain 1 after rollback, got ${String(balance?.credits)}`);
      assert(balance?.heldCredits === 1, `Expected held credits to remain 1 after rollback, got ${String(balance?.heldCredits)}`);
      assert(attempts === 0, `Expected no capture attempt row after rollback, got ${attempts}`);
    }

    {
      const walletAddress = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
      cleanupWallets.add(walletAddress);
      await updateUserCredits(walletAddress as `0x${string}`, 1n);
      const agentId = `${Date.now()}16`;
      const serviceSlug = `agent-${agentId}`;
      cleanupAgentIds.add(agentId);

      const { merchantOwnerAddress } = await createGatewayFixture(prisma, {
        agentId,
        serviceSlug,
      });
      cleanupMerchantOwners.add(merchantOwnerAddress);

      const amounts = calculateSettlementAmounts({ grossCredits: 1n });
      const gateRequestId = `cross-source-gate-${Date.now()}`;
      await prisma.merchantEarning.createMany({
        data: [
          {
            settlementId: buildGateSettlementId({ walletAddress: walletAddress as `0x${string}`, requestId: gateRequestId }),
            walletAddress,
            merchantOwnerAddress,
            agentId,
            serviceSlug,
            sourceType: "GATE_DEBIT",
            sourceId: `${walletAddress}:${gateRequestId}`,
            grossCredits: 1,
            grossWei: amounts.grossWei,
            feeWei: amounts.feeWei,
            netWei: amounts.netWei,
          },
          {
            settlementId: buildFulfillmentCaptureSettlementId({
              ticketId: `0x${randomBytes(32).toString("hex")}`,
            }),
            walletAddress,
            merchantOwnerAddress,
            agentId,
            serviceSlug,
            sourceType: "FULFILLMENT_CAPTURE",
            sourceId: `0x${randomBytes(32).toString("hex")}`,
            grossCredits: 1,
            grossWei: amounts.grossWei,
            feeWei: amounts.feeWei,
            netWei: amounts.netWei,
          },
        ],
      });

      const rollupResult = await createMerchantSettlementRollups({
        config: resolveMerchantSettlementRollupConfig(),
        maxRollups: 50,
      });

      const rollup = await prisma.merchantSettlementRollup.findFirst({
        where: { merchantOwnerAddress, status: "PENDING" },
        select: { id: true, earningCount: true },
      });
      const attachedSourceTypes = await prisma.merchantEarning.findMany({
        where: { settlementRollupId: rollup?.id ?? "" },
        select: { sourceType: true },
      });

      assert(rollupResult.createdCount >= 1, `Expected at least one rollup creation pass, got ${rollupResult.createdCount}`);
      assert(rollup != null, "Expected a pending rollup for the cross-source merchant.");
      assert(rollup?.earningCount === 2, `Expected cross-source rollup earningCount 2, got ${String(rollup?.earningCount)}`);
      assert(
        JSON.stringify(attachedSourceTypes.map((row) => row.sourceType).sort()) ===
          JSON.stringify(["FULFILLMENT_CAPTURE", "GATE_DEBIT"]),
        `Expected cross-source rollup to include both source types, got ${attachedSourceTypes.map((row) => row.sourceType).join(",")}`,
      );
    }

    {
      const walletAddress = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
      cleanupWallets.add(walletAddress);
      await updateUserCredits(walletAddress as `0x${string}`, 1n);
      const agentId = `${Date.now()}17`;
      const serviceSlug = `agent-${agentId}`;
      cleanupAgentIds.add(agentId);

      const { merchantOwnerAddress } = await createGatewayFixture(prisma, {
        agentId,
        serviceSlug,
      });
      cleanupMerchantOwners.add(merchantOwnerAddress);

      const amounts = calculateSettlementAmounts({ grossCredits: 1n });
      const firstRequestId = `late-arrival-a-${Date.now()}`;
      const secondRequestId = `late-arrival-b-${Date.now()}`;
      await prisma.merchantEarning.createMany({
        data: [
          {
            settlementId: buildGateSettlementId({ walletAddress: walletAddress as `0x${string}`, requestId: firstRequestId }),
            walletAddress,
            merchantOwnerAddress,
            agentId,
            serviceSlug,
            sourceType: "GATE_DEBIT",
            sourceId: `${walletAddress}:${firstRequestId}`,
            grossCredits: 1,
            grossWei: amounts.grossWei,
            feeWei: amounts.feeWei,
            netWei: amounts.netWei,
          },
          {
            settlementId: buildGateSettlementId({ walletAddress: walletAddress as `0x${string}`, requestId: secondRequestId }),
            walletAddress,
            merchantOwnerAddress,
            agentId,
            serviceSlug,
            sourceType: "GATE_DEBIT",
            sourceId: `${walletAddress}:${secondRequestId}`,
            grossCredits: 1,
            grossWei: amounts.grossWei,
            feeWei: amounts.feeWei,
            netWei: amounts.netWei,
          },
        ],
      });

      await createMerchantSettlementRollups({
        config: resolveMerchantSettlementRollupConfig(),
        maxRollups: 50,
      });

      const submittedRollup = await prisma.merchantSettlementRollup.findFirst({
        where: { merchantOwnerAddress, status: "PENDING" },
        orderBy: { createdAt: "asc" },
        select: { id: true, settlementId: true },
      });
      assert(submittedRollup != null, "Expected an initial pending rollup for late-arrival regression.");
      if (!submittedRollup) {
        throw new Error("Expected an initial pending rollup for late-arrival regression.");
      }

      const batch = await prisma.merchantSettlementBatch.create({
        data: { status: "SUBMITTED", submittedAt: new Date(), txHash: `0x${"cd".repeat(32)}` },
        select: { id: true },
      });
      cleanupBatchIds.add(batch.id);

      await prisma.merchantSettlementRollup.update({
        where: { id: submittedRollup.id },
        data: {
          status: "SUBMITTED",
          allocatorBatchId: batch.id,
          txHash: `0x${"cd".repeat(32)}`,
        },
      });
      await prisma.merchantEarning.updateMany({
        where: { settlementRollupId: submittedRollup.id },
        data: {
          status: "SUBMITTED",
          allocatorBatchId: batch.id,
          txHash: `0x${"cd".repeat(32)}`,
        },
      });

      const lateTicketId = `0x${randomBytes(32).toString("hex")}` as `0x${string}`;
      await prisma.merchantEarning.create({
        data: {
          settlementId: buildFulfillmentCaptureSettlementId({ ticketId: lateTicketId }),
          walletAddress,
          merchantOwnerAddress,
          agentId,
          serviceSlug,
          sourceType: "FULFILLMENT_CAPTURE",
          sourceId: lateTicketId,
          grossCredits: 1,
          grossWei: amounts.grossWei,
          feeWei: amounts.feeWei,
          netWei: amounts.netWei,
        },
      });

      await createMerchantSettlementRollups({
        config: resolveMerchantSettlementRollupConfig(),
        maxRollups: 50,
      });

      const allRollups = await prisma.merchantSettlementRollup.findMany({
        where: { merchantOwnerAddress },
        orderBy: { createdAt: "asc" },
        select: { id: true, status: true, settlementId: true },
      });
      const lateEarning = await prisma.merchantEarning.findFirst({
        where: { sourceId: lateTicketId },
        select: { settlementRollupId: true },
      });
      const freshPendingRollup = allRollups.find((row) => row.status === "PENDING");

      assert(
        freshPendingRollup != null && freshPendingRollup.id !== submittedRollup.id,
        "Expected late-arriving earning to be grouped into a new pending rollup.",
      );
      assert(
        lateEarning?.settlementRollupId === freshPendingRollup?.id,
        "Expected the late-arriving earning to attach to the new pending rollup only.",
      );
      assert(
        allRollups.some((row) => row.id === submittedRollup.id && row.status === "SUBMITTED"),
        "Expected the original submitted rollup to remain unchanged.",
      );
    }

    const merchant = new GhostFulfillmentMerchant({
      baseUrl: "https://ghostprotocol.cc",
    });

    const signerSet = (merchant as unknown as { protocolSignerAddresses?: Set<string> }).protocolSignerAddresses;
    assert(signerSet instanceof Set, "Expected merchant SDK to initialize a default protocol signer set.");
    const protocolSignerAddresses = signerSet as Set<string>;
    assert(
      protocolSignerAddresses.has("0xf879f5e26aa52663887f97a51d3444afef8df3fc"),
      "Expected merchant SDK default protocol signer set to include the production signer address.",
    );

    console.log("Fulfillment regression tests passed.");
  } finally {
    for (const walletAddress of cleanupWallets) {
      await prisma.merchantEarning.deleteMany({ where: { walletAddress } });
      await prisma.accessNonce.deleteMany({ where: { signer: walletAddress } });
      await prisma.creditLedger.deleteMany({ where: { walletAddress } });
      await prisma.fulfillmentHold.deleteMany({ where: { walletAddress } });
      await prisma.creditBalance.deleteMany({ where: { walletAddress } });
    }

    // Deep fixture cleanup is opt-in because local Prisma teardown on Agent rows can hang in this environment.
    if (process.env.GHOST_FULFILLMENT_REGRESSION_DEEP_CLEANUP === "true") {
      const agentIds = [...cleanupAgentIds];
      if (agentIds.length > 0) {
        const agentAddresses = await prisma.agent.findMany({
          where: { agentId: { in: agentIds } },
          select: { address: true },
        });
        const addresses = agentAddresses.map((row) => row.address);

        await prisma.agentGatewayConfig.deleteMany({ where: { agentId: { in: agentIds } } });
        await prisma.leaderboardSnapshotRow.deleteMany({ where: { agentId: { in: agentIds } } });
        if (addresses.length > 0) {
          await prisma.agentScoreInput.deleteMany({ where: { agentAddress: { in: addresses } } });
          await prisma.agent.deleteMany({ where: { address: { in: addresses } } });
        }
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
  console.error("Fulfillment regression tests failed.");
  console.error(error);
  process.exitCode = 1;
});
