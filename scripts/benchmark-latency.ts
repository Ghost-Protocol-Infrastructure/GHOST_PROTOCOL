import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { privateKeyToAccount } from "viem/accounts";
import { GhostFulfillmentConsumer } from "../sdks/node/fulfillment";

type ScenarioName = "mcp" | "gate" | "e2e";

type CliArgs = Record<string, string>;

type AttemptSample = {
  attempt: number;
  scenario: ScenarioName;
  latencyMs: number;
  success: boolean;
  status: number | null;
  timeout: boolean;
  reason: string | null;
};

type ScenarioSummary = {
  scenario: ScenarioName;
  total: number;
  successes: number;
  failures: number;
  successRate: number;
  timeoutCount: number;
  latencyMs: {
    min: number;
    max: number;
    avg: number;
    p50: number;
    p95: number;
    p99: number;
  };
  statusCounts: Record<string, number>;
  failureSamples: AttemptSample[];
};

type BenchmarkReport = {
  generatedAtIso: string;
  gitSha: string | null;
  host: {
    nodeVersion: string;
    platform: string;
    arch: string;
  };
  config: {
    baseUrl: string;
    serviceSlug: string;
    chainId: number;
    iterations: number;
    concurrency: number;
    timeoutMs: number;
    timestampOffsetSeconds: number;
    scenarios: ScenarioName[];
  };
  summaries: ScenarioSummary[];
};

type AttemptResult = {
  latencyMs: number;
  success: boolean;
  status: number | null;
  timeout: boolean;
  reason: string | null;
};

const DEFAULT_BASE_URL = "https://ghostprotocol.cc";
const DEFAULT_CHAIN_ID = 8453;
const DEFAULT_SERVICE_SLUG = "agent-18755";
const DEFAULT_SCENARIO: ScenarioName[] = ["mcp", "gate", "e2e"];
const DEFAULT_ITERATIONS = 50;
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_E2E_PATH = "/ask";
const DEFAULT_E2E_METHOD = "POST";
const DEFAULT_E2E_BODY = { prompt: "Benchmark prompt." };
const DEFAULT_X402_SCHEME = "ghost-eip712-credit-v1";

const ACCESS_TYPES = {
  Access: [
    { name: "service", type: "string" },
    { name: "timestamp", type: "uint256" },
    { name: "nonce", type: "string" },
  ],
} as const;

const parseCliArgs = (argv: string[] = process.argv.slice(2)): CliArgs => {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith("--")) continue;
    const body = token.slice(2);
    if (!body) continue;
    const equalsIndex = body.indexOf("=");
    if (equalsIndex > 0) {
      const key = body.slice(0, equalsIndex);
      const value = body.slice(equalsIndex + 1);
      args[key] = value;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[body] = "true";
      continue;
    }
    args[body] = next;
    i += 1;
  }
  return args;
};

const parseIntStrict = (raw: string | undefined, fallback: number): number => {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
};

const parseOptionalInt = (raw: string | undefined): number | null => {
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
};

const parseScenarioList = (raw: string | undefined): ScenarioName[] => {
  if (!raw) return DEFAULT_SCENARIO;
  const parsed = raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .filter((value): value is ScenarioName => value === "mcp" || value === "gate" || value === "e2e");
  return parsed.length > 0 ? parsed : DEFAULT_SCENARIO;
};

const normalizeBaseUrl = (value: string): string => value.replace(/\/+$/, "");

const parseJsonSafe = <T>(raw: string | undefined, fallback: T): T => {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

const percentile = (numbers: number[], p: number): number => {
  if (numbers.length === 0) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[index].toFixed(2));
};

const average = (numbers: number[]): number =>
  numbers.length ? Number((numbers.reduce((sum, value) => sum + value, 0) / numbers.length).toFixed(2)) : 0;

const resolveGitSha = (): string | null => {
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString("utf8").trim();
  } catch {
    return null;
  }
};

const isTimeoutError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    error.name === "AbortError" ||
    message.includes("timed out") ||
    message.includes("connect timeout") ||
    message.includes("und_err_connect_timeout")
  );
};

const runWithTimeout = async (url: string, timeoutMs: number, options: RequestInit): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal, cache: "no-store" });
  } finally {
    clearTimeout(timer);
  }
};

