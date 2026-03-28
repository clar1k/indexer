import type { BackfillConfig, RealtimeConfig } from "@/env.js";
import { loadCheckpointAndTip } from "@/indexer/core.js";
import { runBackfill } from "@/indexer/backfill.js";
import type { IndexerRuntime } from "@/indexer/types.js";
import { logger } from "@/logger.js";
import { runRealtime } from "@/indexer/realtime.js";
import type { Signature } from "@solana/kit";

export const startIndexer = async ({
  abortSignal,
  config,
  runtime,
}: {
  abortSignal: AbortSignal;
  config: BackfillConfig | RealtimeConfig;
  runtime: IndexerRuntime;
}) => {
  const programId = runtime.programId;
  logger.info({ mode: config.indexerMode, programId: programId.toString() }, "Indexer starting");

  if (config.indexerMode === "backfill") {
    if (config.backfill.kind === "signatures") {
      await runBackfill({
        abortSignal,
        programId,
        runtime,
        signatures: config.backfill.signatures as Signature[],
      });
    } else {
      await runBackfill({
        abortSignal,
        fromExclusive: config.backfill.slotFrom - 1n,
        programId,
        runtime,
        toInclusive: config.backfill.slotTo,
      });
    }

    logger.info({ programId: programId.toString() }, "Backfill job finished");
    return;
  }

  const { latestProcessedSlot, currentSlot } = await loadCheckpointAndTip(
    programId,
    {},
    abortSignal,
  );

  logger.info(
    {
      currentSlot: currentSlot.toString(),
      latestProcessedSlot: latestProcessedSlot.toString(),
      programId: programId.toString(),
    },
    "Indexer ready: realtime catch-up starting",
  );

  await runRealtime({
    abortSignal,
    programId,
    runtime,
  });
};
