import assert from "node:assert/strict";
import test from "node:test";
import { buildWireJobListWhere } from "../lib/ghostwire-store";

test("buildWireJobListWhere scopes owner-level participant queries to a selected provider agent", () => {
  assert.deepEqual(
    buildWireJobListWhere({
      participantAddress: "0xabc",
      providerAgentId: "18711",
      providerServiceSlug: "agent-18711",
      state: "OPEN",
    }),
    {
      AND: [
        { publicState: "OPEN" },
        {
          OR: [
            { clientAddress: "0xabc" },
            { providerAddress: "0xabc" },
            { evaluatorAddress: "0xabc" },
          ],
        },
        {
          OR: [{ providerAgentId: "18711" }, { providerServiceSlug: "agent-18711" }],
        },
      ],
    },
  );
});

test("buildWireJobListWhere can filter by provider attribution without participant scoping", () => {
  assert.deepEqual(buildWireJobListWhere({ providerAgentId: "18755", providerServiceSlug: "agent-18755" }), {
    OR: [{ providerAgentId: "18755" }, { providerServiceSlug: "agent-18755" }],
  });
});
