import { config as loadEnv } from "dotenv";
import { NextRequest } from "next/server";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

loadEnv({ path: ".env", quiet: true });
loadEnv({ path: ".env.local", override: true, quiet: true });

process.env.GHOSTWIRE_EXEC_ENABLED = "true";
process.env.GHOSTWIRE_EXEC_KILL_SWITCH = "false";
process.env.GHOSTWIRE_EXEC_ALLOWLIST_ENFORCED = "false";
process.env.GHOSTWIRE_EXEC_MAX_OPEN_JOBS_PER_CLIENT = "1000";
process.env.GHOSTWIRE_EXEC_CLIENT_CREATE_WINDOW_MAX = "1000";
process.env.GHOSTWIRE_EXEC_CLIENT_DAILY_PRINCIPAL_CAP_ATOMIC = "999999999999999";
process.env.GHOSTWIRE_EXEC_GLOBAL_DAILY_PRINCIPAL_CAP_ATOMIC = "999999999999999";
process.env.GHOSTWIRE_EXEC_MANUAL_REVIEW_OPEN_THRESHOLD = "1000000";
process.env.GHOSTWIRE_EXEC_CIRCUIT_FAILURE_COUNT_THRESHOLD = "1000000";
process.env.GHOSTWIRE_EXEC_CIRCUIT_FAILURE_RATIO_BPS = "10000";
process.env.GHOSTWIRE_EXEC_OPERATOR_DAILY_NATIVE_CAP_WEI = "";

const assert = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message);
};

