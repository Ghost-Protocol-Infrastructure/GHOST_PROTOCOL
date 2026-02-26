import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_BASE_URL = "http://localhost:3000";

type Step = {
  name: string;
  script: string;
};

const steps: Step[] = [
  {
    name: "alpha-happy-path",
    script: "scripts/test-fulfillment-alpha-booski.ts",
  },
  {
    name: "alpha-negatives",
    script: "scripts/test-fulfillment-alpha-booski-negatives.ts",
  },
  {
    name: "alpha-ticket-ttl-expiry",
    script: "scripts/test-fulfillment-alpha-booski-ticket-ttl-expiry.ts",
  },
];

const getEnv = (name: string): string | undefined => {
  const value = process.env[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

const requireHexPrivateKey = (value: string | undefined, name: string): string => {
  if (!value || !/^0x[a-fA-F0-9]{64}$/.test(value)) {
    throw new Error(`${name} must be set to a 0x-prefixed 32-byte hex key.`);
  }
  return value;
};

const runStep = async (step: Step, env: NodeJS.ProcessEnv): Promise<{ name: string; durationMs: number }> => {
  const startedAt = Date.now();
  const tsxCli = resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  if (!existsSync(tsxCli)) {
    throw new Error(`tsx CLI not found at ${tsxCli}. Run npm install first.`);
  }

  const scriptPath = resolve(process.cwd(), step.script);
  if (!existsSync(scriptPath)) {
    throw new Error(`Step script not found: ${step.script}`);
  }

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [tsxCli, scriptPath], {
      stdio: "inherit",
      env,
      cwd: process.cwd(),
    });

    child.on("error", rejectPromise);
    child.on("exit", (code, signal) => {
      if (signal) {
        rejectPromise(new Error(`${step.name} terminated by signal ${signal}`));
        return;
      }
      if (code !== 0) {
        rejectPromise(new Error(`${step.name} failed with exit code ${code ?? "unknown"}`));
        return;
      }
      resolvePromise();
    });
  });

  return {
    name: step.name,
    durationMs: Date.now() - startedAt,
  };
};

async function main() {
  const baseUrl = getEnv("FULFILLMENT_BASE_URL") ?? DEFAULT_BASE_URL;
  const consumerPrivateKey = requireHexPrivateKey(
    getEnv("FULFILLMENT_CONSUMER_PRIVATE_KEY"),
    "FULFILLMENT_CONSUMER_PRIVATE_KEY",
  );

  const sharedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    FULFILLMENT_BASE_URL: baseUrl,
    FULFILLMENT_CONSUMER_PRIVATE_KEY: consumerPrivateKey,
  };

  const summary: Array<{ name: string; durationMs: number }> = [];
  const suiteStartedAt = Date.now();

  console.log(
    JSON.stringify(
      {
        ok: true,
        phase: "phase9-alpha-suite",
        starting: true,
        baseUrl,
        steps: steps.map((step) => step.name),
      },
      null,
      2,
    ),
  );

  for (const step of steps) {
    console.log(`\n--- Running ${step.name} (${step.script}) ---`);
    const result = await runStep(step, sharedEnv);
    summary.push(result);
    console.log(`--- Completed ${step.name} in ${result.durationMs}ms ---`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        phase: "phase9-alpha-suite",
        baseUrl,
        totalDurationMs: Date.now() - suiteStartedAt,
        steps: summary,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

