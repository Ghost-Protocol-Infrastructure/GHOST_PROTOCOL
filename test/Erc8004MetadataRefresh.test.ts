import assert from "node:assert/strict";
import test from "node:test";
import {
  computeMirroredMetadataPatch,
  computeRotatingBatchWindow,
  parseNumericRefreshSelector,
} from "../lib/erc8004-metadata-refresh";

test("parseNumericRefreshSelector accepts bounded numeric selectors and dedupes them", () => {
  assert.deepEqual(
    parseNumericRefreshSelector(["18755, 18755", "38638"], "agentId"),
    ["18755", "38638"],
  );
});

test("parseNumericRefreshSelector rejects non-numeric ids", () => {
  assert.throws(
    () => parseNumericRefreshSelector(["18755,booski"], "agentId"),
    /Invalid agentId selector "booski"/,
  );
});

test("parseNumericRefreshSelector rejects oversized selector batches", () => {
  const fiftyOne = Array.from({ length: 51 }, (_, index) => String(index + 1)).join(",");
  assert.throws(
    () => parseNumericRefreshSelector([fiftyOne], "tokenId"),
    /supports at most 50 tokenId selector/,
  );
});

test("computeMirroredMetadataPatch updates only changed mirrored fields", () => {
  const patch = computeMirroredMetadataPatch(
    {
      name: "Booski",
      image: "https://blob.8004scan.app/old.jpg",
      description: "Old description",
      telegram: null,
      twitter: "@booski_old",
      website: null,
    },
    {
      name: "Booski",
      image: "https://blob.8004scan.app/new.jpg",
      twitter: "@booski_new",
    },
  );

  assert.deepEqual(patch, {
    image: "https://blob.8004scan.app/new.jpg",
    twitter: "@booski_new",
  });
});

test("computeMirroredMetadataPatch ignores unspecified fields", () => {
  const patch = computeMirroredMetadataPatch(
    {
      name: "Booski",
      image: "https://blob.8004scan.app/current.jpg",
      description: "Current description",
      telegram: "@booski",
      twitter: "@booski",
      website: "https://booski.ai",
    },
    {
      image: "https://blob.8004scan.app/current.jpg",
    },
  );

  assert.deepEqual(patch, {});
});

test("computeRotatingBatchWindow advances a bounded rotating cursor", () => {
  assert.deepEqual(computeRotatingBatchWindow(1000, 250, 0), {
    offset: 0,
    limit: 250,
    nextOffset: 250,
  });
  assert.deepEqual(computeRotatingBatchWindow(1000, 250, 900), {
    offset: 900,
    limit: 100,
    nextOffset: 0,
  });
  assert.deepEqual(computeRotatingBatchWindow(1000, 250, 1200), {
    offset: 0,
    limit: 250,
    nextOffset: 250,
  });
});
