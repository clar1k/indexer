import { env } from "@/env.js";
import type { Idl } from "@coral-xyz/anchor";
import { desc, eq, getTableName, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { bigint, jsonb, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";

export const programSetups = pgTable("program_setups", {
  programId: varchar("program_id", { length: 44 }).primaryKey(),
  idl: jsonb("idl").$type<Idl>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const programIndexerState = pgTable("program_indexer_state", {
  programId: varchar("program_id", { length: 44 }).primaryKey(),
  lastProcessedSlot: bigint("last_processed_slot", {
    mode: "bigint",
  }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const db = drizzle(env.DATABASE_URL, {
  schema: {
    programIndexerState,
    programSetups,
  },
});

export interface ProgramSetupRecord {
  programId: string;
  idl: Idl;
}

const programSetupsTableName = getTableName(programSetups);
const programIdColumnName = programSetups.programId.name;
const idlColumnName = programSetups.idl.name;
const createdAtColumnName = programSetups.createdAt.name;
const updatedAtColumnName = programSetups.updatedAt.name;
const programIndexerStateTableName = getTableName(programIndexerState);
const lastProcessedSlotColumnName = programIndexerState.lastProcessedSlot.name;

export const createProgramSetupsTableSql = () =>
  sql.raw(`
  CREATE TABLE IF NOT EXISTS "${programSetupsTableName}" (
    "${programIdColumnName}" VARCHAR(44) PRIMARY KEY,
    "${idlColumnName}" JSONB NOT NULL,
    "${createdAtColumnName}" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "${updatedAtColumnName}" TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`);

export const createProgramIndexerStateTableSql = () =>
  sql.raw(`
  CREATE TABLE IF NOT EXISTS "${programIndexerStateTableName}" (
    "${programIdColumnName}" VARCHAR(44) PRIMARY KEY,
    "${lastProcessedSlotColumnName}" BIGINT NOT NULL,
    "${createdAtColumnName}" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "${updatedAtColumnName}" TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`);

export const dropAllTablesSql = () =>
  sql.raw(`
  DO $$
  DECLARE
    table_record RECORD;
  BEGIN
    FOR table_record IN
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
    LOOP
      EXECUTE 'DROP TABLE IF EXISTS ' || quote_ident(table_record.tablename) || ' CASCADE';
    END LOOP;
  END $$;
`);

export const upsertProgramSetup = async ({ programId, idl }: ProgramSetupRecord) => {
  await db
    .insert(programSetups)
    .values({
      programId,
      idl,
    })
    .onConflictDoUpdate({
      target: programSetups.programId,
      set: {
        idl,
        updatedAt: sql`NOW()`,
      },
    });
};

export const getProgramSetup = async (programId: string): Promise<ProgramSetupRecord | null> => {
  const row = await db.query.programSetups.findFirst({
    where: eq(programSetups.programId, programId),
    columns: {
      programId: true,
      idl: true,
    },
  });

  if (!row) {
    return null;
  }

  return {
    programId: row.programId,
    idl: row.idl,
  };
};

export const getConfiguredProgramSetup = async (): Promise<ProgramSetupRecord | null> => {
  const row = await db.query.programSetups.findFirst({
    orderBy: desc(programSetups.updatedAt),
    columns: {
      programId: true,
      idl: true,
    },
  });

  if (!row) {
    return null;
  }

  return {
    programId: row.programId,
    idl: row.idl,
  };
};

export const getLastProcessedSlot = async (programId: string): Promise<bigint | null> => {
  const row = await db.query.programIndexerState.findFirst({
    where: eq(programIndexerState.programId, programId),
    columns: {
      lastProcessedSlot: true,
    },
  });

  return row?.lastProcessedSlot ?? null;
};

export const upsertLastProcessedSlot = async ({
  executor = db,
  programId,
  slot,
}: {
  executor?: Pick<typeof db, "insert">;
  programId: string;
  slot: bigint;
}) => {
  await executor
    .insert(programIndexerState)
    .values({
      programId,
      lastProcessedSlot: slot,
    })
    .onConflictDoUpdate({
      target: programIndexerState.programId,
      set: {
        lastProcessedSlot: sql`GREATEST(${programIndexerState.lastProcessedSlot}, ${slot})`,
        updatedAt: sql`NOW()`,
      },
    });
};