const JSON_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/plain;q=0.9, */*;q=0.8",
} as const;

const makeQuoteBody = (clientAddress?: string) => ({
  ...(clientAddress ? { client: clientAddress } : {}),
  provider: privateKeyToAccount(generatePrivateKey()).address,
  evaluator: privateKeyToAccount(generatePrivateKey()).address,
  principalAmount: "1000000",
  settlementAsset: "USDC",
  chainId: 84532,
});

const makePrepareBody = (input: {
  quoteId: string;
  clientAddress: string;
  providerAddress: string;
  evaluatorAddress: string;
}) => ({
  quoteId: input.quoteId,
  client: input.clientAddress,
  provider: input.providerAddress,
  evaluator: input.evaluatorAddress,
  specHash: `0x${"aa".repeat(32)}`,
  metadataUri: "https://merchant.example.com/ghostwire/deliverable?jobId=placeholder",
});

const run = async (): Promise<void> => {
  const { POST: quotePost } = await import("../app/api/wire/quote/route");
  const { POST: jobsPost } = await import("../app/api/wire/jobs/route");
  const { GET: getWireJob } = await import("../app/api/wire/jobs/[jobId]/route");
  const { POST: postArtifacts } = await import("../app/api/wire/jobs/[jobId]/artifacts/route");
  const { prisma } = await import("../lib/db");

  const cleanupQuoteIds = new Set<string>();
  const cleanupJobIds = new Set<string>();

  try {
    const missingClientReq = new NextRequest("http://localhost/api/wire/quote", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(makeQuoteBody()),
    });
    const missingClientRes = await quotePost(missingClientReq);
    const missingClientBody = (await missingClientRes.json()) as Record<string, unknown>;

    assert(missingClientRes.status === 400, `Expected missing-client quote 400, got ${missingClientRes.status}`);
    assert(
      missingClientBody.errorCode === "INVALID_WIRE_QUOTE_PARAMS",
      `Expected INVALID_WIRE_QUOTE_PARAMS, got ${String(missingClientBody.errorCode)}`,
    );

    const unfundedClient = privateKeyToAccount(generatePrivateKey()).address;
    const directQuoteBodyInput = makeQuoteBody(unfundedClient);
    const directQuoteReq = new NextRequest("http://localhost/api/wire/quote", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(directQuoteBodyInput),
    });
    const directQuoteRes = await quotePost(directQuoteReq);
    const directQuoteBody = (await directQuoteRes.json()) as Record<string, unknown>;

    assert(directQuoteRes.status === 200, `Expected direct quote 200, got ${directQuoteRes.status}`);
    assert(typeof directQuoteBody.quoteId === "string", "Expected quoteId in direct quote response.");
    assert((directQuoteBody.directExecution as Record<string, unknown> | undefined)?.customerFundsEscrow === true, "Expected customerFundsEscrow=true.");
    assert((directQuoteBody.directExecution as Record<string, unknown> | undefined)?.customerPaysGas === true, "Expected customerPaysGas=true.");
    assert((directQuoteBody.directExecution as Record<string, unknown> | undefined)?.sponsorshipSupported === false, "Expected sponsorshipSupported=false.");
    assert(
      ((directQuoteBody.pricing as Record<string, unknown>)?.networkReserve as Record<string, unknown>)?.amount === "0",
      "Expected direct quote networkReserve amount to be 0.",
    );
    cleanupQuoteIds.add(String(directQuoteBody.quoteId));

    const basePrepareBody = makePrepareBody({
      quoteId: String(directQuoteBody.quoteId),
      clientAddress: unfundedClient,
      providerAddress: directQuoteBodyInput.provider,
      evaluatorAddress: directQuoteBodyInput.evaluator,
    });
    const unfundedPrepareReq = new NextRequest("http://localhost/api/wire/jobs", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(basePrepareBody),
    });
    const unfundedPrepareRes = await jobsPost(unfundedPrepareReq);
    const unfundedPrepareBody = (await unfundedPrepareRes.json()) as Record<string, unknown>;

    assert(unfundedPrepareRes.status === 409, `Expected unfunded prepare 409, got ${unfundedPrepareRes.status}`);
    assert(
      unfundedPrepareBody.errorCode === "WIRE_CLIENT_INSUFFICIENT_BALANCE",
      `Expected WIRE_CLIENT_INSUFFICIENT_BALANCE, got ${String(unfundedPrepareBody.errorCode)}`,
    );

    const candidateKeys = [
      process.env.PRIVATE_KEY,
      process.env.BENCH_PRIVATE_KEY,
      process.env.GHOSTWIRE_OPERATOR_PRIVATE_KEY,
      process.env.GHOST_FULFILLMENT_PROTOCOL_SIGNER_PRIVATE_KEY,
    ].filter((value): value is string => Boolean(value?.trim()));

    let preparedJobId: string | null = null;
    let preparedQuoteId: string | null = null;
    let preparedClientAddress: string | null = null;

    for (const privateKey of candidateKeys) {
      const clientAddress = privateKeyToAccount(privateKey as `0x${string}`).address;
      const quoteBody = makeQuoteBody(clientAddress);
      const quoteReq = new NextRequest("http://localhost/api/wire/quote", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(quoteBody),
      });
      const quoteRes = await quotePost(quoteReq);
      const quoteJson = (await quoteRes.json()) as Record<string, unknown>;
      if (quoteRes.status !== 200 || typeof quoteJson.quoteId !== "string") {
        continue;
      }

      cleanupQuoteIds.add(quoteJson.quoteId);

      const prepareReq = new NextRequest("http://localhost/api/wire/jobs", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(
          makePrepareBody({
            quoteId: quoteJson.quoteId,
            clientAddress,
            providerAddress: quoteBody.provider,
            evaluatorAddress: quoteBody.evaluator,
          }),
        ),
      });
      const prepareRes = await jobsPost(prepareReq);
      const prepareJson = (await prepareRes.json()) as Record<string, unknown>;

      if (prepareRes.status !== 200 || typeof prepareJson.jobId !== "string") {
        continue;
      }

      preparedJobId = prepareJson.jobId;
      preparedQuoteId = quoteJson.quoteId;
      preparedClientAddress = clientAddress;
      cleanupJobIds.add(preparedJobId);

      assert(
        typeof (prepareJson.direct as Record<string, unknown> | undefined)?.createTxRequest === "object",
        "Expected createTxRequest in direct GhostWire prepare response.",
      );
      assert(
        (prepareJson.direct as Record<string, unknown> | undefined)?.nextAction === "submit_create_artifact",
        "Expected nextAction=submit_create_artifact in direct GhostWire prepare response.",
      );
      break;
    }

    if (preparedJobId && preparedQuoteId && preparedClientAddress) {
      const getJobRes = await getWireJob(
        new NextRequest(`http://localhost/api/wire/jobs/${preparedJobId}`, { method: "GET" }),
        { params: Promise.resolve({ jobId: preparedJobId }) },
      );
      const getJobBody = (await getJobRes.json()) as Record<string, unknown>;
      const getJobPayload = getJobBody.job as Record<string, unknown> | undefined;

      assert(getJobRes.status === 200, `Expected prepared job fetch 200, got ${getJobRes.status}`);
      assert(getJobPayload?.contractState === "OPEN", `Expected OPEN contract state, got ${String(getJobPayload?.contractState)}`);
      assert(
        (getJobPayload?.operator as Record<string, unknown> | undefined)?.artifactStatus === "PENDING",
        "Expected artifactStatus=PENDING for prepared direct GhostWire job.",
      );

      const missingAuthArtifactsReq = new NextRequest(`http://localhost/api/wire/jobs/${preparedJobId}/artifacts`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          createTxHash: `0x${"ab".repeat(32)}`,
        }),
      });
      const missingAuthArtifactsRes = await postArtifacts(missingAuthArtifactsReq, {
        params: Promise.resolve({ jobId: preparedJobId }),
      });
      const missingAuthArtifactsBody = (await missingAuthArtifactsRes.json()) as Record<string, unknown>;

      assert(
        missingAuthArtifactsRes.status === 401,
        `Expected missing-auth artifact submission 401, got ${missingAuthArtifactsRes.status}`,
      );
      assert(
        missingAuthArtifactsBody.errorCode === "WIRE_ARTIFACT_AUTH_REQUIRED",
        `Expected WIRE_ARTIFACT_AUTH_REQUIRED, got ${String(missingAuthArtifactsBody.errorCode)}`,
      );
    } else {
      console.log("No locally funded direct GhostWire client key was available. Skipped prepared-job auth gate check.");
    }

    console.log("Direct GhostWire verification passed.");
  } finally {
    for (const jobId of cleanupJobIds) {
      const record = await prisma.wireJob.findUnique({
        where: { jobId },
        select: { id: true, quoteId: true },
      });
      if (!record) continue;

      await prisma.wireWebhookOutbox.deleteMany({ where: { wireJobId: record.id } });
      await prisma.wireOperatorSpend.deleteMany({ where: { wireJobId: record.id } });
      await prisma.wireJobTransition.deleteMany({ where: { wireJobId: record.id } });
      await prisma.wireJobWorkflow.deleteMany({ where: { wireJobId: record.id } });
      await prisma.wireJob.deleteMany({ where: { id: record.id } });
      cleanupQuoteIds.delete(record.quoteId);
      await prisma.wireQuote.deleteMany({ where: { quoteId: record.quoteId } });
    }

    for (const quoteId of cleanupQuoteIds) {
      await prisma.wireQuote.deleteMany({ where: { quoteId } });
    }

    await prisma.$disconnect();
  }
};

run().catch((error) => {
  console.error("Direct GhostWire verification failed.");
  console.error(error);
  process.exitCode = 1;
});
