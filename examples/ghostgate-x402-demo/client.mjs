#!/usr/bin/env node

import { config as loadEnv } from "dotenv";
import { privateKeyToAccount } from "viem/accounts";

loadEnv({ path: ".env", quiet: true });
loadEnv({ path: ".env.local", override: true, quiet: true });

const DOMAIN = {
  name: "GhostGate",
  version: "1",
};

const TYPES = {
  Access: [
    { name: "service", type: "string" },
    { name: "timestamp", type: "uint256" },
    { name: "nonce", type: "string" },
  ],
};

const DEFAULT_BASE_URL = "https://ghostprotocol.cc";
const DEFAULT_SERVICE = "x402-demo";
const DEFAULT_CHAIN_ID = 8453;

const parseArgs = () => {
  const result = {};

  for (let index = 2; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (!arg?.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = process.argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = "true";
      continue;
    }
    result[key] = next;
    index += 1;
  }

  return result;
};

const normalizeBaseUrl = (value) => String(value || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
const encodeBase64Json = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");

const decodeBase64Json = (value) => {
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return null;
  }
};

const parseJson = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const randomNonce = () => `x402-demo-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;

const readResponse = async (response) => {
  const text = await response.text();
  return {
    status: response.status,
    ok: response.ok,
    paymentRequired: decodeBase64Json(response.headers.get("payment-required")),
    paymentResponse: decodeBase64Json(response.headers.get("payment-response")),
    body: text ? parseJson(text) : null,
  };
};

const fail = (message, extra = {}) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: message,
        ...extra,
      },
      null,
      2,
    ),
  );
  process.exit(1);
};

const args = parseArgs();
const baseUrl = normalizeBaseUrl(args["base-url"] || process.env.GHOST_BASE_URL);
const service = String(args.service || process.env.GHOST_SERVICE_SLUG || DEFAULT_SERVICE).trim() || DEFAULT_SERVICE;
const chainId = Number.parseInt(String(args["chain-id"] || process.env.GHOST_CHAIN_ID || DEFAULT_CHAIN_ID), 10);
const privateKey = String(args["private-key"] || process.env.GHOST_SIGNER_PRIVATE_KEY || process.env.PRIVATE_KEY || "").trim();
const prompt = String(args.prompt || "hello from the GhostGate x402 public demo");

if (!privateKey) {
  fail("Missing GHOST_SIGNER_PRIVATE_KEY / PRIVATE_KEY (or --private-key).", {
    example: "npm run example:x402:demo",
  });
}

const account = privateKeyToAccount(privateKey);
const pricingUrl = `${baseUrl}/api/pricing?service=${encodeURIComponent(service)}`;
const gateUrl = `${baseUrl}/api/gate/${encodeURIComponent(service)}`;
const requestBody = { prompt };

const pricingResponse = await fetch(pricingUrl, {
  headers: {
    accept: "application/json",
  },
});

const pricing = await readResponse(pricingResponse);

if (!pricing.ok) {
  fail("Pricing lookup failed.", { pricing });
}

const x402CompatibilityEnabled = pricing.body?.x402CompatibilityEnabled === true;
const x402Scheme =
  typeof pricing.body?.x402Scheme === "string" && pricing.body.x402Scheme.length > 0
    ? pricing.body.x402Scheme
    : "ghost-eip712-credit-v1";

if (!x402CompatibilityEnabled) {
  fail("This environment does not advertise x402 compatibility for the requested service.", { pricing });
}

const challengeResponse = await fetch(gateUrl, {
  method: "POST",
  headers: {
    accept: "application/json",
    "content-type": "application/json",
  },
  body: JSON.stringify(requestBody),
});

const challenge = await readResponse(challengeResponse);

if (challenge.status !== 402) {
  fail("Expected the unauthenticated request to return 402.", { pricing, challenge });
}

const payload = {
  service,
  timestamp: Math.floor(Date.now() / 1000),
  nonce: randomNonce(),
};

const signature = await account.signTypedData({
  domain: {
    ...DOMAIN,
    chainId,
  },
  types: TYPES,
  primaryType: "Access",
  message: payload,
});

const paymentEnvelope = {
  x402Version: 2,
  scheme: x402Scheme,
  network: `eip155:${chainId}`,
  payload,
  signature,
};

const authorizedResponse = await fetch(gateUrl, {
  method: "POST",
  headers: {
    accept: "application/json",
    "content-type": "application/json",
    "payment-signature": encodeBase64Json(paymentEnvelope),
  },
  body: JSON.stringify(requestBody),
});

const authorized = await readResponse(authorizedResponse);

const result = {
  ok: authorized.ok,
  account: account.address,
  service,
  baseUrl,
  steps: {
    pricing,
    challenge,
    authorized,
  },
  notes: authorized.ok
    ? [
        "The first call proved the 402 challenge path.",
        "The second call retried with payment-signature and succeeded.",
      ]
    : [
        "The second call did not succeed.",
        "If the response still shows 402, fund or sync Ghost Credits for this signer before retrying.",
      ],
};

console.log(JSON.stringify(result, null, 2));

if (!authorized.ok) {
  process.exitCode = 1;
}
