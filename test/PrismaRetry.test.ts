import assert from "node:assert/strict";
import { test } from "node:test";
import { isRecoverablePrismaError, withPrismaRetry } from "../scripts/prisma-retry";

const buildRecoverableError = (): Error & { code?: string; meta?: Record<string, string> } => {
  const error = new Error("Raw query failed. Code: `57P01`. Message: `FATAL: terminating connection due to administrator command`") as Error & {
    code?: string;
    meta?: Record<string, string>;
  };
  error.code = "P2010";
  error.meta = {
    code: "57P01",
    message: "FATAL: terminating connection due to administrator command",
  };
  return error;
};

test("isRecoverablePrismaError treats Postgres administrator termination as retryable", () => {
  assert.equal(isRecoverablePrismaError(buildRecoverableError()), true);
});

test("isRecoverablePrismaError treats validation failures as non-retryable", () => {
  assert.equal(isRecoverablePrismaError(new Error("Unique constraint failed on the fields: (`id`)")), false);
});

test("withPrismaRetry retries recoverable Prisma failures and resets the connection", async () => {
  let operationCalls = 0;
  let disconnectCalls = 0;
  let connectCalls = 0;

  const result = await withPrismaRetry(
    {
      $disconnect: async () => {
        disconnectCalls += 1;
      },
      $connect: async () => {
        connectCalls += 1;
      },
    },
    "unit-test",
    async () => {
      operationCalls += 1;
      if (operationCalls === 1) {
        throw buildRecoverableError();
      }
      return "ok";
    },
    {
      attempts: 2,
      delayMs: 100,
      connectionTimeoutMs: 1_000,
      labelPrefix: "test",
    },
  );

  assert.equal(result, "ok");
  assert.equal(operationCalls, 2);
  assert.equal(disconnectCalls, 1);
  assert.equal(connectCalls, 1);
});

test("withPrismaRetry does not retry non-recoverable failures", async () => {
  let operationCalls = 0;

  await assert.rejects(
    () =>
      withPrismaRetry(
        {
          $disconnect: async () => {},
          $connect: async () => {},
        },
        "unit-test",
        async () => {
          operationCalls += 1;
          throw new Error("Unique constraint failed on the fields: (`id`)");
        },
        {
          attempts: 3,
          delayMs: 100,
          connectionTimeoutMs: 1_000,
          labelPrefix: "test",
        },
      ),
    /Unique constraint failed/,
  );

  assert.equal(operationCalls, 1);
});
