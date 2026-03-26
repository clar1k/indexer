import test from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  buildAccountTables,
  buildInstructionTables,
  buildInstructionValueSql,
  insertInstructionRow,
  normalizeByteaValue,
  normalizeLargeNumericValue,
  normalizeScalarValue,
  serializeJsonValue,
} from "../src/db/idl.js";
import { decodeInstruction } from "../src/indexer/core.js";
import {
  buildDiscriminatorMap,
  buildTypesMap,
  mapType,
} from "../src/idl/index.js";

const pgDialect = new PgDialect();

const sampleIdl = {
  address: "11111111111111111111111111111111",
  metadata: { name: "sample", version: "0.1.0", spec: "0.1.0" },
  instructions: [
    {
      name: "createThing",
      discriminator: [],
      accounts: [],
      args: [
        { name: "amount", type: "u64" },
        { name: "memo", type: { option: "string" } },
        { name: "payload", type: { vec: "u8" } },
      ],
    },
  ],
  accounts: [{ name: "UserAccount", discriminator: [] }],
  types: [
    {
      name: "UserAccount",
      type: {
        kind: "struct",
        fields: [
          { name: "authority", type: "pubkey" },
          { name: "nickname", type: { option: "string" } },
          { name: "metadata", type: { defined: { name: "Metadata" } } },
        ],
      },
    },
    {
      name: "Metadata",
      type: {
        kind: "struct",
        fields: [{ name: "level", type: "u64" }],
      },
    },
    {
      name: "EmptyEnum",
      type: {
        kind: "enum",
        variants: [{ name: "A" }, { name: "B" }],
      },
    },
    {
      name: "RichEnum",
      type: {
        kind: "enum",
        variants: [{ name: "A", fields: [{ name: "value", type: "u64" }] }],
      },
    },
    {
      name: "TupleAccount",
      type: {
        kind: "struct",
        fields: ["u64", "string"],
      },
    },
    {
      name: "NonStructAccount",
      type: {
        kind: "enum",
        variants: [{ name: "Only" }],
      },
    },
  ],
} as const;

test("mapType handles primitives, nullable options, defined types, and fallbacks", () => {
  const typesMap = buildTypesMap(sampleIdl.types as never);

  assert.deepEqual(mapType("bool", typesMap), {
    sqlType: "BOOLEAN",
    nullable: false,
  });
  assert.deepEqual(mapType({ option: "u64" }, typesMap), {
    sqlType: "BIGINT",
    nullable: true,
  });
  assert.deepEqual(mapType({ defined: { name: "Metadata" } }, typesMap), {
    sqlType: "JSONB",
    nullable: false,
  });
  assert.deepEqual(mapType({ defined: { name: "EmptyEnum" } }, typesMap), {
    sqlType: "TEXT",
    nullable: false,
  });
  assert.deepEqual(mapType({ defined: { name: "RichEnum" } }, typesMap), {
    sqlType: "JSONB",
    nullable: false,
  });
  assert.deepEqual(mapType({ array: ["u8", 4] }, typesMap), {
    sqlType: "JSONB",
    nullable: false,
  });
  assert.deepEqual(mapType({ defined: { name: "MissingType" } }, typesMap), {
    sqlType: "JSONB",
    nullable: false,
  });
});

test("buildTypesMap and buildDiscriminatorMap index types and derive deterministic discriminators", () => {
  const typesMap = buildTypesMap(sampleIdl.types as never);
  const discriminatorMap = buildDiscriminatorMap(sampleIdl as never);

  assert.equal(typesMap.get("Metadata")?.name, "Metadata");
  assert.equal(discriminatorMap.size, 1);
  assert.equal(discriminatorMap.get("200aad831e7810a2"), "createThing");
});

