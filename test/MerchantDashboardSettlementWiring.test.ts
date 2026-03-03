import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const readText = async (relativePath: string): Promise<string> => {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
};

describe("merchant settlement dashboard wiring", () => {
  it("exposes settlement summary through the gateway config route and merchant dashboard", async () => {
    const routeSource = await readText("app/api/agent-gateway/config/route.ts");
    const dashboardSource = await readText("app/(app)/dashboard/page.tsx");

    assert.match(routeSource, /settlementSummary/);
    assert.match(dashboardSource, /Pending Earnings/i);
    assert.match(dashboardSource, /In-Flight Earnings/i);
  });
});
