import { config as loadEnv } from "dotenv";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/db";

loadEnv({ path: ".env", quiet: true });
loadEnv({ path: ".env.local", override: true, quiet: true });

const parsePositiveIntEnv = (value: string | undefined, fallback: number): number => {
  const trimmed = value?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return fallback;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
};

const replayWindowMinutes = parsePositiveIntEnv(process.env.CREDIT_ALERT_REPLAY_WINDOW_MINUTES, 60);
const replaySpikeThreshold = parsePositiveIntEnv(process.env.CREDIT_ALERT_REPLAY_SPIKE_THRESHOLD, 25);

const run = async (): Promise<void> => {
  const tableCheck = await prisma.$queryRaw<Array<{ relation: string | null }>>(Prisma.sql`
    SELECT to_regclass('public."GateAccessEvent"')::text AS relation
  `);

  if (!tableCheck[0]?.relation) {
    console.warn('Credit alert monitor skipped: table "GateAccessEvent" does not exist yet.');
    return;
  }

  const since = new Date(Date.now() - replayWindowMinutes * 60 * 1000);

  const [replayCount, authorizedCount, insufficientCount] = await Promise.all([
    prisma.gateAccessEvent.count({
      where: {
        outcome: "REPLAY",
        createdAt: { gte: since },
      },
    }),
    prisma.gateAccessEvent.count({
      where: {
        outcome: "AUTHORIZED",
        createdAt: { gte: since },
      },
    }),
    prisma.gateAccessEvent.count({
      where: {
        outcome: "INSUFFICIENT_CREDITS",
        createdAt: { gte: since },
      },
    }),
  ]);

  console.log(
    [
      "Credit alert summary:",
      `window_minutes=${replayWindowMinutes}`,
      `replay_threshold=${replaySpikeThreshold}`,
      `replay_count=${replayCount}`,
      `authorized_count=${authorizedCount}`,
      `insufficient_count=${insufficientCount}`,
    ].join(" "),
  );

  if (replayCount >= replaySpikeThreshold) {
    throw new Error(
      `Replay spike detected: replay_count=${replayCount} within ${replayWindowMinutes}m (threshold=${replaySpikeThreshold}).`,
    );
  }
};

run()
  .catch((error) => {
    console.error("Credit alert monitor failed.");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
