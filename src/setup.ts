import { buildAccountTables, buildInstructionTables } from "@/db/idl.js";
import { db } from "@/db/index.js";
import { buildTypesMap, parseIdl } from "@/idl/index.js";
import type { Idl } from "@coral-xyz/anchor";

const setup = async () => {
  const idlPath = process.argv[2];
  if (!idlPath) {
    throw new Error("Invalid argument");
  }

  console.log(`Starting setup, parsing IDL from ${idlPath}`);

  const idl: Idl = parseIdl({ filePath: idlPath });
  console.log(`Parsed IDL successfully: ${idl}`);

  const idlTypes = idl?.types ?? [];
  const idlTypesMap = buildTypesMap(idlTypes);

  const sql = [
    ...buildAccountTables(idl.accounts ?? [], idlTypesMap),
    ...buildInstructionTables(idl.instructions, idlTypesMap),
  ].join("\n");

  console.log("[setup] sql statements", sql);

  await db.execute(sql);
};

setup();
