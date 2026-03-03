import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const readText = async (relativePath: string): Promise<string> => {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
};

describe("GhostVault app wiring", () => {
  it("keeps the local ABI aligned with the replacement contract surface", async () => {
    const abiText = await readText("lib/abi/GhostVault.json");
    const abi = JSON.parse(abiText) as Array<{
      type?: string;
      name?: string;
      inputs?: Array<unknown>;
    }>;

    const depositCredit = abi.find((entry) => entry.type === "function" && entry.name === "depositCredit");
    const allocateBatch = abi.find(
      (entry) => entry.type === "function" && entry.name === "allocateMerchantEarningsBatch",
    );

    assert.ok(depositCredit, "Expected local ABI to contain depositCredit.");
    assert.equal(depositCredit?.inputs?.length ?? -1, 0, "depositCredit should take no arguments.");
    assert.ok(allocateBatch, "Expected local ABI to contain allocateMerchantEarningsBatch.");
  });

  it("uses the shared locked credit price and pooled deposit call in the dashboard and sync route", async () => {
    const constantsSource = await readText("lib/constants.ts");
    const dashboardSource = await readText("app/(app)/dashboard/page.tsx");
    const syncRouteSource = await readText("app/api/sync-credits/route.ts");

    assert.match(constantsSource, /export const GHOST_CREDIT_PRICE_WEI: bigint = 10_000_000_000_000n;/);
    assert.match(dashboardSource, /GHOST_CREDIT_PRICE_WEI/);
    assert.doesNotMatch(dashboardSource, /const CREDIT_PRICE_WEI = parseEther\("0\.00001"\);/);
    assert.doesNotMatch(dashboardSource, /args:\s*\[targetAgentAddress\]/);
    assert.match(syncRouteSource, /GHOST_CREDIT_PRICE_WEI/);
    assert.doesNotMatch(syncRouteSource, /DEFAULT_CREDIT_PRICE_WEI/);
  });
});