const encodeBase64Json = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64");

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const resolveServerTimestampOffsetSeconds = async (baseUrl: string, timeoutMs: number): Promise<number> => {
  try {
    const response = await runWithTimeout(`${baseUrl}/api/pricing`, timeoutMs, {
      method: "GET",
      headers: {
        accept: "application/json",
      },
    });
    const dateHeader = response.headers.get("date");
    if (!dateHeader) return 0;
    const parsed = Date.parse(dateHeader);
    if (!Number.isFinite(parsed)) return 0;
    const serverEpochSeconds = Math.floor(parsed / 1000);
    const localEpochSeconds = Math.floor(Date.now() / 1000);
    const rawOffset = serverEpochSeconds - localEpochSeconds;
    return clamp(rawOffset, -300, 300);
  } catch {
    return 0;
  }
};

const createMcpAttempt =
  (input: {
    baseUrl: string;
    serviceSlug: string;
    timeoutMs: number;
  }) =>
  async (): Promise<AttemptResult> => {
    const start = performance.now();
    try {
      const response = await runWithTimeout(`${input.baseUrl}/api/mcp/read-only`, input.timeoutMs, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `bench-mcp-${Date.now()}`,
          method: "tools/call",
          params: {
            name: "get_payment_requirements",
            arguments: { service_slug: input.serviceSlug },
          },
        }),
      });

      const rawBody = await response.text();
      const body = parseJsonSafe<Record<string, unknown> | null>(rawBody, null);
      const rpcError = body && typeof body === "object" ? body.error : null;

      const latencyMs = Number((performance.now() - start).toFixed(2));
      const success = response.status === 200 && !rpcError;

      return {
        latencyMs,
        success,
        status: response.status,
        timeout: false,
        reason: success ? null : rpcError ? "mcp_rpc_error" : `http_${response.status}`,
      };
    } catch (error) {
      const latencyMs = Number((performance.now() - start).toFixed(2));
      return {
        latencyMs,
        success: false,
        status: null,
        timeout: isTimeoutError(error),
        reason: error instanceof Error ? error.message : "unknown_mcp_error",
      };
    }
  };

const createGateAttempt =
  (input: {
    baseUrl: string;
    serviceSlug: string;
    chainId: number;
    privateKey: `0x${string}`;
    timeoutMs: number;
    method: string;
    body: unknown;
    x402Scheme: string;
    timestampOffsetSeconds: number;
  }) =>
  async (): Promise<AttemptResult> => {
    const account = privateKeyToAccount(input.privateKey);
    const start = performance.now();
    try {
      const timestamp = BigInt(Math.floor(Date.now() / 1000) + input.timestampOffsetSeconds);
      const payload = {
        service: input.serviceSlug,
        timestamp,
        nonce: randomUUID().replace(/-/g, ""),
      };

      const signature = await account.signTypedData({
        domain: {
          name: "GhostGate",
          version: "1",
          chainId: input.chainId,
        },
        types: ACCESS_TYPES,
        primaryType: "Access",
        message: payload,
      });

      const envelope = {
        x402Version: 2,
        scheme: input.x402Scheme,
        network: `eip155:${input.chainId}`,
        payload: {
          service: payload.service,
          timestamp: payload.timestamp.toString(),
          nonce: payload.nonce,
        },
        signature,
      };

      const method = input.method.toUpperCase();
      const shouldSendBody = method !== "GET" && method !== "HEAD" && input.body !== undefined;
      const response = await runWithTimeout(`${input.baseUrl}/api/gate/${encodeURIComponent(input.serviceSlug)}`, input.timeoutMs, {
        method,
        headers: {
          accept: "application/json, text/plain;q=0.9, */*;q=0.8",
          "payment-signature": encodeBase64Json(envelope),
          ...(shouldSendBody ? { "content-type": "application/json" } : {}),
        },
        ...(shouldSendBody ? { body: JSON.stringify(input.body) } : {}),
      });

      const latencyMs = Number((performance.now() - start).toFixed(2));
      return {
        latencyMs,
        success: response.status === 200,
        status: response.status,
        timeout: false,
        reason: response.status === 200 ? null : `http_${response.status}`,
      };
    } catch (error) {
      const latencyMs = Number((performance.now() - start).toFixed(2));
      return {
        latencyMs,
        success: false,
        status: null,
        timeout: isTimeoutError(error),
        reason: error instanceof Error ? error.message : "unknown_gate_error",
      };
    }
  };

