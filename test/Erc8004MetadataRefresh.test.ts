import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyMetadataFetchFailure,
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

test("classifyMetadataFetchFailure treats malformed HTML or JSON as expected invalid_json", () => {
  assert.deepEqual(
    classifyMetadataFetchFailure({
      message: 'Unexpected token \'<\', "<!DOCTYPE "... is not valid JSON',
    }),
    {
      reason: "invalid_json",
      expected: true,
      permanent: true,
      timedOut: false,
    },
  );
});

test("classifyMetadataFetchFailure treats empty tokenURI as expected and permanent", () => {
  assert.deepEqual(
    classifyMetadataFetchFailure({
      message: "tokenURI returned empty value",
    }),
    {
      reason: "empty_token_uri",
      expected: true,
      permanent: true,
      timedOut: false,
    },
  );
});

test("classifyMetadataFetchFailure treats timeouts as expected but retryable", () => {
  assert.deepEqual(
    classifyMetadataFetchFailure({
      message: "resolve token timed out after 8000ms",
      code: "ABORT_ERR",
    }),
    {
      reason: "timeout",
      expected: true,
      permanent: false,
      timedOut: true,
    },
  );
});
