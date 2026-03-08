#!/usr/bin/env node

import { privateKeyToAccount } from "viem/accounts";
import {
  DEFAULT_BASE_URL,
  DEFAULT_CHAIN_ID,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_X402_SCHEME,
  createNonce,
  decodeBase64Json,
  encodeBase64Json,
  fetchWithTimeout,
  normalizeBaseUrl,
  parseCliArgs,
  parseJson,
  parsePositiveInt,
  printJson,
  toBool,
} from "./shared.mjs";

const args = parseCliArgs();

const baseUrl = normalizeBaseUrl(args["base-url"] || process.env.GHOST_OPENCLAW_BASE_URL || DEFAULT_BASE_URL);
const serviceSlug = String(args.service || process.env.GHOST_OPENCLAW_SERVICE_SLUG || "").trim();
const method = String(args.method || "POST").trim().toUpperCase() || "POST";
const chainId = parsePositiveInt(args["chain-id"] || process.env.GHOST_OPENCLAW_CHAIN_ID, DEFAULT_CHAIN_ID);
const timeoutMs = parsePositiveInt(args["timeout-ms"] || process.env.GHOST_OPENCLAW_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
const scheme = String(args.scheme || process.env.GHOST_OPENCLAW_X402_SCHEME || DEFAULT_X402_SCHEME).trim();
const dryRun = toBool(args["dry-run"], false);
const privateKey = String(args["private-key"] || process.env.GHOST_SIGNER_PRIVATE_KEY || "").trim();
const gatePathArg = String(args["gate-path"] || "").trim();
const gatePath = gatePathArg
  ? gatePathArg.replace("{service}", encodeURIComponent(serviceSlug))
  : `/api/gate/${encodeURIComponent(serviceSlug)}`;
const url = `${baseUrl}${gatePath}`;

const bodyJsonArg = String(args["body-json"] || "").trim();
const bodyJson = bodyJsonArg ? parseJson(bodyJsonArg, undefined) : undefined;

if (!serviceSlug) {
  printJson({
    ok: false,
    error: "Missing required --service (or GHOST_OPENCLAW_SERVICE_SLUG).",
    example:
      "node integrations/openclaw-ghost-pay/bin/pay-gate-x402.mjs --service agent-18755 --method POST --body-json '{\"prompt\":\"hello\"}'",
  });
  process.exitCode = 1;
} else if (bodyJsonArg && bodyJson === undefined) {
  printJson({
    ok: false,
    error: "Invalid JSON passed to --body-json.",
  });
  process.exitCode = 1;
} else if (!privateKey && !dryRun) {
  printJson({
    ok: false,
    error: "Missing signer private key. Set GHOST_SIGNER_PRIVATE_KEY or pass --private-key.",
  });
  process.exitCode = 1;
} else {
  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = {
      service: serviceSlug,
      timestamp,
      nonce: createNonce(16),
    };

    const signature = privateKey
      ? await privateKeyToAccount(privateKey).signTypedData({
          domain: {
            name: "GhostGate",
            version: "1",
            chainId,
          },
          types: {
            Access: [
              { name: "service", type: "string" },
              { name: "timestamp", type: "uint256" },
              { name: "nonce", type: "string" },
            ],
          },
          primaryType: "Access",
          message: payload,
        })
      : "<missing-private-key>";

    const envelope = {
      x402Version: 2,
      scheme,
      network: `eip155:${chainId}`,
      payload,
      signature,
    };

    if (dryRun) {
      printJson({
        ok: true,
        mode: "dry-run",
        request: {
          url,
          method,
          headers: {
            accept: "application/json, text/plain;q=0.9, */*;q=0.8",
            "payment-signature": "<base64-json-envelope>",
            ...(bodyJson !== undefined ? { "content-type": "application/json" } : {}),
          },
          envelope,
          body: bodyJson ?? null,
          signed: privateKey ? true : false,
        },
        warnings: privateKey ? [] : ["Dry-run generated unsigned envelope preview (no private key provided)."],
      });
      process.exit(0);
    }

    const headers = {
      accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      "payment-signature": encodeBase64Json(envelope),
      ...(bodyJson !== undefined ? { "content-type": "application/json" } : {}),
    };

    const response = await fetchWithTimeout(
      url,
      {
        method,
        headers,
        ...(bodyJson !== undefined && method !== "GET" && method !== "HEAD" ? { body: JSON.stringify(bodyJson) } : {}),
      },
      timeoutMs,
    );

    const rawBody = await response.text();
    const parsedBody = parseJson(rawBody, null);
    const paymentRequired = decodeBase64Json(response.headers.get("payment-required"));
    const paymentResponse = decodeBase64Json(response.headers.get("payment-response"));

    printJson({
      ok: response.ok,
      status: response.status,
      url,
      request: {
        serviceSlug,
        method,
        chainId,
        scheme,
      },
      response: {
        paymentRequired,
        paymentResponse,
        body: parsedBody ?? rawBody,
      },
    });

    if (!response.ok) process.exitCode = 1;
  } catch (error) {
    printJson({
      ok: false,
      error: error instanceof Error ? error.message : "Unknown failure",
      url,
      serviceSlug,
    });
    process.exitCode = 1;
  }
}
