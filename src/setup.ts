import { buildAccountTables, buildInstructionTables } from "@/db/idl.js";
import {
  createProgramIndexerStateTableSql,
  createProgramSetupsTableSql,
  db,
  dropAllTablesSql,
  upsertProgramSetup,
} from "@/db/index.js";
import { buildTypesMap, parseIdl } from "@/idl/index.js";
import { logger } from "@/logger.js";
import type { Idl } from "@coral-xyz/anchor";
import { sql } from "drizzle-orm";

const init = async () => {
  const idlPath = process.argv[2];
  if (!idlPath) {
    throw new Error("Invalid argument");
  }

  logger.info({ idlPath }, "Starting setup");

  const idl: Idl = parseIdl({ filePath: idlPath });
  const programId = idl.address;

  if (!programId) {
    throw new Error("IDL address is required");
  }

  logger.info({ programId }, "Parsed IDL successfully");

  const idlTypes = idl?.types ?? [];
  const idlTypesMap = buildTypesMap(idlTypes);

  const schemaSql = [
    ...buildAccountTables(idl.accounts ?? [], idlTypesMap),
    ...buildInstructionTables(idl.instructions, idlTypesMap),
  ].join("\n");

  logger.info({ programId }, "Flushing database tables");
  logger.info({ programId }, "Rebuilding schema");

  await db.transaction(async (tx) => {
    await tx.execute(dropAllTablesSql());
    await tx.execute(createProgramSetupsTableSql());
    await tx.execute(createProgramIndexerStateTableSql());
    await tx.execute(sql.raw(schemaSql));
  });

  await upsertProgramSetup({ programId, idl });
};

init();