const createE2eAttempt =
  (input: {
    consumer: GhostFulfillmentConsumer;
    serviceSlug: string;
    method: string;
    path: string;
    body: unknown;
  }) =>
  async (): Promise<AttemptResult> => {
    const start = performance.now();
    try {
      const result = await input.consumer.execute({
        serviceSlug: input.serviceSlug,
        method: input.method,
        path: input.path,
        body: input.body,
        cost: 1,
        clientRequestId: `bench-e2e-${randomUUID()}`,
      });

      const merchantStatus = result.merchant.status;
      const captureDisposition = (() => {
        const body = result.merchant.bodyJson;
        if (!body || typeof body !== "object" || Array.isArray(body)) return null;
        const fulfillment = (body as Record<string, unknown>).fulfillment;
        if (!fulfillment || typeof fulfillment !== "object" || Array.isArray(fulfillment)) return null;
        const capturePayload = (fulfillment as Record<string, unknown>).capturePayload;
        if (!capturePayload || typeof capturePayload !== "object" || Array.isArray(capturePayload)) return null;
        const value = (capturePayload as Record<string, unknown>).captureDisposition;
        return typeof value === "string" ? value : null;
      })();

      const success = result.ticket.status === 200 && merchantStatus === 200 && captureDisposition === "CAPTURED";
      const latencyMs = Number((performance.now() - start).toFixed(2));
      const primaryStatus = merchantStatus ?? result.ticket.status ?? null;

      return {
        latencyMs,
        success,
        status: primaryStatus,
        timeout: false,
        reason: success
          ? null
          : `ticket_${result.ticket.status}_merchant_${merchantStatus ?? "none"}_capture_${captureDisposition ?? "none"}`,
      };
    } catch (error) {
      const latencyMs = Number((performance.now() - start).toFixed(2));
      return {
        latencyMs,
        success: false,
        status: null,
        timeout: isTimeoutError(error),
        reason: error instanceof Error ? error.message : "unknown_e2e_error",
      };
    }
  };

