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

const waitForShutdownSignal = ({
  abortController,
  server,
}: {
  abortController?: AbortController;
  server?: ApiServer;
}) =>
  new Promise<void>((resolve) => {
    let finished = false;

    const finish = () => {
      if (finished) {
        return;
      }

      finished = true;
      process.off("SIGINT", handleSigint);
      process.off("SIGTERM", handleSigterm);
      resolve();
    };

    const shutdown = (signal: string) => {
      if (finished) {
        return;
      }

      logger.info({ signal }, "Shutdown requested");
      abortController?.abort(new Error(`Received ${signal}`));

      if (!server) {
        finish();
        return;
      }

      closeServer(server)
        .catch((error) => {
          logger.error({ err: error }, "Failed to close API server cleanly");
        })
        .finally(finish);
    };

    const handleSigint = () => shutdown("SIGINT");
    const handleSigterm = () => shutdown("SIGTERM");

    process.once("SIGINT", handleSigint);
    process.once("SIGTERM", handleSigterm);
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
    const server = startApiServer({ port: config.appPort });
    logger.info("Startup phase: indexer disabled");
    await waitForShutdownSignal({ server });
    return;
  }

  if (config.indexerMode === "backfill") {
    const abortController = new AbortController();
    const signalWatcher = waitForShutdownSignal({ abortController });

    logger.info({ mode: config.indexerMode }, "Startup phase: starting indexer");
    try {
      await startIndexer({
        abortSignal: abortController.signal,
        config,
        runtime: runtimeContext.indexerRuntime,
      });
    } finally {
      abortController.abort(new Error("Backfill finished"));
      void signalWatcher;
    }
    return;
  }

  logger.info({ port: config.appPort }, "Startup phase: starting API");
  const server = startApiServer({ port: config.appPort });
  const abortController = new AbortController();
  void waitForShutdownSignal({ abortController });

  try {
    logger.info({ mode: config.indexerMode }, "Startup phase: starting indexer");
    await startIndexer({
      abortSignal: abortController.signal,
      config,
      runtime: runtimeContext.indexerRuntime,
    });
  } finally {
    abortController.abort(new Error("Realtime loop finished"));
    await closeServer(server).catch((error) => {
      logger.error({ err: error }, "Failed to close API server cleanly");
    });
  }
};
