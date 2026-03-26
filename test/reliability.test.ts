import test from "node:test";
import assert from "node:assert/strict";

import { retryConfig, retryWithExponentialBackoff, solanaDeps } from "../src/solana/index.js";
import { backfillDeps, runBackfill } from "../src/indexer/backfill.js";
import { realtimeDeps, runRealtime } from "../src/indexer/realtime.js";

const programId = { toString: () => "Program1111111111111111111111111111111111" } as never;
const runtime = {
  coder: { instruction: { decode: () => null } },
  discriminatorMap: new Map(),
  idl: { address: "", metadata: { name: "", version: "", spec: "" }, instructions: [] },
  programId,
  typesMap: new Map(),
} as never;

test("retryWithExponentialBackoff retries until success and uses capped exponential delays", async (t) => {
  const delays: number[] = [];
  let attempt = 0;

  t.mock.method(solanaDeps, "sleep", async (ms: number) => {
    delays.push(ms);
  });

  const result = await retryWithExponentialBackoff("rpc-op", async () => {
    attempt += 1;
    if (attempt < 5) {
      throw new Error(`fail-${attempt}`);
    }
    return "ok";
  });

  assert.equal(result, "ok");
  assert.deepEqual(delays, [
    retryConfig.RETRY_BASE_DELAY_MS,
    retryConfig.RETRY_BASE_DELAY_MS * 2,
    retryConfig.RETRY_BASE_DELAY_MS * 4,
    retryConfig.RETRY_BASE_DELAY_MS * 8,
  ]);
});

test("retryWithExponentialBackoff does not retry abort errors and rethrows after max attempts", async (t) => {
  const delays: number[] = [];
  t.mock.method(solanaDeps, "sleep", async (ms: number) => {
    delays.push(ms);
  });

  const abortError = new Error("This operation was aborted");
  abortError.name = "AbortError";
  await assert.rejects(retryWithExponentialBackoff("abort", async () => Promise.reject(abortError)), /aborted/);
  assert.deepEqual(delays, []);

  let attempts = 0;
  await assert.rejects(
    retryWithExponentialBackoff("always-fails", async () => {
      attempts += 1;
      throw new Error("still failing");
    }),
    /still failing/,
  );
  assert.equal(attempts, retryConfig.RETRY_MAX_ATTEMPTS);
  assert.deepEqual(delays, [
    retryConfig.RETRY_BASE_DELAY_MS,
    retryConfig.RETRY_BASE_DELAY_MS * 2,
    retryConfig.RETRY_BASE_DELAY_MS * 4,
    retryConfig.RETRY_BASE_DELAY_MS * 8,
  ]);
});

test("runBackfill exits without extra work after shutdown is requested", async (t) => {
  const processed: string[] = [];
  const abortController = new AbortController();

  t.mock.method(backfillDeps, "getSignaturesToProcess", async () => [
    { signature: "sig-1", slot: 1n },
    { signature: "sig-2", slot: 2n },
  ]);
  t.mock.method(backfillDeps, "processTransaction", async (signature: string) => {
    processed.push(signature.toString());
    abortController.abort();
  });

  await runBackfill({
    abortSignal: abortController.signal,
    fromExclusive: 0n,
    programId,
    runtime,
    toInclusive: 10n,
  });

  assert.deepEqual(processed, ["sig-1"]);
});

test("runRealtime stops instead of restarting once shutdown has been requested", async (t) => {
  const backfills: number[] = [];
  const abortController = new AbortController();

  t.mock.method(realtimeDeps, "loadCheckpointAndTip", async () => ({
    latestProcessedSlot: 0n,
    currentSlot: 1n,
  }));
  t.mock.method(realtimeDeps, "runBackfill", async () => {
    backfills.push(1);
  });
  t.mock.method(realtimeDeps, "createLogsSubscription", async () => {
    abortController.abort();
    throw new Error("socket dropped");
  });

  await runRealtime({
    abortSignal: abortController.signal,
    programId,
    runtime,
  });

  assert.deepEqual(backfills, [1]);
});
