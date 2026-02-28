import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildFulfillmentDeliveryProofEnvelope,
  buildFulfillmentDeliveryProofTypedData,
  buildFulfillmentEip712Domain,
  buildFulfillmentTicketEnvelope,
  buildFulfillmentTicketHeaders,
  buildFulfillmentTicketRequestAuthTypedData,
  buildFulfillmentTicketTypedData,
  hashFulfillmentDeliveryProofTypedData,
  hashFulfillmentTicketRequestAuthTypedData,
  hashFulfillmentTicketTypedData,
  normalizeFulfillmentDeliveryProofMessage,
  normalizeFulfillmentTicketMessage,
  normalizeFulfillmentTicketRequestAuthMessage,
} from "@/lib/fulfillment-eip712";
import {
  canonicalizeFulfillmentQuery,
  canonicalizeJsonJcs,
  hashCanonicalFulfillmentBodyJson,
  hashCanonicalFulfillmentQuery,
} from "@/lib/fulfillment-hash";

const FIXTURE_DIR = join(process.cwd(), "sdks", "shared");
const HASH_FIXTURE_PATH = join(FIXTURE_DIR, "fulfillment-hash-fixtures.json");
const EIP712_FIXTURE_PATH = join(FIXTURE_DIR, "fulfillment-eip712-fixtures.json");

const stringify = (value: unknown): string =>
  JSON.stringify(value, (_key, entry) => (typeof entry === "bigint" ? entry.toString() : entry), 2);

