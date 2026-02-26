import { privateKeyToAccount } from "viem/accounts";
import hashFixtures from "@/sdks/shared/fulfillment-hash-fixtures.json";
import eip712Fixtures from "@/sdks/shared/fulfillment-eip712-fixtures.json";
import {
  FULFILLMENT_EIP712_TYPES,
  buildFulfillmentDeliveryProofEnvelope,
  buildFulfillmentTicketEnvelope,
  buildFulfillmentTicketHeaders,
  hashFulfillmentDeliveryProofTypedData,
  hashFulfillmentTicketRequestAuthTypedData,
  hashFulfillmentTicketTypedData,
  normalizeFulfillmentDeliveryProofMessage,
  normalizeFulfillmentTicketMessage,
  normalizeFulfillmentTicketRequestAuthMessage,
  parseFulfillmentTicketHeaders,
  parseWireFulfillmentDeliveryProofMessage,
  parseWireFulfillmentTicketMessage,
  parseWireFulfillmentTicketRequestAuthMessage,
} from "@/lib/fulfillment-eip712";
import {
  canonicalizeFulfillmentQuery,
  canonicalizeJsonJcs,
  hashCanonicalFulfillmentBodyJson,
  hashCanonicalFulfillmentQuery,
} from "@/lib/fulfillment-hash";

function assertTrue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const stableStringify = (value: unknown): string =>
  JSON.stringify(value, (_key, entry) => (typeof entry === "bigint" ? entry.toString() : entry));

type FixtureDomainShape = {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: `0x${string}`;
};