test("buildInstructionTables and buildAccountTables generate expected dynamic SQL", () => {
  const typesMap = buildTypesMap(sampleIdl.types as never);

  const instructionSql = buildInstructionTables(
    sampleIdl.instructions as never,
    typesMap
  ).join("\n");
  assert.match(instructionSql, /CREATE TABLE IF NOT EXISTS ix_create_thing/);
  assert.match(instructionSql, /amount BIGINT NOT NULL/);
  assert.match(instructionSql, /memo TEXT/);
  assert.match(instructionSql, /payload JSONB NOT NULL/);
  assert.match(instructionSql, /ix_create_thing_slot_idx/);
  assert.match(instructionSql, /ix_create_thing_signer_idx/);
  assert.match(instructionSql, /ix_create_thing_tx_signature_idx/);

  const accountSql = buildAccountTables(
    [
      { name: "UserAccount", discriminator: [] },
      { name: "TupleAccount", discriminator: [] },
      { name: "NonStructAccount", discriminator: [] },
      { name: "MissingAccount", discriminator: [] },
    ] as never,
    typesMap
  ).join("\n");

  assert.match(accountSql, /CREATE TABLE IF NOT EXISTS acct_user_account/);
  assert.match(accountSql, /authority VARCHAR\(44\) NOT NULL/);
  assert.match(accountSql, /nickname TEXT/);
  assert.match(accountSql, /metadata JSONB NOT NULL/);
  assert.match(accountSql, /CREATE TABLE IF NOT EXISTS acct_tuple_account/);
  assert.doesNotMatch(accountSql, /acct_non_struct_account/);
  assert.doesNotMatch(accountSql, /acct_missing_account/);
});

test("insertInstructionRow serializes decoded args into the expected SQL parameters", async () => {
  const typesMap = buildTypesMap(sampleIdl.types as never);
  let capturedQuery: unknown;

  await insertInstructionRow({
    executor: {
      execute: async (query: unknown) => {
        capturedQuery = query;
        return undefined as never;
      },
    } as never,
    idl: sampleIdl as never,
    instruction: {
      name: "createThing",
      data: {
        amount: { toString: () => "42", toArrayLike: () => [] },
        memo: {
          toString: () => "pubkey-as-text",
          toBase58: () => "pubkey-as-text",
        },
        payload: {
          nested: [
            1n,
            { toString: () => "9", toArrayLike: () => [] },
            Buffer.from([1, 2]),
          ],
        },
      },
    },
    signer: "signer-1",
    slot: 77n,
    txSignature: "tx-1",
    typesMap,
  });

  const compiled = pgDialect.sqlToQuery(capturedQuery as never);
  assert.match(compiled.sql, /INSERT INTO "ix_create_thing"/);
  assert.deepEqual(compiled.params, [
    "77",
    "tx-1",
    "signer-1",
    "42",
    "pubkey-as-text",
    JSON.stringify({ nested: ["1", "9", [1, 2]] }),
  ]);
});

test("value normalization handles scalar, numeric, bytea, and JSON payload variants", () => {
  assert.equal(
    normalizeScalarValue({ toString: () => "bn-1", toArrayLike: () => [] }),
    "bn-1"
  );
  assert.equal(normalizeLargeNumericValue(123n), "123");
  assert.deepEqual(normalizeByteaValue([1, 2, 3]), Buffer.from([1, 2, 3]));
  assert.deepEqual(
    serializeJsonValue({
      amount: 5n,
      authority: { toString: () => "pk-1", toBase58: () => "pk-1" },
      bytes: new Uint8Array([7, 8]),
      nested: [{ toString: () => "bn-2", toArrayLike: () => [] }],
    }),
    {
      amount: "5",
      authority: "pk-1",
      bytes: [7, 8],
      nested: ["bn-2"],
    }
  );

  const byteaQuery = pgDialect.sqlToQuery(
    buildInstructionValueSql(new Uint8Array([4, 5]), "bytes", new Map())
  );
  assert.deepEqual(byteaQuery.params, [Buffer.from([4, 5])]);
});

test("decodeInstruction decodes known discriminators and ignores unknown ones", () => {
  const encoded = bs58.encode(
    Buffer.concat([Buffer.from("0102030405060708", "hex"), Buffer.from("body")])
  );
  const decodeCalls: Buffer[] = [];
  const coder = {
    instruction: {
      decode: (buffer: Buffer) => {
        decodeCalls.push(buffer);
        return { name: "createThing", data: { amount: 1 } };
      },
    },
  };

  const decoded = decodeInstruction(
    encoded,
    coder as never,
    new Map([["0102030405060708", "createThing"]])
  );
  assert.deepEqual(decoded, { name: "createThing", data: { amount: 1 } });
  assert.equal(decodeCalls.length, 1);

  const unknown = decodeInstruction(encoded, coder as never, new Map());
  assert.equal(unknown, null);
  assert.equal(decodeCalls.length, 1);
});
