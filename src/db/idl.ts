import { mapType, type TypeMap } from "@/idl/index.js";
import { logger } from "@/logger.js";
import { toSnakeCase } from "drizzle-orm/casing";
import type { Idl } from "@coral-xyz/anchor";
import type { IdlField, IdlType } from "@coral-xyz/anchor/dist/cjs/idl.js";
import { db } from "@/db/index.js";
import { sql } from "drizzle-orm";

const INTERNAL_ROW_ID_COLUMN = "indexer_row_id";

export const buildAccountTables = (
  accounts: NonNullable<Idl["accounts"]>,
  typesMap: TypeMap,
): string[] => {
  const sqlStatements: string[] = [];

  for (const acc of accounts) {
    const accountType = typesMap.get(acc.name);

    if (!accountType) {
      logger.warn({ accountName: acc.name }, "No type definition found for account");
      continue;
    }

    if (accountType.type.kind !== "struct") {
      logger.warn(
        { accountName: acc.name, kind: accountType.type.kind },
        "Account is not a struct, skipping",
      );
      continue;
    }

    const fields = accountType.type.fields ?? [];
    const tableName = `acct_${toSnakeCase(acc.name)}`;

    // base columns every account table gets
    const columns = [
      `${INTERNAL_ROW_ID_COLUMN} SERIAL PRIMARY KEY`,
      `pubkey VARCHAR(44) NOT NULL`,
      `slot BIGINT NOT NULL`,
      `updated_at TIMESTAMPTZ DEFAULT NOW()`,
    ];

    // dynamically add columns from IDL fields
    for (const field of fields) {
      // `fields` can be `IdlField[]` (named struct) or `IdlType[]` (tuple struct).
      // Tuple struct fields don't have a top-level `name`, so we skip them here.
      const isValid = typeof field === "object" && field !== null && "name" in field;
      if (!isValid) {
        continue;
      }

      const idlField = field as IdlField;
      const { sqlType, nullable } = mapType(idlField.type as IdlType, typesMap);

      columns.push(`${toSnakeCase(idlField.name)} ${sqlType}${nullable ? "" : " NOT NULL"}`);
    }

    sqlStatements.push(`
      CREATE TABLE IF NOT EXISTS ${tableName} (
        ${columns.join(",\n        ")}
      );
    `);
  }

  return sqlStatements;
};

export const buildInstructionTables = (
  instructions: Idl["instructions"],
  typesMap: TypeMap,
): string[] => {
  const sqlStatements: string[] = [];

  for (const ix of instructions) {
    const tableName = `ix_${toSnakeCase(ix.name)}`;

    // base columns every instruction table gets
    const columns = [
      `${INTERNAL_ROW_ID_COLUMN} SERIAL PRIMARY KEY`,
      `slot BIGINT NOT NULL`,
      `tx_signature VARCHAR(88) NOT NULL`,
      `signer VARCHAR(44) NOT NULL`,
      `created_at TIMESTAMPTZ DEFAULT NOW()`,
    ];

    // args are always IdlField[] so no tuple check needed
    for (const arg of ix.args) {
      const { sqlType, nullable } = mapType(arg.type as IdlType, typesMap);
      columns.push(`${toSnakeCase(arg.name)} ${sqlType}${nullable ? "" : " NOT NULL"}`);
    }

    sqlStatements.push(`
      CREATE TABLE IF NOT EXISTS ${tableName} (
        ${columns.join(",\n        ")}
      );

      CREATE INDEX IF NOT EXISTS ${tableName}_slot_idx
        ON ${tableName} (slot);

      CREATE INDEX IF NOT EXISTS ${tableName}_signer_idx
        ON ${tableName} (signer);

      CREATE INDEX IF NOT EXISTS ${tableName}_tx_signature_idx
        ON ${tableName} (tx_signature);
    `);
  }

  return sqlStatements;
};

interface DecodedInstruction {
  name: string;
  data: object;
}

type DecodedAccount = {
  name: string;
  data: object;
  pubkey: string;
};

interface InsertInstructionRowArgs {
  executor?: Pick<typeof db, "execute">;
  idl: Idl;
  typesMap: TypeMap;
  instruction: DecodedInstruction;
  slot: bigint;
  txSignature: string;
  signer: string;
}

type InsertAccountRowArgs = {
  account: DecodedAccount;
  executor?: Pick<typeof db, "execute">;
  idl: Idl;
  slot: bigint;
  typesMap: TypeMap;
};

export const insertInstructionRow = async ({
  executor = db,
  idl,
  typesMap,
  instruction,
  slot,
  txSignature,
  signer,
}: InsertInstructionRowArgs) => {
  const instructionDefinition = idl.instructions.find((ix) => ix.name === instruction.name);

  if (!instructionDefinition) {
    throw new Error(`Instruction ${instruction.name} is missing from IDL`);
  }

  const tableName = `ix_${toSnakeCase(instruction.name)}`;
  const instructionData = instruction.data as Record<string, unknown>;
  const columns = [
    sql.identifier("slot"),
    sql.identifier("tx_signature"),
    sql.identifier("signer"),
  ];
  const values = [sql`${slot.toString()}`, sql`${txSignature}`, sql`${signer}`];

  for (const arg of instructionDefinition.args) {
    const columnName = toSnakeCase(arg.name);
    const rawValue = instructionData[arg.name];

    columns.push(sql.identifier(columnName));
    values.push(buildInstructionValueSql(rawValue, arg.type as IdlType, typesMap));
  }

  try {
    await executor.execute(sql`
      INSERT INTO ${sql.identifier(tableName)} (${sql.join(columns, sql`, `)})
      VALUES (${sql.join(values, sql`, `)})
    `);
  } catch (error) {
    logger.error(
      {
        columnCount: columns.length,
        err: error,
        instructionName: instruction.name,
        programInstructionName: instructionDefinition.name,
        signer,
        slot: slot.toString(),
        tableName,
        txSignature,
      },
      "Failed to insert instruction row",
    );
    throw error;
  }
};

