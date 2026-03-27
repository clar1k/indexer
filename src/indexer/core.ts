import { insertAccountRow, insertInstructionRow } from "@/db/idl.js";
import { db, getLastProcessedSlot, upsertLastProcessedSlot } from "@/db/index.js";
import { extractWritableAccounts, fetchDecodedWritableAccounts } from "@/indexer/accounts.js";
import {
  type CheckpointAndTip,
  type IndexerRuntime,
  type SignatureWithSlot,
  type SlotRangeOptions,
} from "@/indexer/types.js";
import { logger } from "@/logger.js";
import { retryWithExponentialBackoff, rpc } from "@/solana/index.js";
import { BorshCoder } from "@coral-xyz/anchor";
import { address, type Address, type Signature } from "@solana/kit";
import bs58 from "bs58";
import { toSnakeCase } from "drizzle-orm/casing";

const throwIfAborted = (abortSignal?: AbortSignal) => {
  if (abortSignal?.aborted) {
    throw abortSignal.reason ?? new Error("Operation aborted");
  }
};

export const coreDeps = {
  db,
  getCurrentSlot: () => rpc.getSlot().send(),
  getLastProcessedSlot,
  getSignaturesForAddressPage: (programId: Address, before?: Signature) =>
    rpc.getSignaturesForAddress(programId, before ? { before } : undefined).send(),
  getTransaction: (signature: Signature) =>
    rpc
      .getTransaction(signature, {
        encoding: "json",
        maxSupportedTransactionVersion: 0,
      })
      .send(),
  insertAccountRow,
  insertInstructionRow,
  retryWithExponentialBackoff,
  upsertLastProcessedSlot,
};

export const loadCheckpointAndTip = async (
  programId: Address,
  { slotFrom, slotTo }: SlotRangeOptions = {},
  abortSignal?: AbortSignal,
): Promise<CheckpointAndTip> => {
  throwIfAborted(abortSignal);

  const [storedLatestProcessedSlot, currentRpcSlot] = await Promise.all([
    coreDeps.getLastProcessedSlot(programId.toString()),
    coreDeps.retryWithExponentialBackoff("getSlot", () => coreDeps.getCurrentSlot(), abortSignal),
  ]);

  const latestProcessedSlot = slotFrom ?? storedLatestProcessedSlot ?? 0n;
  const currentSlot = slotTo ?? BigInt(currentRpcSlot);

  if (latestProcessedSlot > currentSlot) {
    throw new Error(
      `Invalid slot range: slot-from (${latestProcessedSlot}) must be less than or equal to slot-to (${currentSlot})`,
    );
  }

  return {
    currentSlot,
    latestProcessedSlot,
  };
};

export const getSignaturesToProcess = async ({
  abortSignal,
  currentSlot,
  latestProcessedSlot,
  programId,
}: {
  abortSignal?: AbortSignal;
  currentSlot: bigint;
  latestProcessedSlot: bigint;
  programId: Address;
}) => {
  const signatures: SignatureWithSlot[] = [];
  let before: Signature | undefined;

  while (true) {
    throwIfAborted(abortSignal);

    const page = await coreDeps.retryWithExponentialBackoff(
      "getSignaturesForAddress",
      () => coreDeps.getSignaturesForAddressPage(programId, before),
      abortSignal,
    );

    if (page.length === 0) {
      break;
    }

    const filteredPage = page.filter(
      (signatureWithSlot) =>
        signatureWithSlot.slot > latestProcessedSlot && signatureWithSlot.slot <= currentSlot,
    );
    signatures.push(...filteredPage);

    const oldestSlotInPage = page[page.length - 1]?.slot;

    if (!oldestSlotInPage || oldestSlotInPage <= latestProcessedSlot) {
      break;
    }

    before = page[page.length - 1]?.signature;
  }

  return signatures.reverse();
};

