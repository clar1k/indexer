import {
  getSignatureRangeToProcess,
  getSignaturesToProcess,
  processTransaction,
} from "@/indexer/core.js";
import type { IndexerRuntime } from "@/indexer/types.js";
import { logger } from "@/logger.js";
import type { Address, Signature } from "@solana/kit";

export const backfillDeps = {
  getSignatureRangeToProcess,
  getSignaturesToProcess,
  processTransaction,
};

type BackfillOptions =
  | {
      abortSignal?: AbortSignal;
      before: Signature;
      programId: Address;
      runtime: IndexerRuntime;
      until: Signature;
      fromExclusive?: never;
      signatures?: never;
      toInclusive?: never;
    }
  | {
      abortSignal?: AbortSignal;
      programId: Address;
      runtime: IndexerRuntime;
      fromExclusive: bigint;
      toInclusive: bigint;
      before?: never;
      signatures?: never;
      until?: never;
    }
  | {
      abortSignal?: AbortSignal;
      programId: Address;
      runtime: IndexerRuntime;
      signatures: readonly Signature[];
      before?: never;
      fromExclusive?: never;
      toInclusive?: never;
      until?: never;
    };

export const runBackfill = async ({ abortSignal, ...options }: BackfillOptions) => {
  const { programId, runtime } = options;

  if (options.signatures !== undefined) {
    const signatures = options.signatures;

    if (signatures.length === 0) {
      logger.info({ programId: programId.toString() }, "Skipping backfill: no signatures provided");
      return;
    }

    logger.info(
      { programId: programId.toString(), signatureCount: signatures.length },
      "Starting signature backfill",
    );

    for (const signature of signatures) {
      if (abortSignal?.aborted) {
        logger.info(
          { programId: programId.toString() },
          "Stopping backfill due to shutdown request",
        );
        break;
      }

      logger.info({ signature: signature.toString() }, "Processing backfill signature");
      await backfillDeps.processTransaction(signature, undefined, runtime, abortSignal);
    }

    logger.info({ programId: programId.toString() }, "Signature backfill finished");
    return;
  }

  if (options.before !== undefined && options.until !== undefined) {
    logger.info(
      {
        before: options.before.toString(),
        programId: programId.toString(),
        until: options.until.toString(),
      },
      "Starting signature-range backfill",
    );

    const signatures = await backfillDeps.getSignatureRangeToProcess({
      abortSignal,
      before: options.before,
      programId,
      until: options.until,
    });

    logger.info(
      { programId: programId.toString(), signatureCount: signatures.length },
      "Found signatures to process for signature-range backfill",
    );

    for (const signatureWithSlot of signatures) {
      if (abortSignal?.aborted) {
        logger.info(
          { programId: programId.toString() },
          "Stopping backfill due to shutdown request",
        );
        break;
      }

      logger.info(
        {
          signature: signatureWithSlot.signature.toString(),
          slot: signatureWithSlot.slot.toString(),
        },
        "Processing backfill signature",
      );
      await backfillDeps.processTransaction(
        signatureWithSlot.signature,
        signatureWithSlot.slot,
        runtime,
        abortSignal,
      );
    }

    logger.info({ programId: programId.toString() }, "Signature-range backfill finished");
    return;
  }

  const { fromExclusive, toInclusive } = options;
  if (fromExclusive >= toInclusive) {
    logger.info(
      {
        fromExclusive: fromExclusive.toString(),
        programId: programId.toString(),
        toInclusive: toInclusive.toString(),
      },
      "Skipping backfill: slot range is already up to date",
    );
    return;
  }

  logger.info(
    {
      fromExclusive: fromExclusive.toString(),
      programId: programId.toString(),
      toInclusive: toInclusive.toString(),
    },
    "Starting backfill",
  );

  const signatures = await backfillDeps.getSignaturesToProcess({
    abortSignal,
    latestProcessedSlot: fromExclusive,
    currentSlot: toInclusive,
    programId,
  });

  logger.info(
    { programId: programId.toString(), signatureCount: signatures.length },
    "Found signatures to process for backfill",
  );

  for (const signatureWithSlot of signatures) {
    if (abortSignal?.aborted) {
      logger.info({ programId: programId.toString() }, "Stopping backfill due to shutdown request");
      break;
    }

    logger.info(
      {
        signature: signatureWithSlot.signature.toString(),
        slot: signatureWithSlot.slot.toString(),
      },
      "Processing backfill signature",
    );
    await backfillDeps.processTransaction(
      signatureWithSlot.signature,
      signatureWithSlot.slot,
      runtime,
      abortSignal,
    );
  }

  logger.info({ programId: programId.toString() }, "Backfill finished");
};