export const insertAccountRow = async ({
  account,
  executor = db,
  idl,
  slot,
  typesMap,
}: InsertAccountRowArgs) => {
  const accountDefinition = idl.accounts?.find((entry) => entry.name === account.name);

  if (!accountDefinition) {
    throw new Error(`Account ${account.name} is missing from IDL`);
  }

  const accountType = typesMap.get(account.name);

  if (!accountType) {
    throw new Error(`Account type ${account.name} is missing from IDL types`);
  }

  if (accountType.type.kind !== "struct") {
    throw new Error(`Account ${account.name} is not a struct`);
  }

  const tableName = `acct_${toSnakeCase(accountDefinition.name)}`;
  const accountData = account.data as Record<string, unknown>;
  const columns = [sql.identifier("pubkey"), sql.identifier("slot")];
  const values = [sql`${account.pubkey}`, sql`${slot.toString()}`];

  for (const field of accountType.type.fields ?? []) {
    const isValid = typeof field === "object" && field !== null && "name" in field;

    if (!isValid) {
      continue;
    }

    const idlField = field as IdlField;
    const columnName = toSnakeCase(idlField.name);
    const rawValue = accountData[idlField.name];

    columns.push(sql.identifier(columnName));
    values.push(buildInstructionValueSql(rawValue, idlField.type as IdlType, typesMap));
  }

  logger.info(
    {
      accountName: account.name,
      columnCount: columns.length,
      pubkey: account.pubkey,
      slot: slot.toString(),
      tableName,
    },
    "Writing account row to database",
  );

  try {
    await executor.execute(sql`
      INSERT INTO ${sql.identifier(tableName)} (${sql.join(columns, sql`, `)})
      VALUES (${sql.join(values, sql`, `)})
    `);
  } catch (error) {
    logger.error(
      {
        accountName: account.name,
        columnCount: columns.length,
        err: error,
        pubkey: account.pubkey,
        slot: slot.toString(),
        tableName,
      },
      "Failed to insert account row",
    );
    throw error;
  }
};

export const buildInstructionValueSql = (value: unknown, type: IdlType, typesMap: TypeMap) => {
  if (value === undefined || value === null) {
    return sql`NULL`;
  }

  const { sqlType } = mapType(type, typesMap);

  if (sqlType === "JSONB") {
    return sql`${JSON.stringify(serializeJsonValue(value))}::jsonb`;
  }

  if (sqlType === "BYTEA") {
    return sql`${normalizeByteaValue(value)}`;
  }

  if (sqlType === "BIGINT" || sqlType.startsWith("NUMERIC")) {
    return sql`${normalizeLargeNumericValue(value)}`;
  }

  return sql`${normalizeScalarValue(value)}`;
};

export const normalizeScalarValue = (value: unknown): unknown => {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "bigint" || typeof value === "string" || typeof value === "number") {
    return value;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (Buffer.isBuffer(value)) {
    return value;
  }

  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }

  if (isPublicKeyLike(value) || isBnLike(value)) {
    return value.toString();
  }

  return JSON.stringify(serializeJsonValue(value));
};

export const normalizeLargeNumericValue = (value: unknown): string => {
  if (typeof value === "bigint" || typeof value === "number" || typeof value === "string") {
    return value.toString();
  }

  if (isBnLike(value)) {
    return value.toString();
  }

  throw new Error(`Cannot normalize numeric value: ${String(value)}`);
};

export const normalizeByteaValue = (value: unknown): Buffer => {
  if (Buffer.isBuffer(value)) {
    return value;
  }

  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }

  if (Array.isArray(value) && value.every((entry) => typeof entry === "number")) {
    return Buffer.from(value);
  }

  throw new Error(`Cannot normalize bytea value: ${String(value)}`);
};

export const serializeJsonValue = (value: unknown): unknown => {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint" || isBnLike(value) || isPublicKeyLike(value)) {
    return value.toString();
  }

  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Array.from(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => serializeJsonValue(entry));
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, serializeJsonValue(entry)]),
    );
  }

  return String(value);
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !Buffer.isBuffer(value) &&
  !(value instanceof Uint8Array);

const isBnLike = (value: unknown): value is { toString(): string; toArrayLike?: unknown } =>
  typeof value === "object" &&
  value !== null &&
  "toString" in value &&
  typeof value.toString === "function" &&
  "toArrayLike" in value;

const isPublicKeyLike = (value: unknown): value is { toString(): string; toBase58?: unknown } =>
  typeof value === "object" &&
  value !== null &&
  "toString" in value &&
  typeof value.toString === "function" &&
  ("toBase58" in value || "toBytes" in value);