export const processTransaction = async (
  signature: Signature,
  slot: bigint | undefined,
  runtime: IndexerRuntime,
  abortSignal?: AbortSignal,
) => {
  throwIfAborted(abortSignal);

  const response = await coreDeps.retryWithExponentialBackoff(
    "getTransaction",
    () => coreDeps.getTransaction(signature),
    abortSignal,
  );

  if (!response) {
    return false;
  }

  const { transaction, meta } = response;
  const processedSlot = BigInt(response.slot);
  const signer = transaction.message.accountKeys[0]?.toString();

  if (!signer) {
    throw new Error(`Missing signer for transaction ${signature}`);
  }

  const staticKeys = transaction.message.accountKeys;
  const writableLoaded = meta?.loadedAddresses?.writable ?? [];
  const readonlyLoaded = meta?.loadedAddresses?.readonly ?? [];
  const accountKeys = [...staticKeys, ...writableLoaded, ...readonlyLoaded];

  const allInstructions = [
    ...transaction.message.instructions,
    ...(meta?.innerInstructions?.flatMap((instructionGroup) => instructionGroup.instructions) ??
      []),
  ];

  const filteredInstructions = allInstructions.filter((instruction) => {
    const programAddress = accountKeys[instruction.programIdIndex];
    return programAddress?.toString() === runtime.programId.toString();
  });

  logger.info(
    {
      instructionCount: filteredInstructions.length,
      programId: runtime.programId.toString(),
      signature: signature.toString(),
      slot: processedSlot.toString(),
    },
    "Processing transaction instructions for account indexing",
  );

  const writableAccounts = extractWritableAccounts({
    accountKeys,
    header: transaction.message.header,
    instructions: filteredInstructions,
    loadedWritableCount: writableLoaded.length,
    staticAccountCount: staticKeys.length,
  });

  const decodedAccounts = await fetchDecodedWritableAccounts({
    abortSignal,
    pubkeys: writableAccounts,
    runtime,
  });

  logger.info(
    {
      decodedAccountCount: decodedAccounts.length,
      programId: runtime.programId.toString(),
      signature: signature.toString(),
      slot: processedSlot.toString(),
    },
    "Decoded accounts ready for insertion",
  );

  logger.info(
    {
      decodedAccountCount: decodedAccounts.length,
      instructionCount: filteredInstructions.length,
      programId: runtime.programId.toString(),
      signature: signature.toString(),
      slot: processedSlot.toString(),
    },
    "Starting transaction for decoded instruction and account insertion",
  );

  try {
    await coreDeps.db.transaction(async (tx) => {
      for (const instruction of filteredInstructions) {
        const decoded = decodeInstruction(
          instruction.data,
          runtime.coder,
          runtime.discriminatorMap,
        );

        if (!decoded) {
          logger.warn(
            {
              instruction,
              programId: runtime.programId.toString(),
              signature: signature.toString(),
              slot: processedSlot.toString(),
            },
            "Could not decode the instruction",
          );
          continue;
        }

        await coreDeps.insertInstructionRow({
          executor: tx,
          idl: runtime.idl,
          typesMap: runtime.typesMap,
          instruction: decoded,
          slot: processedSlot,
          txSignature: signature,
          signer,
        });
      }

      logger.info(
        {
          decodedAccountCount: decodedAccounts.length,
          programId: runtime.programId.toString(),
          signature: signature.toString(),
          slot: processedSlot.toString(),
        },
        "Finished instruction inserts, starting account inserts",
      );

      for (const decodedAccount of decodedAccounts) {
        const tableName = `acct_${toSnakeCase(decodedAccount.name)}`;

        logger.info(
          {
            accountName: decodedAccount.name,
            programId: runtime.programId.toString(),
            pubkey: decodedAccount.pubkey.toString(),
            signature: signature.toString(),
            slot: processedSlot.toString(),
            tableName,
          },
          "Inserting decoded account row",
        );

        await coreDeps.insertAccountRow({
          account: {
            data: decodedAccount.data,
            name: decodedAccount.name,
            pubkey: decodedAccount.pubkey.toString(),
          },
          executor: tx,
          idl: runtime.idl,
          slot: processedSlot,
          typesMap: runtime.typesMap,
        });
      }

      logger.info(
        {
          programId: runtime.programId.toString(),
          signature: signature.toString(),
          slot: processedSlot.toString(),
        },
        "Finished account inserts, updating last processed slot",
      );

      await coreDeps.upsertLastProcessedSlot({
        executor: tx,
        programId: runtime.programId.toString(),
        slot: processedSlot,
      });
    });
  } catch (error) {
    logger.error(
      {
        decodedAccountCount: decodedAccounts.length,
        err: error,
        instructionCount: filteredInstructions.length,
        programId: runtime.programId.toString(),
        signature: signature.toString(),
        slot: processedSlot.toString(),
      },
      "Transaction failed while inserting decoded instructions/accounts",
    );
    throw error;
  }

  logger.info(
    {
      decodedAccountCount: decodedAccounts.length,
      instructionCount: filteredInstructions.length,
      programId: runtime.programId.toString(),
      signature: signature.toString(),
      slot: processedSlot.toString(),
    },
    "Transaction committed for decoded instruction and account insertion",
  );

  return true;
};

export const decodeInstruction = (
  dataBase58: string,
  coder: BorshCoder,
  discriminatorMap: Map<string, string>,
) => {
  const buffer = Buffer.from(bs58.decode(dataBase58));
  const discriminator = buffer.slice(0, 8).toString("hex");
  const ixName = discriminatorMap.get(discriminator);

  if (!ixName) {
    return null;
  }

  return coder.instruction.decode(buffer);
};
