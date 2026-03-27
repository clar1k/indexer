import * as fs from "fs";
import { logger } from "@/logger.js";
import type {} from "@coral-xyz/anchor";
import type { IdlTypeDef, IdlType, Idl } from "@coral-xyz/anchor/dist/cjs/idl.js";
import { createHash } from "crypto";

export const parseIdl = (args: { filePath: string }) => {
  let rawIdl: string;

  try {
    rawIdl = fs.readFileSync(args.filePath, "utf-8");
  } catch (error) {
    throw new Error(`Failed to read IDL at ${args.filePath}: ${String(error)}`);
  }

  try {
    return JSON.parse(rawIdl) as Idl;
  } catch (error) {
    throw new Error(`Failed to parse IDL JSON at ${args.filePath}: ${String(error)}`);
  }
};

interface ColumnDefinition {
  sqlType: string;
  nullable: boolean;
}

export type TypeMap = Map<string, IdlTypeDef>;

export const mapType = (
  type: IdlType,
  typesMap: TypeMap,
  nullable: boolean = false,
): ColumnDefinition => {
  if (type === "bool") return { sqlType: "BOOLEAN", nullable };
  if (type === "u8" || type === "i8") return { sqlType: "SMALLINT", nullable };
  if (type === "u16" || type === "i16") return { sqlType: "SMALLINT", nullable };
  if (type === "u32" || type === "i32") return { sqlType: "INTEGER", nullable };
  if (type === "u64" || type === "i64") return { sqlType: "BIGINT", nullable };
  if (type === "u128" || type === "i128") return { sqlType: "NUMERIC(39,0)", nullable }; // too big for BIGINT
  if (type === "f32") return { sqlType: "REAL", nullable };
  if (type === "f64") return { sqlType: "DOUBLE PRECISION", nullable };
  if (type === "string") return { sqlType: "TEXT", nullable };
  if (type === "pubkey") return { sqlType: "VARCHAR(44)", nullable };
  if (type === "bytes") return { sqlType: "BYTEA", nullable };

  if (typeof type === "object") {
    if ("option" in type) {
      return mapType(type.option, typesMap, true);
    }

    if ("vec" in type) {
      return { sqlType: "JSONB", nullable };
    }

    if ("array" in type) {
      return { sqlType: "JSONB", nullable };
    }

    if ("defined" in type) {
      // anchor v0.30+ uses { name: string }
      const typeName = typeof type.defined === "string" ? type.defined : type.defined.name;

      const resolved = typesMap.get(typeName);

      if (!resolved) {
        logger.warn({ typeName }, "Unknown defined type, falling back to JSONB");
        return { sqlType: "JSONB", nullable };
      }

      const kind = resolved.type.kind;

      if (kind === "enum") {
        const hasData = resolved.type.variants.some((v) => v.fields && v.fields.length > 0);

        if (hasData) {
          return { sqlType: "JSONB", nullable };
        } else {
          return { sqlType: "TEXT", nullable };
        }
      }

      if (kind === "struct") {
        return { sqlType: "JSONB", nullable };
      }
    }
  }

  logger.warn({ type }, "Unhandled type, falling back to JSONB");

  return { sqlType: "JSONB", nullable };
};

export const buildTypesMap = (types: IdlTypeDef[]): Map<string, IdlTypeDef> => {
  const map = new Map<string, IdlTypeDef>();

  for (const type of types) {
    map.set(type.name, type);
  }

  return map;
};

export const buildDiscriminatorMap = (idl: Idl) => {
  const map = new Map<string, string>();

  for (const ix of idl.instructions) {
    const hash = createHash("sha256").update(`global:${ix.name}`).digest();
    const discriminator = hash.slice(0, 8).toString("hex");
    map.set(discriminator, ix.name);
  }

  return map;
};

export const buildAccountDiscriminatorMap = (idl: Idl) => {
  const map = new Map<string, string>();

  for (const account of idl.accounts ?? []) {
    const hash = createHash("sha256").update(`account:${account.name}`).digest();
    const discriminator = hash.slice(0, 8).toString("hex");
    map.set(discriminator, account.name);
  }

  return map;
};
