import { startApiServer } from "@/api/server.js";
import { ensureDynamicSchema } from "@/db/idl.js";
import {
  ensureBaseTables,
  getStoredProgramSetup,
  resetDatabase,
  upsertProgramSetup,
} from "@/db/index.js";
import { getConfig } from "@/env.js";
import { parseIdl } from "@/idl/index.js";
import { startIndexer } from "@/indexer/index.js";
import { logger } from "@/logger.js";
import { buildRuntimeContext, setRuntimeContext } from "@/runtime.js";

type ApiServer = ReturnType<typeof startApiServer>;

const closeServer = (server: ApiServer) =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

export const bootstrapApplication = async () => {
  logger.info("Startup phase: loading config");
  const config = getConfig();

  logger.info(
    {
      appPort: config.appPort,
      indexerEnabled: config.indexerEnabled,
      indexerMode: config.indexerEnabled ? config.indexerMode : null,
      programIdlPath: config.programIdlPath,
    },
    "Startup phase: config ready",
  );

  logger.info({ programIdlPath: config.programIdlPath }, "Startup phase: loading IDL");
  const idl = parseIdl({ filePath: config.programIdlPath });
  const runtimeContext = buildRuntimeContext({ config, idl });
  setRuntimeContext(runtimeContext);

  logger.info({ programId: runtimeContext.programId }, "Startup phase: syncing schema");
  await ensureBaseTables();
  const existingSetup = await getStoredProgramSetup();

  if (existingSetup && existingSetup.programId !== runtimeContext.programId) {
    logger.info(
      {
        nextProgramId: runtimeContext.programId,
        previousProgramId: existingSetup.programId,
      },
      "Startup phase: program changed, resetting database",
    );
    await resetDatabase();
    await ensureBaseTables();
  }

  await ensureDynamicSchema({ idl });
  await upsertProgramSetup({
    idl,
    programId: runtimeContext.programId,
  });
  logger.info({ programId: runtimeContext.programId }, "Startup phase: schema sync complete");

  if (!config.indexerEnabled) {
    logger.info({ port: config.appPort }, "Startup phase: starting API");
    startApiServer({ port: config.appPort });
    logger.info("Startup phase: indexer disabled");
    return;
  }

  if (config.indexerMode === "backfill") {
    logger.info({ mode: config.indexerMode }, "Startup phase: starting indexer");
    await startIndexer({
      abortSignal: new AbortController().signal,
      config,
      runtime: runtimeContext.indexerRuntime,
    });
    return;
  }

  logger.info({ port: config.appPort }, "Startup phase: starting API");
  const server = startApiServer({ port: config.appPort });
  const abortController = new AbortController();
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info({ signal }, "Shutdown requested");
    abortController.abort(new Error(`Received ${signal}`));
    server.close();
  };

  const handleSigint = () => shutdown("SIGINT");
  const handleSigterm = () => shutdown("SIGTERM");

  process.once("SIGINT", handleSigint);
  process.once("SIGTERM", handleSigterm);

  try {
    logger.info({ mode: config.indexerMode }, "Startup phase: starting indexer");
    await startIndexer({
      abortSignal: abortController.signal,
      config,
      runtime: runtimeContext.indexerRuntime,
    });
  } finally {
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
    await closeServer(server).catch((error) => {
      logger.error({ err: error }, "Failed to close API server cleanly");
    });
  }
};
