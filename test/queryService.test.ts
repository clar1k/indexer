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

test("listInstructionRows applies default limit and descending order", async () => {
  const { listInstructionRows } = await loadApiModules();
  const { calls } = await mockDb({
    execute: async () => ({
      rows: [{ amount: 12n, memo: "hello", slot: 99n }],
    }),
  });

  const result = await listInstructionRows("deposit", {});

  assert.equal(result.instruction, "deposit");
  assert.equal(result.programId, sampleProgramSetup.programId);
  assert.deepEqual(result.rows, [{ amount: "12", memo: "hello", slot: "99" }]);
  assert.match(calls[0].sql, /ORDER BY "slot" DESC, "indexer_row_id" DESC/);
  assert.equal(calls[0].params.at(-1), 50);
});

test("listInstructionRows rejects invalid limit, order, and malformed slot filters", async () => {
  const { listInstructionRows } = await loadApiModules();
  await mockDb();

  await assert.rejects(
    () => listInstructionRows("deposit", { limit: "0" }),
    /limit must be an integer between 1 and 200/,
  );
  await assert.rejects(
    () => listInstructionRows("deposit", { order: "sideways" }),
    /order must be 'asc' or 'desc'/,
  );
  await assert.rejects(
    () => listInstructionRows("deposit", { from_slot: "12.5" }),
    /from_slot must be a valid integer/,
  );
});

test("numeric instruction filters support eq, gte, and lte operators", async () => {
  const { listInstructionRows } = await loadApiModules();
  const { calls } = await mockDb();

  await listInstructionRows("deposit", {
    "arg.amount": "10",
    "arg.amount.gte": "5",
    "arg.amount.lte": "20",
  });

  assert.match(calls[0].sql, /"amount" = \$1/);
  assert.match(calls[0].sql, /"amount" >= \$2/);
  assert.match(calls[0].sql, /"amount" <= \$3/);
  assert.deepEqual(calls[0].params.slice(0, 3), ["10", "5", "20"]);
});

test("scalar filters reject gte and lte operators", async () => {
  const { listInstructionRows } = await loadApiModules();
  await mockDb();

  await assert.rejects(
    () => listInstructionRows("deposit", { "arg.memo.gte": "abc" }),
    /Only equality filters are supported for argument 'memo'/,
  );
});

test("unknown instructions return a 404 HttpError", async () => {
  const { listInstructionRows, app } = await loadApiModules();
  await mockDb();

  await assert.rejects(() => listInstructionRows("missing", {}), /Unknown instruction 'missing'/);

  const response = await app.request("http://localhost/api/v1/instructions/missing");
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Unknown instruction 'missing'" });
});

test("unknown instruction arguments return a 400 HttpError", async () => {
  const { listInstructionRows } = await loadApiModules();
  await mockDb();

  await assert.rejects(
    () => listInstructionRows("deposit", { "arg.unknown": "1" }),
    /Unknown instruction argument 'unknown'/,
  );
});

test("aggregate queries require a valid metric", async () => {
  const { aggregateInstructionRows } = await loadApiModules();
  await mockDb();

  await assert.rejects(
    () => aggregateInstructionRows("deposit", {}),
    /metric must be one of count, sum, avg, min, max/,
  );
});

test("sum, avg, min, and max require a numeric field", async () => {
  const { aggregateInstructionRows } = await loadApiModules();
  await mockDb();

  for (const metric of ["sum", "avg", "min", "max"] as const) {
    await assert.rejects(
      () => aggregateInstructionRows("deposit", { field: "memo", metric }),
      new RegExp(`Metric '${metric}' requires a numeric argument`),
    );
  }
});

test("count aggregates work without a field", async () => {
  const { aggregateInstructionRows } = await loadApiModules();
  const { calls } = await mockDb({
    execute: async () => ({ rows: [{ value: "3" }] }),
  });

  const result = await aggregateInstructionRows("deposit", { metric: "count" });

  assert.deepEqual(result, {
    instruction: "deposit",
    metric: "count",
    programId: sampleProgramSetup.programId,
    value: "3",
  });
  assert.match(calls[0].sql, /SELECT COUNT\(\*\)::text AS value/);
});

test("grouping by signer returns rows in deterministic order", async () => {
  const { aggregateInstructionRows } = await loadApiModules();
  const { calls } = await mockDb({
    execute: async () => ({
      rows: [
        { signer: "alice", value: 5n },
        { signer: "bob", value: 5n },
        { signer: "carol", value: 2n },
      ],
    }),
  });

  const result = await aggregateInstructionRows("deposit", {
    field: "amount",
    group_by: "signer",
    metric: "sum",
  });

  assert.deepEqual(result, {
    group_by: "signer",
    instruction: "deposit",
    metric: "sum",
    programId: sampleProgramSetup.programId,
    rows: [
      { signer: "alice", value: "5" },
      { signer: "bob", value: "5" },
      { signer: "carol", value: "2" },
    ],
  });
  assert.match(calls[0].sql, /GROUP BY "signer"/);
  assert.match(calls[0].sql, /ORDER BY value DESC, signer ASC/);
});

test("bigint database values are normalized to strings in API responses", async () => {
  const { listInstructionRows } = await loadApiModules();
  await mockDb({
    execute: async () => ({
      rows: [{ amount: 42n, indexer_row_id: 7n, slot: 1000n }],
    }),
  });

  const result = await listInstructionRows("deposit", {});

  assert.deepEqual(result.rows, [{ amount: "42", indexer_row_id: "7", slot: "1000" }]);
});

test("program stats include per-instruction counts, global unique signers, totals, and latest slot", async () => {
  const { getProgramStats } = await loadApiModules();
  let callIndex = 0;

  await mockDb({
    execute: async () => {
      callIndex += 1;

      if (callIndex === 1) {
        return {
          rows: [{ count: "3", latest_slot: "120", unique_signers: "2" }],
        };
      }

      if (callIndex === 2) {
        return {
          rows: [{ count: "7", latest_slot: "140", unique_signers: "4" }],
        };
      }

      return {
        rows: [{ count: "5" }],
      };
    },
  });

  const result = await getProgramStats();

  assert.deepEqual(result, {
    instructionCounts: [
      { count: "3", latestSlot: "120", name: "deposit", uniqueSigners: "2" },
      { count: "7", latestSlot: "140", name: "withdraw", uniqueSigners: "4" },
    ],
    latestIndexedSlot: "140",
    programId: sampleProgramSetup.programId,
    totalInstructions: "10",
    uniqueSigners: "5",
  });
});
