#!/usr/bin/env node

import {
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  fetchWithTimeout,
  normalizeBaseUrl,
  parseCliArgs,
  parseJson,
  parsePositiveInt,
  printJson,
} from "./shared.mjs";

const HEX32_REGEX = /^0x[a-fA-F0-9]{64}$/;

const args = parseCliArgs();
const baseUrl = normalizeBaseUrl(args["base-url"] || process.env.GHOST_OPENCLAW_BASE_URL || DEFAULT_BASE_URL);
const timeoutMs = parsePositiveInt(args["timeout-ms"] || process.env.GHOST_OPENCLAW_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
const endpoint = `${baseUrl}/api/wire/jobs`;

const quoteId = String(args["quote-id"] || process.env.GHOSTWIRE_QUOTE_ID || "").trim();
const clientAddress = String(args.client || args["client-address"] || process.env.GHOSTWIRE_CLIENT_ADDRESS || "").trim();
const providerAddress = String(
  args.provider || args["provider-address"] || process.env.GHOSTWIRE_PROVIDER_ADDRESS || "",
).trim();
const evaluatorAddress = String(
  args.evaluator || args["evaluator-address"] || process.env.GHOSTWIRE_EVALUATOR_ADDRESS || "",
).trim();
const specHash = String(args["spec-hash"] || process.env.GHOSTWIRE_SPEC_HASH || "").trim();
const metadataUri = String(args["metadata-uri"] || process.env.GHOSTWIRE_METADATA_URI || "").trim();
const webhookUrl = String(args["webhook-url"] || process.env.GHOSTWIRE_WEBHOOK_URL || "").trim();
const webhookSecret = String(args["webhook-secret"] || process.env.GHOSTWIRE_WEBHOOK_SECRET || "").trim();
const approvalMode = String(args["approval-mode"] || process.env.GHOSTWIRE_APPROVAL_MODE || "").trim();

if (!quoteId || !clientAddress || !providerAddress || !evaluatorAddress || !specHash) {
  printJson({
    ok: false,
    error: "Missing required --quote-id, --client, --provider, --evaluator, or --spec-hash.",
    example:
      "node integrations/openclaw-ghost-pay/bin/create-wire-job-from-quote.mjs --quote-id wq_... --client 0x... --provider 0x... --evaluator 0x... --spec-hash 0x...",
  });
  process.exitCode = 1;
} else if (!HEX32_REGEX.test(specHash)) {
  printJson({
    ok: false,
    error: "Invalid --spec-hash; expected 32-byte hex string (0x + 64 hex chars).",
  });
  process.exitCode = 1;
} else if ((webhookUrl && !webhookSecret) || (!webhookUrl && webhookSecret)) {
  printJson({
    ok: false,
    error: "webhook-url and webhook-secret must be provided together.",
  });
  process.exitCode = 1;
} else {
  try {
    const body = {
      quoteId,
      client: clientAddress,
      provider: providerAddress,
      evaluator: evaluatorAddress,
      specHash,
      metadataUri: metadataUri || undefined,
      webhookUrl: webhookUrl || undefined,
      webhookSecret: webhookSecret || undefined,
      approvalMode: approvalMode || undefined,
    };

    const response = await fetchWithTimeout(
      endpoint,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
      timeoutMs,
    );

    const rawText = await response.text();
    const payload = parseJson(rawText, null);

    if (!response.ok) {
      printJson({
        ok: false,
        status: response.status,
        endpoint,
        error: payload?.error || "GhostWire job preparation failed.",
        errorCode: payload?.errorCode || null,
        details: payload?.details || null,
        body: payload || rawText,
      });
      process.exitCode = 1;
    } else {
      printJson({
        ok: true,
        status: response.status,
        endpoint,
        preparedJob: payload,
      });
    }
  } catch (error) {
    printJson({
      ok: false,
      endpoint,
      error: error instanceof Error ? error.message : "Unknown failure",
    });
    process.exitCode = 1;
  }
}