const runScenario = async (
  scenario: ScenarioName,
  iterations: number,
  concurrency: number,
  attemptFn: () => Promise<AttemptResult>,
): Promise<ScenarioSummary> => {
  const samples: AttemptSample[] = [];
  let index = 0;

  const worker = async () => {
    while (true) {
      const current = index;
      index += 1;
      if (current >= iterations) return;
      const result = await attemptFn();
      samples.push({
        attempt: current + 1,
        scenario,
        ...result,
      });
    }
  };

  const workerCount = Math.max(1, Math.min(concurrency, iterations));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const latencies = samples.map((sample) => sample.latencyMs);
  const successes = samples.filter((sample) => sample.success).length;
  const failures = samples.length - successes;
  const timeoutCount = samples.filter((sample) => sample.timeout).length;
  const statusCounts = samples.reduce<Record<string, number>>((acc, sample) => {
    const key = sample.status == null ? "null" : String(sample.status);
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const failureSamples = samples.filter((sample) => !sample.success).slice(0, 10);

  return {
    scenario,
    total: samples.length,
    successes,
    failures,
    successRate: samples.length ? Number(((successes / samples.length) * 100).toFixed(2)) : 0,
    timeoutCount,
    latencyMs: {
      min: latencies.length ? Number(Math.min(...latencies).toFixed(2)) : 0,
      max: latencies.length ? Number(Math.max(...latencies).toFixed(2)) : 0,
      avg: average(latencies),
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
    },
    statusCounts,
    failureSamples,
  };
};

const printSummary = (summary: ScenarioSummary): void => {
  console.log(`\n[${summary.scenario}]`);
  console.log(
    `total=${summary.total} success=${summary.successes} fail=${summary.failures} success_rate=${summary.successRate}% timeout=${summary.timeoutCount}`,
  );
  console.log(
    `latency_ms p50=${summary.latencyMs.p50} p95=${summary.latencyMs.p95} p99=${summary.latencyMs.p99} avg=${summary.latencyMs.avg} min=${summary.latencyMs.min} max=${summary.latencyMs.max}`,
  );
  console.log(`status_counts=${JSON.stringify(summary.statusCounts)}`);
  if (summary.failureSamples.length > 0) {
    console.log(`failure_samples=${JSON.stringify(summary.failureSamples.slice(0, 3))}`);
  }
};

const run = async (): Promise<void> => {
  const args = parseCliArgs();

  const baseUrl = normalizeBaseUrl(args["base-url"] || process.env.BENCH_BASE_URL || DEFAULT_BASE_URL);
  const serviceSlug = (args.service || process.env.BENCH_SERVICE_SLUG || DEFAULT_SERVICE_SLUG).trim();
  const chainId = parseIntStrict(args["chain-id"] || process.env.BENCH_CHAIN_ID, DEFAULT_CHAIN_ID);
  const iterations = parseIntStrict(args.iterations || process.env.BENCH_ITERATIONS, DEFAULT_ITERATIONS);
  const concurrency = parseIntStrict(args.concurrency || process.env.BENCH_CONCURRENCY, DEFAULT_CONCURRENCY);
  const timeoutMs = parseIntStrict(args["timeout-ms"] || process.env.BENCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const scenarios = parseScenarioList(args.scenario || process.env.BENCH_SCENARIO);
  const privateKeyRaw = (args["private-key"] || process.env.BENCH_PRIVATE_KEY || process.env.GHOST_SIGNER_PRIVATE_KEY || "").trim();
  const x402Scheme = (args["x402-scheme"] || process.env.BENCH_X402_SCHEME || DEFAULT_X402_SCHEME).trim();
  const gateMethod = (args["gate-method"] || process.env.BENCH_GATE_METHOD || "POST").trim().toUpperCase();
  const gateBody = parseJsonSafe(args["gate-body-json"] || process.env.BENCH_GATE_BODY_JSON, { ping: "benchmark" });
  const e2ePath = (args["e2e-path"] || process.env.BENCH_E2E_PATH || DEFAULT_E2E_PATH).trim();
  const e2eMethod = (args["e2e-method"] || process.env.BENCH_E2E_METHOD || DEFAULT_E2E_METHOD).trim().toUpperCase();
  const e2eBody = parseJsonSafe(args["e2e-body-json"] || process.env.BENCH_E2E_BODY_JSON, DEFAULT_E2E_BODY);
  const configuredTimestampOffset = parseOptionalInt(args["timestamp-offset-seconds"] || process.env.BENCH_TIMESTAMP_OFFSET_SECONDS);
  const timestampOffsetSeconds =
    configuredTimestampOffset == null
      ? await resolveServerTimestampOffsetSeconds(baseUrl, timeoutMs)
      : clamp(configuredTimestampOffset, -300, 300);
  const outputPath = (
    args.output ||
    process.env.BENCH_OUTPUT ||
    join("artifacts", "benchmarks", `benchmark-${new Date().toISOString().replace(/[:.]/g, "-")}.json`)
  ).trim();

  const summaries: ScenarioSummary[] = [];

  for (const scenario of scenarios) {
    if (scenario === "mcp") {
      console.log(`Running scenario=mcp iterations=${iterations} concurrency=${concurrency} ...`);
      summaries.push(
        await runScenario(
          "mcp",
          iterations,
          concurrency,
          createMcpAttempt({
            baseUrl,
            serviceSlug,
            timeoutMs,
          }),
        ),
      );
      continue;
    }

    if (!/^0x[a-fA-F0-9]{64}$/.test(privateKeyRaw)) {
      throw new Error(`Scenario '${scenario}' requires BENCH_PRIVATE_KEY (0x-prefixed 32-byte key).`);
    }
    const privateKey = privateKeyRaw as `0x${string}`;

    if (scenario === "gate") {
      console.log(`Running scenario=gate iterations=${iterations} concurrency=${concurrency} ...`);
      summaries.push(
        await runScenario(
          "gate",
          iterations,
          concurrency,
          createGateAttempt({
            baseUrl,
            serviceSlug,
            chainId,
            privateKey,
            timeoutMs,
            method: gateMethod,
            body: gateBody,
            x402Scheme,
            timestampOffsetSeconds,
          }),
        ),
      );
      continue;
    }

    if (scenario === "e2e") {
      console.log(`Running scenario=e2e iterations=${iterations} concurrency=${concurrency} ...`);
      const consumer = new GhostFulfillmentConsumer({
        baseUrl,
        privateKey,
        chainId,
        defaultServiceSlug: serviceSlug,
      });
      summaries.push(
        await runScenario(
          "e2e",
          iterations,
          concurrency,
          createE2eAttempt({
            consumer,
            serviceSlug,
            method: e2eMethod,
            path: e2ePath,
            body: e2eBody,
          }),
        ),
      );
    }
  }

  const report: BenchmarkReport = {
    generatedAtIso: new Date().toISOString(),
    gitSha: resolveGitSha(),
    host: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    config: {
      baseUrl,
      serviceSlug,
      chainId,
      iterations,
      concurrency,
      timeoutMs,
      timestampOffsetSeconds,
      scenarios,
    },
    summaries,
  };

  for (const summary of summaries) {
    printSummary(summary);
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`\nSaved benchmark report: ${outputPath}`);
};

run().catch((error) => {
  console.error("Benchmark run failed.");
  console.error(error);
  process.exitCode = 1;
});
