import {
  loadCheckpointAndTip,
  loadConfiguredProgramId,
  loadIndexerRuntime,
  parseCliOptions,
} from "@/indexer/core.js";
import type { CliOptions } from "@/indexer/types.js";
import { logger } from "@/logger.js";
import { runRealtime } from "@/indexer/realtime.js";

export const startIndexer = async (cliOptions: CliOptions) => {
  const abortController = new AbortController();
  let shuttingDown = false;

  const shutdown = () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info("Shutting down indexer");
    abortController.abort();
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  const programId = await loadConfiguredProgramId();
  const runtime = await loadIndexerRuntime(programId);
  logger.info({ mode: cliOptions.mode, programId: programId.toString() }, "Indexer starting");

  try {
    if (cliOptions.mode === "backfill") {
      const { runBackfill } = await import("@/indexer/backfill.js");

      if (cliOptions.signatures) {
        await runBackfill({
          abortSignal: abortController.signal,
          programId,
          runtime,
          signatures: cliOptions.signatures,
        });
      } else {
        const { latestProcessedSlot, currentSlot } = await loadCheckpointAndTip(
          programId,
          { slotFrom: cliOptions.slotFrom, slotTo: cliOptions.slotTo },
          abortController.signal,
        );

        await runBackfill({
          abortSignal: abortController.signal,
          fromExclusive: latestProcessedSlot,
          programId,
          runtime,
          toInclusive: currentSlot,
        });
      }

      return;
    }

    await runRealtime({
      abortSignal: abortController.signal,
      programId,
      runtime,
    });
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
};

const shouldRunAsScript = () => {
  const entrypoint = process.argv[1];

  if (!entrypoint) {
    return false;
  }

  return import.meta.url === new URL(entrypoint, "file:").href;
};

if (shouldRunAsScript()) {
  const cliOptions = parseCliOptions();

  startIndexer(cliOptions).catch((error) => {
    logger.error({ err: error, mode: cliOptions.mode }, "Indexer process failed");
    process.exitCode = 1;
  });
}
