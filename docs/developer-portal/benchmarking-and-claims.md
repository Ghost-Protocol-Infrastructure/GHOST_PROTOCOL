# Benchmarking and Claims

Use this process to produce defensible latency and success-rate claims.

## Benchmark script

Run:

```bash
npm run benchmark:latency -- --scenario mcp,gate,e2e --iterations 100 --concurrency 10
```

Quick baseline:

```bash
npm run benchmark:latency:quick
```

The script writes a JSON report under `artifacts/benchmarks/`.

## Required environment

- `BENCH_BASE_URL` (default: `https://ghostprotocol.cc`)
- `BENCH_SERVICE_SLUG` (default: `agent-18755`)
- `BENCH_CHAIN_ID` (default: `8453`)
- `BENCH_PRIVATE_KEY` (required for `gate` and `e2e`)
- `BENCH_TIMEOUT_MS` (default: `15000`)
- `BENCH_ITERATIONS` (default: `50`)
- `BENCH_CONCURRENCY` (default: `5`)

Optional:

- `BENCH_SCENARIO`: `mcp`, `gate`, `e2e`, or comma-separated mix.
- `BENCH_OUTPUT`: custom report path.
- `BENCH_GATE_METHOD`, `BENCH_GATE_BODY_JSON`
- `BENCH_E2E_METHOD`, `BENCH_E2E_PATH`, `BENCH_E2E_BODY_JSON`

## Success definitions

- `mcp`: HTTP 200 and no MCP JSON-RPC error.
- `gate`: HTTP 200 from `/api/gate/[service]`.
- `e2e`: ticket 200 + merchant 200 + `captureDisposition=CAPTURED`.

Timeouts and non-200 responses are counted as failures.

## Claim policy

Use two-phase benchmarking:

1. Local/staging baseline (method validation).
2. Hosted production benchmark (claim source).

Recommended minimum for public claim: `N >= 10,000` per scenario.

## Claim template

`Over <N> requests on <network> (<region>, <date window>, commit <sha>):`

- `MCP p95 latency: <x> ms, success rate: <y>%`
- `Gate p95 latency: <x> ms, success rate: <y>%`
- `E2E p95 latency: <x> ms, success rate: <y>%`

Report settlement speed separately, since settlement is asynchronous.

## Performance & Benchmarks
GhostGate processes cryptographic signatures and debits off-chain in milliseconds.

**Latest Production Benchmark (March 9, 2026):**
* **Target:** `https://ghostprotocol.cc`
* **Load:** 250 iterations, 10 concurrency
* **Success Rate:** 100%
* **p50 Latency:** 210.5ms
* **p95 Latency:** 402.4ms

<details>
<summary>View Raw Benchmark Artifact (JSON)</summary>

```json
{
  "scenario": "gate",
  "total": 250,
  "successes": 250,
  "failures": 0,
  "successRate": 100,
  "latencyMs": {
    "avg": 271.89,
    "p50": 210.5,
    "p95": 402.43
  }
}
```
</details>
