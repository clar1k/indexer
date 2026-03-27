import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { sampleProgramSetup } from "../helpers/sample-idl.js";

const dialect = new PgDialect();
const execute = vi.fn();
const findFirst = vi.fn();
const logger = {
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};

vi.mock("@/db/index.js", () => ({
  db: {
    execute: (statement: SQL) => execute(statement),
    query: {
      programSetups: {
        findFirst,
      },
    },
  },
}));

vi.mock("@/runtime.js", () => ({
  getRuntimeContext: () => sampleProgramSetup,
}));

vi.mock("@/logger.js", () => ({ logger }));

describe("query service", () => {
  beforeEach(() => {
    execute.mockReset();
    findFirst.mockReset();
    logger.error.mockClear();
    logger.info.mockClear();
  });

  it("lists instruction rows with combined filters and normalized output", async () => {
    const { listInstructionRows } = await import("@/api/queryService.js");
    execute.mockImplementation(async (statement: SQL) => {
      const rendered = dialect.sqlToQuery(statement as never);
      expect(rendered.sql).toMatch(/"signer" = \$1/);
      expect(rendered.sql).toMatch(/"tx_signature" = \$2/);
      expect(rendered.sql).toMatch(/"slot" >= \$3/);
      expect(rendered.sql).toMatch(/"slot" <= \$4/);
      expect(rendered.sql).toMatch(/"amount" = \$5/);
      expect(rendered.sql).toMatch(/"amount" >= \$6/);
      expect(rendered.sql).toMatch(/"amount" <= \$7/);
      expect(rendered.sql).toMatch(/"flag" = \$8/);
      expect(rendered.sql).toMatch(/ORDER BY "slot" ASC, "indexer_row_id" ASC/);
      expect(rendered.params).toEqual([
        "signer-1",
        "sig-1",
        "10",
        "20",
        "11",
        "5",
        "19",
        true,
        5,
      ]);

      return {
        rows: [{ amount: 11n, flag: true, memo: "hi", slot: 15n }],
      };
    });

    const result = await listInstructionRows("deposit", {
      "arg.amount": "11",
      "arg.amount.gte": "5",
      "arg.amount.lte": "19",
      "arg.flag": "true",
      from_slot: "10",
      limit: "5",
      order: "asc",
      signer: "signer-1",
      to_slot: "20",
      tx_signature: "sig-1",
    });

    expect(result).toEqual({
      instruction: "deposit",
      programId: sampleProgramSetup.programId,
      rows: [{ amount: "11", flag: true, memo: "hi", slot: "15" }],
    });
  });

  it("rejects malformed list and filter queries", async () => {
    const { listInstructionRows } = await import("@/api/queryService.js");

    await expect(
      listInstructionRows("deposit", { limit: "0" })
    ).rejects.toThrow("limit must be an integer between 1 and 200");
    await expect(
      listInstructionRows("deposit", { order: "sideways" })
    ).rejects.toThrow("order must be 'asc' or 'desc'");
    await expect(
      listInstructionRows("deposit", { from_slot: "abc" })
    ).rejects.toThrow("from_slot must be a valid integer");
    await expect(
      listInstructionRows("deposit", { "arg.memo.gte": "x" })
    ).rejects.toThrow(
      "Only equality filters are supported for argument 'memo'"
    );
    await expect(
      listInstructionRows("deposit", { "arg.metadata": "{}" })
    ).rejects.toThrow("Filtering is not supported for argument 'metadata'");
    await expect(
      listInstructionRows("deposit", { "arg.flag": "wat" })
    ).rejects.toThrow("Argument 'flag' expects a boolean value");
    await expect(
      listInstructionRows("deposit", { "arg.amount": "abc" })
    ).rejects.toThrow("Argument 'amount' expects a numeric value");
    await expect(listInstructionRows("missing", {})).rejects.toThrow(
      "Unknown instruction 'missing'"
    );
    await expect(
      listInstructionRows("deposit", { "arg.missing": "1" })
    ).rejects.toThrow("Unknown instruction argument 'missing'");
  });

  it("aggregates instruction rows and validates aggregate queries", async () => {
    const { aggregateInstructionRows, getProgramStats } = await import(
      "@/api/queryService.js"
    );
    let call = 0;

    execute.mockImplementation(async (statement: SQL) => {
      call += 1;
      const rendered = dialect.sqlToQuery(statement as never);

      if (call === 1) {
        expect(rendered.sql).toMatch(/GROUP BY "signer"/);
        return {
          rows: [
            { signer: "alice", value: 5n },
            { signer: "bob", value: 2n },
          ],
        };
      }

      if (call === 2) {
        expect(rendered.sql).toMatch(/SELECT COUNT\(\*\)::text AS value/);
        return { rows: [{ value: "3" }] };
      }

      if (call === 3) {
        return {
          rows: [{ count: "2", latest_slot: "90", unique_signers: "2" }],
        };
      }

      if (call === 4) {
        return {
          rows: [{ count: "1", latest_slot: "100", unique_signers: "1" }],
        };
      }

      return {
        rows: [{ count: "2" }],
      };
    });

    await expect(aggregateInstructionRows("deposit", {})).rejects.toThrow(
      "metric must be one of count, sum, avg, min, max"
    );
    await expect(
      aggregateInstructionRows("deposit", { field: "memo", metric: "sum" })
    ).rejects.toThrow("Metric 'sum' requires a numeric argument");
    await expect(
      aggregateInstructionRows("deposit", {
        field: "amount",
        group_by: "slot",
        metric: "sum",
      })
    ).rejects.toThrow("group_by must be 'signer'");

    expect(
      await aggregateInstructionRows("deposit", {
        field: "amount",
        group_by: "signer",
        metric: "sum",
      })
    ).toEqual({
      group_by: "signer",
      instruction: "deposit",
      metric: "sum",
      programId: sampleProgramSetup.programId,
      rows: [
        { signer: "alice", value: "5" },
        { signer: "bob", value: "2" },
      ],
    });

    expect(
      await aggregateInstructionRows("deposit", {
        metric: "count",
      })
    ).toEqual({
      instruction: "deposit",
      metric: "count",
      programId: sampleProgramSetup.programId,
      value: "3",
    });

    expect(await getProgramStats()).toEqual({
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
});