const main = async (): Promise<void> => {
  await mkdir(FIXTURE_DIR, { recursive: true });

  const jsonCases = [
    {
      name: "simple_sorted_object",
      input: { b: 2, a: 1 },
    },
    {
      name: "nested_utf8_array",
      input: {
        service: "agent-18755",
        payload: { z: ["x", true, null, { "\u00E9": "\u2713" }], a: "hello" },
      },
    },
    {
      name: "number_and_escape_handling",
      input: {
        path: "/ask",
        quote: "\"hello\"",
        amount: 1.25,
        zero: -0,
      },
    },
  ] as const;

  const queryCases = [
    { name: "empty", input: "" },
    { name: "key_only", input: "debug" },
    { name: "plus_space_and_sorting", input: "b=two+words&a=%2fapi%2fv1&z=last" },
    { name: "utf8_and_reserved", input: "q=%E2%9C%93+ok&msg=a%2Bb%26c&path=%2fapi%2fv1" },
    { name: "question_prefix", input: "?name=MerchantAgent&mode=consumer" },
  ] as const;

  const queryRejectCases = [
    { name: "duplicate_key", input: "a=1&a=2" },
    { name: "empty_key", input: "=value" },
    { name: "malformed_percent", input: "bad=%ZZ" },
  ] as const;

  const hashFixture = {
    version: 1,
    jsonCases: jsonCases.map((entry) => ({
      name: entry.name,
      input: entry.input,
      canonical: canonicalizeJsonJcs(entry.input),
      sha256: hashCanonicalFulfillmentBodyJson(entry.input),
    })),
    queryCases: queryCases.map((entry) => {
      const canonical = canonicalizeFulfillmentQuery(entry.input);
      return {
        name: entry.name,
        input: entry.input,
        canonical: canonical.canonical,
        parsedPairs: canonical.pairs,
        sha256: hashCanonicalFulfillmentQuery(entry.input),
      };
    }),
    queryRejectCases: queryRejectCases.map((entry) => {
      try {
        canonicalizeFulfillmentQuery(entry.input);
        throw new Error(`Expected canonicalizeFulfillmentQuery to reject '${entry.name}'`);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        return {
          name: entry.name,
          input: entry.input,
          errorCode: "code" in error && typeof (error as { code?: string }).code === "string"
            ? (error as { code: string }).code
            : "UNKNOWN",
        };
      }
    }),
  };

  const protocolSignerPrivateKey =
    "0x1111111111111111111111111111111111111111111111111111111111111111" as const;
  const consumerPrivateKey =
    "0x2222222222222222222222222222222222222222222222222222222222222222" as const;
  const merchantSignerPrivateKey =
    "0x3333333333333333333333333333333333333333333333333333333333333333" as const;

  const protocolSigner = privateKeyToAccount(protocolSignerPrivateKey);
  const consumer = privateKeyToAccount(consumerPrivateKey);
  const merchantSigner = privateKeyToAccount(merchantSignerPrivateKey);

  const domain = buildFulfillmentEip712Domain(8453);
  const queryHash = hashFixture.queryCases.find((c) => c.name === "utf8_and_reserved")?.sha256;
  const bodyHash = hashFixture.jsonCases.find((c) => c.name === "nested_utf8_array")?.sha256;
  if (!queryHash || !bodyHash) throw new Error("Fixture prerequisites missing.");

  const ticketMessage = normalizeFulfillmentTicketMessage({
    ticketId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    consumer: consumer.address.toLowerCase(),
    merchantOwner: "0xf0f6152c8b02a48a00c73c6dcac0c7748c0b4fbe",
    gatewayConfigIdHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    serviceSlug: "agent-18755",
    method: "post",
    path: "/ask",
    queryHash,
    bodyHash,
    cost: "1",
    issuedAt: "1730000000",
    expiresAt: "1730000060",
  });

  const deliveryProofMessage = normalizeFulfillmentDeliveryProofMessage({
    ticketId: ticketMessage.ticketId,
    deliveryProofId: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    merchantSigner: merchantSigner.address.toLowerCase(),
    serviceSlug: ticketMessage.serviceSlug,
    completedAt: "1730000030",
    statusCode: 200,
    latencyMs: 387,
    responseHash: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  });

  const requestAuthMessage = normalizeFulfillmentTicketRequestAuthMessage({
    action: "fulfillment_ticket",
    serviceSlug: ticketMessage.serviceSlug,
    method: "post",
    path: "/ask",
    queryHash: ticketMessage.queryHash,
    bodyHash: ticketMessage.bodyHash,
    cost: 1,
    issuedAt: "1730000000",
    nonce: "ticket-req-nonce-001",
  });

  const ticketSignature = (await protocolSigner.signTypedData(buildFulfillmentTicketTypedData(ticketMessage))) as
    | `0x${string}`
    | string;
  const deliveryProofSignature = (await merchantSigner.signTypedData(
    buildFulfillmentDeliveryProofTypedData(deliveryProofMessage),
  )) as `0x${string}` | string;
  const requestAuthSignature = (await consumer.signTypedData(
    buildFulfillmentTicketRequestAuthTypedData(requestAuthMessage),
  )) as `0x${string}` | string;

  const ticketEnvelope = buildFulfillmentTicketEnvelope(ticketMessage, ticketSignature);
  const deliveryProofEnvelope = buildFulfillmentDeliveryProofEnvelope(deliveryProofMessage, deliveryProofSignature);

  const eip712Fixture = {
    version: 1,
    domain,
    signers: {
      protocolSigner: {
        privateKey: protocolSignerPrivateKey,
        address: protocolSigner.address.toLowerCase(),
      },
      consumer: {
        privateKey: consumerPrivateKey,
        address: consumer.address.toLowerCase(),
      },
      merchantSigner: {
        privateKey: merchantSignerPrivateKey,
        address: merchantSigner.address.toLowerCase(),
      },
    },
    ticket: {
      message: ticketMessage,
      typedHash: hashFulfillmentTicketTypedData(ticketMessage, { chainId: domain.chainId }),
      signature: String(ticketSignature).toLowerCase(),
      transport: {
        envelope: ticketEnvelope,
        headers: buildFulfillmentTicketHeaders({
          ticketId: ticketMessage.ticketId,
          ticket: ticketEnvelope,
          clientRequestId: "client-req-123",
        }),
      },
    },
    deliveryProof: {
      message: deliveryProofMessage,
      typedHash: hashFulfillmentDeliveryProofTypedData(deliveryProofMessage, { chainId: domain.chainId }),
      signature: String(deliveryProofSignature).toLowerCase(),
      transport: {
        envelope: deliveryProofEnvelope,
      },
    },
    ticketRequestAuth: {
      message: requestAuthMessage,
      typedHash: hashFulfillmentTicketRequestAuthTypedData(requestAuthMessage, { chainId: domain.chainId }),
      signature: String(requestAuthSignature).toLowerCase(),
      transport: {
        payload: Buffer.from(
          JSON.stringify(requestAuthMessage, (_key, entry) => (typeof entry === "bigint" ? entry.toString() : entry)),
          "utf8",
        ).toString("base64url"),
      },
    },
  };

  await writeFile(HASH_FIXTURE_PATH, stringify(hashFixture), "utf8");
  await writeFile(EIP712_FIXTURE_PATH, stringify(eip712Fixture), "utf8");

  console.log(`Wrote ${HASH_FIXTURE_PATH}`);
  console.log(`Wrote ${EIP712_FIXTURE_PATH}`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
