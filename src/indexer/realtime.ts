import { runBackfill } from "@/indexer/backfill.js";
import { loadCheckpointAndTip, processTransaction } from "@/indexer/core.js";
import type { IndexerRuntime } from "@/indexer/types.js";
import { logger } from "@/logger.js";
import { rpcSubscriptions } from "@/solana/index.js";
import type { Address } from "@solana/kit";

const isAbortError = (error: unknown) =>
  error instanceof Error &&
  (error.name === "AbortError" || error.message === "This operation was aborted");

export const realtimeDeps = {
  createLogsSubscription: (programId: Address, abortSignal: AbortSignal) =>
    rpcSubscriptions.logsNotifications({ mentions: [programId] }).subscribe({ abortSignal }),
  loadCheckpointAndTip,
  processTransaction,
  runBackfill,
};

export const runRealtime = async ({
  programId,
  runtime,
  abortSignal,
}: {
  programId: Address;
  runtime: IndexerRuntime;
  abortSignal: AbortSignal;
}) => {
  const recentLiveSignatures = new Set<string>();
  const recentLiveSignatureQueue: string[] = [];
  const maxRecentLiveSignatures = 10_000;

  logger.info({ programId: programId.toString() }, "Starting realtime subscription");

  while (!abortSignal.aborted) {
    const { latestProcessedSlot, currentSlot } = await realtimeDeps.loadCheckpointAndTip(
      programId,
      {},
      abortSignal,
    );

    logger.info(
      {
        fromExclusive: latestProcessedSlot.toString(),
        programId: programId.toString(),
        toInclusive: currentSlot.toString(),
      },
      "Running backfill before live subscription",
    );

    await realtimeDeps.runBackfill({
      abortSignal,
      fromExclusive: latestProcessedSlot,
      programId,
      runtime,
      toInclusive: currentSlot,
    });

    logger.info({ programId: programId.toString() }, "Backfill before live subscription completed");

    if (abortSignal.aborted) {
      break;
    }

    try {
      logger.info({ programId: programId.toString() }, "Subscribing to live logs");

      const notifications = await realtimeDeps.createLogsSubscription(programId, abortSignal);

      logger.info({ programId: programId.toString() }, "Realtime subscription established");

      for await (const notification of notifications) {
        if (abortSignal.aborted) {
          break;
        }

        const signature = notification.value?.signature;
        const slot = notification.context?.slot;

        if (!signature || slot === undefined) {
          logger.warn({ notification }, "Skipping malformed log notification");
          continue;
        }

        const signatureKey = signature.toString();
        logger.info({ signature: signatureKey, slot }, "Received live notification");

        if (recentLiveSignatures.has(signatureKey)) {
          logger.info({ signature: signatureKey }, "Skipping duplicate live signature");
          continue;
        }

        recentLiveSignatures.add(signatureKey);
        recentLiveSignatureQueue.push(signatureKey);

        if (recentLiveSignatureQueue.length > maxRecentLiveSignatures) {
          const evictedSignature = recentLiveSignatureQueue.shift();
          if (evictedSignature) {
            recentLiveSignatures.delete(evictedSignature);
          }
        }

        await realtimeDeps.processTransaction(signature, BigInt(slot), runtime, abortSignal);
        logger.info({ signature: signatureKey, slot }, "Processed live signature");
      }
    } catch (error) {
      if (abortSignal.aborted || isAbortError(error)) {
        break;
      }

      logger.error(
        { err: error, programId: programId.toString() },
        "Realtime subscription dropped, restarting",
      );
    }
  }
};
