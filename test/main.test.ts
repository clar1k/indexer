import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  loadApiModules,
  sampleProgramSetup,
  withMockedDatabase,
} from "./support/apiHarness.js";

const restorers: Array<() => void> = [];

afterEach(() => {
  while (restorers.length > 0) {
    restorers.pop()?.();
  }
});

const mockDb = async (options?: Parameters<typeof withMockedDatabase>[0]) => {
  const mocked = await withMockedDatabase(options ?? {});
  restorers.push(mocked.restore);
  return mocked;
};

test("GET / returns an ok payload", async () => {
  const { app } = await loadApiModules();

  const response = await app.request("http://localhost/");

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("GET /api/v1/instructions/:name returns a list payload for valid queries", async () => {
  const { app } = await loadApiModules();
  await mockDb({
    execute: async () => ({
      rows: [{ amount: 11n, memo: "hello", slot: 50n }],
    }),
  });

  const response = await app.request(
    "http://localhost/api/v1/instructions/deposit?limit=1&order=asc&arg.amount=11",
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    instruction: "deposit",
    programId: sampleProgramSetup.programId,
    rows: [{ amount: "11", memo: "hello", slot: "50" }],
  });
});

test("GET /api/v1/instructions/:name/aggregate returns an aggregate payload for valid queries", async () => {
  const { app } = await loadApiModules();
  await mockDb({
    execute: async () => ({
      rows: [{ value: "17" }],
    }),
  });

  const response = await app.request(
    "http://localhost/api/v1/instructions/deposit/aggregate?metric=sum&field=amount",
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    instruction: "deposit",
    metric: "sum",
    programId: sampleProgramSetup.programId,
    value: "17",
  });
});

test("GET /api/v1/stats returns the stats payload", async () => {
  const { app } = await loadApiModules();
  let callIndex = 0;

  await mockDb({
    execute: async () => {
      callIndex += 1;

      if (callIndex === 1) {
        return { rows: [{ count: "2", latest_slot: "90", unique_signers: "2" }] };
      }

      if (callIndex === 2) {
        return { rows: [{ count: "1", latest_slot: "100", unique_signers: "1" }] };
      }

      return { rows: [{ count: "2" }] };
    },
  });

  const response = await app.request("http://localhost/api/v1/stats");

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    instructionCounts: [
      { count: "2", latestSlot: "90", name: "deposit", uniqueSigners: "2" },
      { count: "1", latestSlot: "100", name: "withdraw", uniqueSigners: "1" },
    ],
    latestIndexedSlot: "100",
    programId: sampleProgramSetup.programId,
    totalInstructions: "3",
    uniqueSigners: "2",
  });
});

test("HTTP routes convert HttpError failures into the correct status and JSON body", async () => {
  const { app } = await loadApiModules();
  await mockDb();

  const response = await app.request(
    "http://localhost/api/v1/instructions/deposit/aggregate?metric=invalid",
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "metric must be one of count, sum, avg, min, max",
  });
});

test("unexpected route errors return a stable 500 response", async () => {
  const { app } = await loadApiModules();
  await mockDb({
    findProgramSetup: async () => {
      throw new Error("boom");
    },
  });

  const response = await app.request("http://localhost/api/v1/stats");

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Internal server error" });
});
