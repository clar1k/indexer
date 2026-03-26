process.env.DATABASE_URL ??= "https://example.com/db";
process.env.RPC_URL ??= "https://example.com/rpc";
process.env.WS_URL ??= "https://example.com/ws";

import { PgDialect } from "drizzle-orm/pg-core";

type ProgramSetup = {
  idl: {
    instructions: Array<{
      args: Array<{ name: string; type: unknown }>;
      name: string;
    }>;
    types?: unknown[];
  };
  programId: string;
};

interface ExecuteCall {
  params: unknown[];
  sql: string;
}

let loadedModules:
  | Promise<{
      aggregateInstructionRows: typeof import("../../src/api/queryService.js").aggregateInstructionRows;
      app: typeof import("../../src/main.js").app;
      db: typeof import("../../src/db/index.js").db;
      getProgramStats: typeof import("../../src/api/queryService.js").getProgramStats;
      listInstructionRows: typeof import("../../src/api/queryService.js").listInstructionRows;
    }>
  | undefined;

export const sampleProgramSetup: ProgramSetup = {
  idl: {
    instructions: [
      {
        args: [
          { name: "amount", type: "u64" },
          { name: "memo", type: "string" },
          { name: "flag", type: "bool" },
        ],
        name: "deposit",
      },
      {
        args: [{ name: "amount", type: "u64" }],
        name: "withdraw",
      },
    ],
    types: [],
  },
  programId: "Prog1111111111111111111111111111111111111",
};

export const loadApiModules = async () => {
  loadedModules ??= (async () => {
    const queryService = await import("../../src/api/queryService.js");
    const dbModule = await import("../../src/db/index.js");
    const mainModule = await import("../../src/main.js");

    return {
      aggregateInstructionRows: queryService.aggregateInstructionRows,
      app: mainModule.app,
      db: dbModule.db,
      getProgramStats: queryService.getProgramStats,
      listInstructionRows: queryService.listInstructionRows,
    };
  })();

  return loadedModules;
};

export const withMockedDatabase = async ({
  execute,
  findProgramSetup = async () => sampleProgramSetup,
}: {
  execute?: (call: ExecuteCall) => Promise<{ rows: Record<string, unknown>[] }>;
  findProgramSetup?: () => Promise<ProgramSetup | null>;
}) => {
  const { db } = await loadApiModules();
  const calls: ExecuteCall[] = [];
  const dialect = new PgDialect();

  const originalExecute = db.execute;
  const originalFindFirst = db.query.programSetups.findFirst;

  db.query.programSetups.findFirst = findProgramSetup as typeof db.query.programSetups.findFirst;
  db.execute = (async (statement: Parameters<typeof db.execute>[0]) => {
    const rendered = dialect.sqlToQuery(statement as never);
    const call = {
      params: rendered.params,
      sql: rendered.sql,
    };

    calls.push(call);

    if (execute) {
      return execute(call);
    }

    return { rows: [] };
  }) as unknown as typeof db.execute;

  return {
    calls,
    restore: () => {
      db.execute = originalExecute;
      db.query.programSetups.findFirst = originalFindFirst;
    },
  };
};
