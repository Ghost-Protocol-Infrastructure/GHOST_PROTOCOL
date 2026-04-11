import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { GET } from "../app/api/agents/route";
import { prisma } from "../lib/db";

const ORIGINAL_PORTABLE_TRUST_ENABLED = process.env.PORTABLE_TRUST_ENABLED;

const originalSnapshotFindFirst = prisma.leaderboardSnapshot.findFirst;
const originalSnapshotRowFindMany = prisma.leaderboardSnapshotRow.findMany;
const originalSnapshotRowCount = prisma.leaderboardSnapshotRow.count;
const originalSystemStateFindUnique = prisma.systemState.findUnique;
const originalGatewayCount = prisma.agentGatewayConfig.count;
const originalTransaction = prisma.$transaction;

const request = (query = "") => new NextRequest(`https://ghost.local/api/agents${query}`);

const restoreEnv = () => {
  process.env.PORTABLE_TRUST_ENABLED = ORIGINAL_PORTABLE_TRUST_ENABLED;
};

const stubSnapshotFindFirst = (impl: any) => {
  (prisma.leaderboardSnapshot as { findFirst: any }).findFirst = impl;
};

const stubSnapshotRowFindMany = (impl: any) => {
  (prisma.leaderboardSnapshotRow as { findMany: any }).findMany = impl;
};

const stubSnapshotRowCount = (impl: any) => {
  (prisma.leaderboardSnapshotRow as { count: any }).count = impl;
};

const stubSystemStateFindUnique = (impl: any) => {
  (prisma.systemState as { findUnique: any }).findUnique = impl;
};

const stubGatewayCount = (impl: any) => {
  (prisma.agentGatewayConfig as { count: any }).count = impl;
};

const stubTransaction = (impl: any) => {
  (prisma as { $transaction: any }).$transaction = impl;
};

const installBaselineStubs = () => {
  stubSnapshotFindFirst(async () => ({
    id: "snap_active",
    totalAgents: 42,
  }));
  stubSnapshotRowFindMany(async () => []);
  stubSnapshotRowCount(async () => 0);
  stubSystemStateFindUnique(async () => ({
    lastSyncedBlock: null,
  }));
  stubGatewayCount(async () => 0);
  stubTransaction(async (operations: Promise<unknown>[]) => Promise.all(operations));
};

afterEach(() => {
  (prisma.leaderboardSnapshot as { findFirst: any }).findFirst = originalSnapshotFindFirst;
  (prisma.leaderboardSnapshotRow as { findMany: any }).findMany = originalSnapshotRowFindMany;
  (prisma.leaderboardSnapshotRow as { count: any }).count = originalSnapshotRowCount;
  (prisma.systemState as { findUnique: any }).findUnique = originalSystemStateFindUnique;
  (prisma.agentGatewayConfig as { count: any }).count = originalGatewayCount;
  (prisma as { $transaction: any }).$transaction = originalTransaction;
  restoreEnv();
});

describe("agents route V1 filters", () => {
  it("filters by rail before pagination", async () => {
    installBaselineStubs();

    let capturedFindManyArgs: any = null;
    stubSnapshotRowFindMany(async (args: any) => {
      capturedFindManyArgs = args;
      return [];
    });

    const response = await GET(request("?rail=HYBRID,WIRE"));

    assert.equal(response.status, 200);
    assert.deepEqual(capturedFindManyArgs.where, {
      AND: [
        { snapshotId: "snap_active" },
        {
          railMode: {
            in: ["HYBRID", "WIRE"],
          },
        },
      ],
    });
  });

  it("filters by readiness using current gateway readiness", async () => {
    installBaselineStubs();

    let capturedFindManyArgs: any = null;
    stubSnapshotRowFindMany(async (args: any) => {
      capturedFindManyArgs = args;
      return [];
    });

    const response = await GET(request("?readiness=LIVE,UNCONFIGURED"));

    assert.equal(response.status, 200);
    assert.deepEqual(capturedFindManyArgs.where, {
      AND: [
        { snapshotId: "snap_active" },
        {
          OR: [
            {
              agent: {
                is: {
                  gatewayConfig: {
                    is: {
                      readinessStatus: {
                        in: ["LIVE"],
                      },
                    },
                  },
                },
              },
            },
            {
              agent: {
                is: {
                  gatewayConfig: {
                    is: null,
                  },
                },
              },
            },
          ],
        },
      ],
    });
  });

  it("filters by active portable trust availability", async () => {
    installBaselineStubs();
    process.env.PORTABLE_TRUST_ENABLED = "true";

    let capturedFindManyArgs: any = null;
    stubSnapshotRowFindMany(async (args: any) => {
      capturedFindManyArgs = args;
      return [];
    });

    const response = await GET(request("?trust=available"));

    assert.equal(response.status, 200);
    assert.deepEqual(capturedFindManyArgs.where, {
      AND: [
        { snapshotId: "snap_active" },
        {
          agent: {
            is: {
              trustArtifacts: {
                some: {
                  schemaVersion: "ghost-trust/v1",
                  isActive: true,
                  snapshot: {
                    isActive: true,
                    status: "READY",
                  },
                },
              },
            },
          },
        },
      ],
    });
  });

  it("preserves filteredTotal and totalPages for combined filters", async () => {
    installBaselineStubs();
    process.env.PORTABLE_TRUST_ENABLED = "true";

    let capturedFindManyArgs: any = null;
    let capturedCountArgs: any = null;
    stubSnapshotRowFindMany(async (args: any) => {
      capturedFindManyArgs = args;
      return [];
    });
    stubSnapshotRowCount(async (args: any) => {
      capturedCountArgs = args;
      return 3;
    });

    const response = await GET(request("?page=1&limit=2&rail=HYBRID&readiness=LIVE&trust=available"));
    const body = (await response.json()) as {
      filteredTotal?: number;
      totalPages?: number;
      page?: number;
      limit?: number;
    };

    assert.equal(response.status, 200);
    assert.equal(body.filteredTotal, 3);
    assert.equal(body.totalPages, 2);
    assert.equal(body.page, 1);
    assert.equal(body.limit, 2);
    assert.deepEqual(capturedFindManyArgs.where, capturedCountArgs.where);
  });

  it("returns 400 for invalid enum filters", async () => {
    installBaselineStubs();

    const railResponse = await GET(request("?rail=NOT_A_RAIL"));
    const readinessResponse = await GET(request("?readiness=BROKEN"));
    const trustResponse = await GET(request("?trust=available,missing"));

    assert.equal(railResponse.status, 400);
    assert.equal(readinessResponse.status, 400);
    assert.equal(trustResponse.status, 400);
  });
});