const main = async (): Promise<void> => {
  let jsonCaseCount = 0;
  let queryCaseCount = 0;
  let queryRejectCaseCount = 0;
  const fixtureDomain = eip712Fixtures.domain as FixtureDomainShape;

  for (const testCase of hashFixtures.jsonCases) {
    const canonical = canonicalizeJsonJcs(testCase.input);
    const sha256 = hashCanonicalFulfillmentBodyJson(testCase.input);
    assertTrue(canonical === testCase.canonical, `JSON canonical mismatch: ${testCase.name}`);
    assertTrue(sha256 === testCase.sha256, `JSON hash mismatch: ${testCase.name}`);
    jsonCaseCount += 1;
  }

  for (const testCase of hashFixtures.queryCases) {
    const canonical = canonicalizeFulfillmentQuery(testCase.input);
    const sha256 = hashCanonicalFulfillmentQuery(testCase.input);
    assertTrue(canonical.canonical === testCase.canonical, `Query canonical mismatch: ${testCase.name}`);
    assertTrue(
      stableStringify(canonical.pairs) === stableStringify(testCase.parsedPairs),
      `Query pairs mismatch: ${testCase.name}`,
    );
    assertTrue(sha256 === testCase.sha256, `Query hash mismatch: ${testCase.name}`);
    queryCaseCount += 1;
  }

  for (const testCase of hashFixtures.queryRejectCases) {
    try {
      canonicalizeFulfillmentQuery(testCase.input);
      throw new Error(`Expected query reject for ${testCase.name}`);
    } catch (error) {
      if (!(error instanceof Error)) {
        throw new Error(`Unknown error type for query reject ${testCase.name}`);
      }
      const code = "code" in error ? (error as { code?: string }).code : undefined;
      assertTrue(code === testCase.errorCode, `Query reject code mismatch for ${testCase.name}: ${String(code)}`);
    }
    queryRejectCaseCount += 1;
  }

  const protocolSigner = privateKeyToAccount(eip712Fixtures.signers.protocolSigner.privateKey as `0x${string}`);
  const consumer = privateKeyToAccount(eip712Fixtures.signers.consumer.privateKey as `0x${string}`);
  const merchantSigner = privateKeyToAccount(eip712Fixtures.signers.merchantSigner.privateKey as `0x${string}`);

  const ticketMessage = normalizeFulfillmentTicketMessage(
    eip712Fixtures.ticket.message as Parameters<typeof normalizeFulfillmentTicketMessage>[0],
  );
  const deliveryProofMessage = normalizeFulfillmentDeliveryProofMessage(
    eip712Fixtures.deliveryProof.message as Parameters<typeof normalizeFulfillmentDeliveryProofMessage>[0],
  );
  const ticketRequestAuthMessage = normalizeFulfillmentTicketRequestAuthMessage(
    eip712Fixtures.ticketRequestAuth.message as Parameters<typeof normalizeFulfillmentTicketRequestAuthMessage>[0],
  );

  const ticketTypedHash = hashFulfillmentTicketTypedData(ticketMessage, { chainId: eip712Fixtures.domain.chainId });
  const deliveryTypedHash = hashFulfillmentDeliveryProofTypedData(deliveryProofMessage, {
    chainId: eip712Fixtures.domain.chainId,
  });
  const requestAuthTypedHash = hashFulfillmentTicketRequestAuthTypedData(ticketRequestAuthMessage, {
    chainId: eip712Fixtures.domain.chainId,
  });

  assertTrue(ticketTypedHash === eip712Fixtures.ticket.typedHash, "Ticket typed hash mismatch");
  assertTrue(deliveryTypedHash === eip712Fixtures.deliveryProof.typedHash, "Delivery proof typed hash mismatch");
  assertTrue(requestAuthTypedHash === eip712Fixtures.ticketRequestAuth.typedHash, "Ticket request auth typed hash mismatch");

  const signedTicket = (await protocolSigner.signTypedData({
    domain: fixtureDomain,
      types: { FulfillmentTicket: FULFILLMENT_EIP712_TYPES.FulfillmentTicket },
    primaryType: "FulfillmentTicket",
    message: ticketMessage,
  })) as `0x${string}`;
  const signedDeliveryProof = (await merchantSigner.signTypedData({
    domain: fixtureDomain,
    types: {
      FulfillmentDeliveryProof: FULFILLMENT_EIP712_TYPES.FulfillmentDeliveryProof,
    },
    primaryType: "FulfillmentDeliveryProof",
    message: deliveryProofMessage,
  })) as `0x${string}`;
  const signedTicketRequestAuth = (await consumer.signTypedData({
    domain: fixtureDomain,
    types: {
      FulfillmentTicketRequestAuth: FULFILLMENT_EIP712_TYPES.FulfillmentTicketRequestAuth,
    },
    primaryType: "FulfillmentTicketRequestAuth",
    message: ticketRequestAuthMessage,
  })) as `0x${string}`;

  assertTrue(signedTicket.toLowerCase() === eip712Fixtures.ticket.signature, "Ticket signature mismatch");
  assertTrue(signedDeliveryProof.toLowerCase() === eip712Fixtures.deliveryProof.signature, "Delivery proof signature mismatch");
  assertTrue(
    signedTicketRequestAuth.toLowerCase() === eip712Fixtures.ticketRequestAuth.signature,
    "Ticket request auth signature mismatch",
  );

  const rebuiltTicketEnvelope = buildFulfillmentTicketEnvelope(ticketMessage, eip712Fixtures.ticket.signature);
  const rebuiltTicketHeaders = buildFulfillmentTicketHeaders({
    ticketId: ticketMessage.ticketId,
    ticket: rebuiltTicketEnvelope,
    clientRequestId: "client-req-123",
  });

  assertTrue(
    stableStringify(rebuiltTicketEnvelope) === stableStringify(eip712Fixtures.ticket.transport.envelope),
    "Ticket envelope mismatch",
  );
  assertTrue(
    stableStringify(rebuiltTicketHeaders) === stableStringify(eip712Fixtures.ticket.transport.headers),
    "Ticket headers mismatch",
  );

  const parsedTicketHeaders = parseFulfillmentTicketHeaders(rebuiltTicketHeaders);
  assertTrue(parsedTicketHeaders != null, "Ticket header parser returned null");
  assertTrue(parsedTicketHeaders.ticketId === ticketMessage.ticketId, "Parsed ticketId mismatch");

  const parsedTicketMessage = parseWireFulfillmentTicketMessage(rebuiltTicketEnvelope.payload);
  const parsedDeliveryProofMessage = parseWireFulfillmentDeliveryProofMessage(eip712Fixtures.deliveryProof.transport.envelope.payload);
  const parsedRequestAuthMessage = parseWireFulfillmentTicketRequestAuthMessage(eip712Fixtures.ticketRequestAuth.transport.payload);

  assertTrue(stableStringify(parsedTicketMessage) === stableStringify(ticketMessage), "Parsed wire ticket message mismatch");
  assertTrue(
    stableStringify(parsedDeliveryProofMessage) === stableStringify(deliveryProofMessage),
    "Parsed wire delivery proof message mismatch",
  );
  assertTrue(
    stableStringify(parsedRequestAuthMessage) === stableStringify(ticketRequestAuthMessage),
    "Parsed wire ticket request auth message mismatch",
  );

  const rebuiltDeliveryEnvelope = buildFulfillmentDeliveryProofEnvelope(
    deliveryProofMessage,
    eip712Fixtures.deliveryProof.signature,
  );
  assertTrue(
    stableStringify(rebuiltDeliveryEnvelope) === stableStringify(eip712Fixtures.deliveryProof.transport.envelope),
    "Delivery proof envelope mismatch",
  );

  console.log(
    `Fulfillment fixtures verified: json=${jsonCaseCount}, query=${queryCaseCount}, queryReject=${queryRejectCaseCount}, eip712=3`,
  );
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
