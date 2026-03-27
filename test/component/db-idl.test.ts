import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const execute = vi.fn();

vi.mock("@/db/index.js", () => ({
  db: {
    execute,
  },
}));

vi.mock("@/logger.js", () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

describe("dynamic schema helpers", () => {
  const dialect = new PgDialect();

  it("generates account and instruction schema from the IDL", async () => {
    const { sampleIdl } = await import("../helpers/sample-idl.js");
    const { buildTypesMap } = await import("@/idl/index.js");
    const { buildAccountTables, buildInstructionTables, generateDynamicSchemaSql } =
      await import("@/db/idl.js");
    const typesMap = buildTypesMap(sampleIdl.types as never);

    const instructionSql = buildInstructionTables(sampleIdl.instructions as never, typesMap).join(
      "\n",
    );
    expect(instructionSql).toContain("CREATE TABLE IF NOT EXISTS ix_deposit");
    expect(instructionSql).toContain("amount BIGINT NOT NULL");
    expect(instructionSql).toContain("flag BOOLEAN NOT NULL");
    expect(instructionSql).toContain("metadata JSONB NOT NULL");

    const accountSql = buildAccountTables(sampleIdl.accounts as never, typesMap).join("\n");
    expect(accountSql).toContain("CREATE TABLE IF NOT EXISTS acct_vault_account");
    expect(accountSql).toContain("authority VARCHAR(44) NOT NULL");
    expect(accountSql).toContain("nickname TEXT");
    expect(accountSql).toContain("metadata JSONB NOT NULL");
    expect(accountSql).toContain("CREATE TABLE IF NOT EXISTS acct_tuple_account");
    expect(accountSql).not.toContain("acct_enum_account");

    expect(generateDynamicSchemaSql(sampleIdl as never)).toContain("ix_deposit");
  });

  it("serializes instruction and account inserts with normalized values", async () => {
    const { sampleIdl } = await import("../helpers/sample-idl.js");
    const { buildTypesMap } = await import("@/idl/index.js");
    const {
      buildInstructionValueSql,
      insertAccountRow,
      insertInstructionRow,
      normalizeByteaValue,
      normalizeLargeNumericValue,
      normalizeScalarValue,
      serializeJsonValue,
    } = await import("@/db/idl.js");
    const typesMap = buildTypesMap(sampleIdl.types as never);
    let capturedInstructionQuery: unknown;
    let capturedAccountQuery: unknown;

    await insertInstructionRow({
      executor: {
        execute: async (query: unknown) => {
          capturedInstructionQuery = query;
          return undefined as never;
        },
      } as never,
      idl: sampleIdl as never,
      instruction: {
        data: {
          amount: { toArrayLike: () => [], toString: () => "42" },
          flag: true,
          memo: "hello",
          metadata: { nested: [1n, Buffer.from([1, 2])] },
        },
        name: "deposit",
      },
      signer: "signer-1",
      slot: 10n,
      txSignature: "sig-1",
      typesMap,
    });

    await insertAccountRow({
      account: {
        data: {
          authority: { toBase58: () => "pubkey-1", toString: () => "pubkey-1" },
          metadata: { level: 9n },
          nickname: null,
        },
        name: "VaultAccount",
        pubkey: "acct-1",
      },
      executor: {
        execute: async (query: unknown) => {
          capturedAccountQuery = query;
          return undefined as never;
        },
      } as never,
      idl: sampleIdl as never,
      slot: 11n,
      typesMap,
    });

    const instructionQuery = dialect.sqlToQuery(capturedInstructionQuery as never);
    const accountQuery = dialect.sqlToQuery(capturedAccountQuery as never);

    expect(instructionQuery.sql).toContain('INSERT INTO "ix_deposit"');
    expect(instructionQuery.params).toEqual([
      "10",
      "sig-1",
      "signer-1",
      "42",
      "hello",
      true,
      JSON.stringify({ nested: ["1", [1, 2]] }),
    ]);
    expect(accountQuery.sql).toContain('INSERT INTO "acct_vault_account"');
    expect(accountQuery.params).toEqual([
      "acct-1",
      "11",
      "pubkey-1",
      JSON.stringify({ level: "9" }),
    ]);

    expect(
      dialect.sqlToQuery(buildInstructionValueSql(Buffer.from([1, 2]), "bytes", typesMap) as never)
        .params,
    ).toEqual([Buffer.from([1, 2])]);
    expect(normalizeScalarValue({ toBase58: () => "pk", toString: () => "pk" })).toBe("pk");
    expect(normalizeLargeNumericValue(12n)).toBe("12");
    expect(normalizeByteaValue([1, 2, 3])).toEqual(Buffer.from([1, 2, 3]));
    expect(serializeJsonValue({ amount: 1n, bytes: Buffer.from([7]) })).toEqual({
      amount: "1",
      bytes: [7],
    });
  });
});
