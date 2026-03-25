import { mapType, type TypeMap } from "@/idl/index.js";
import { toSnakeCase } from "drizzle-orm/casing";
import type { Idl } from "@coral-xyz/anchor";
import type { IdlField, IdlType } from "@coral-xyz/anchor/dist/cjs/idl.js";

export const buildAccountTables = (
  accounts: NonNullable<Idl["accounts"]>,
  typesMap: TypeMap,
): string[] => {
  const sqlStatements: string[] = [];

  for (const acc of accounts) {
    const accountType = typesMap.get(acc.name);

    if (!accountType) {
      console.warn(`No type definition found for account: ${acc.name}`);
      continue;
    }

    if (accountType.type.kind !== "struct") {
      console.warn(`Account ${acc.name} is not a struct, skipping`);
      continue;
    }

    const fields = accountType.type.fields ?? [];
    const tableName = `acct_${toSnakeCase(acc.name)}`;

    // base columns every account table gets
    const columns = [
      `id SERIAL PRIMARY KEY`,
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
      `id SERIAL PRIMARY KEY`,
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
    `);
  }

  return sqlStatements;
};
