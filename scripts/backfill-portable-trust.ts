import { prisma } from "../lib/db";
import { backfillPortableTrustForActiveSnapshot } from "../lib/trust-artifact-store";
import { isPortableTrustEnabled } from "../lib/trust-signing";

async function main(): Promise<void> {
  if (!isPortableTrustEnabled()) {
    console.log("portable trust backfill skipped: PORTABLE_TRUST_ENABLED is false.");
    return;
  }

  const result = await backfillPortableTrustForActiveSnapshot();
  if (!result) {
    console.log("portable trust backfill skipped: no active READY leaderboard snapshot found.");
    return;
  }

  console.log(
    `portable trust backfill complete: snapshot=${result.snapshotId}, processed=${result.processed}, upserted=${result.upserted}, deactivated=${result.deactivated}.`,
  );
}

main()
  .catch((error) => {
    console.error("portable trust backfill failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
