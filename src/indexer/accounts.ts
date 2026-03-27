import type {
  AccountInfoResponse,
  DecodedAccountSnapshot,
  IndexerRuntime,
  TransactionInstructionWithAccounts,
  TransactionMessageHeader,
} from "@/indexer/types.js";
import { logger } from "@/logger.js";
import { retryWithExponentialBackoff, rpc } from "@/solana/index.js";
import { address, type Address } from "@solana/kit";

const isWritableAccountIndex = ({
  accountIndex,
  loadedWritableCount,
  staticAccountCount,
  header,
}: {
  accountIndex: number;
  loadedWritableCount: number;
  staticAccountCount: number;
  header: TransactionMessageHeader;
}) => {
  if (accountIndex < 0) {
    return false;
  }

  if (accountIndex < staticAccountCount) {
    const signedWritableCount = header.numRequiredSignatures - header.numReadonlySignedAccounts;

    if (accountIndex < header.numRequiredSignatures) {
      return accountIndex < signedWritableCount;
    }

    const unsignedAccountIndex = accountIndex - header.numRequiredSignatures;
    const unsignedAccountCount = staticAccountCount - header.numRequiredSignatures;
    const unsignedWritableCount = unsignedAccountCount - header.numReadonlyUnsignedAccounts;

    return unsignedAccountIndex < unsignedWritableCount;
  }

  const loadedAccountIndex = accountIndex - staticAccountCount;
  return loadedAccountIndex < loadedWritableCount;
};

export const extractWritableAccounts = ({
  accountKeys,
  header,
  instructions,
  loadedWritableCount,
  staticAccountCount,
}: {
  accountKeys: readonly Address[];
  header: TransactionMessageHeader;
  instructions: readonly TransactionInstructionWithAccounts[];
  loadedWritableCount: number;
  staticAccountCount: number;
}) => {
  const writableAccounts = new Set<string>();

  for (const instruction of instructions) {
    for (const accountIndex of instruction.accounts) {
      if (
        !isWritableAccountIndex({
          accountIndex,
          loadedWritableCount,
          staticAccountCount,
          header,
        })
      ) {
        continue;
      }

      const account = accountKeys[accountIndex];

      if (!account) {
        continue;
      }

      writableAccounts.add(account.toString());
    }
  }

  const extractedAccounts = [...writableAccounts].map((pubkey) => address(pubkey));

  logger.info(
    {
      instructionCount: instructions.length,
      writableAccountCount: extractedAccounts.length,
      writableAccounts: extractedAccounts.map((pubkey) => pubkey.toString()),
    },
    "Extracted writable accounts for account indexing",
  );

  return extractedAccounts;
};

const isAccountOwnedByProgram = ({
  accountInfo,
  programId,
}: {
  accountInfo: AccountInfoResponse;
  programId: Address;
}) => accountInfo.owner === programId.toString();

const getAccountDataBuffer = (accountInfo: AccountInfoResponse) => {
  const [encodedData, encoding] = accountInfo.data;

  if (encoding !== "base64") {
    throw new Error(`Unsupported account encoding: ${encoding}`);
  }

  return Buffer.from(encodedData, "base64");
};

export const decodeAccountSnapshot = ({
  accountInfo,
  pubkey,
  runtime,
}: {
  accountInfo: AccountInfoResponse;
  pubkey: Address;
  runtime: IndexerRuntime;
}): DecodedAccountSnapshot | null => {
  const data = getAccountDataBuffer(accountInfo);
  const discriminator = data.subarray(0, 8).toString("hex");
  const accountName = runtime.accountDiscriminatorMap.get(discriminator);

  if (!accountName) {
    return null;
  }

  return {
    data: runtime.coder.accounts.decodeAny(data) as object,
    name: accountName,
    pubkey,
  };
};

export const fetchDecodedWritableAccounts = async ({
  abortSignal,
  pubkeys,
  runtime,
}: {
  abortSignal?: AbortSignal;
  pubkeys: readonly Address[];
  runtime: IndexerRuntime;
}) => {
  if (pubkeys.length === 0) {
    logger.info(
      { programId: runtime.programId.toString() },
      "Skipping account fetch: no writable accounts found",
    );
    return [];
  }

  logger.info(
    {
      accountCount: pubkeys.length,
      programId: runtime.programId.toString(),
      pubkeys: pubkeys.map((pubkey) => pubkey.toString()),
    },
    "Fetching writable accounts for decoding",
  );

  const response = await retryWithExponentialBackoff(
    "getMultipleAccounts",
    () =>
      rpc
        .getMultipleAccounts([...pubkeys], {
          encoding: "base64",
        })
        .send(),
    abortSignal,
  );

  return response.value.flatMap((accountInfo, index) => {
    if (!accountInfo) {
      return [];
    }

    if (!isAccountOwnedByProgram({ accountInfo, programId: runtime.programId })) {
      return [];
    }

    try {
      const decoded = decodeAccountSnapshot({
        accountInfo,
        pubkey: pubkeys[index] as Address,
        runtime,
      });

      if (!decoded) {
        logger.warn(
          {
            owner: accountInfo.owner,
            programId: runtime.programId.toString(),
            pubkey: pubkeys[index]?.toString(),
          },
          "Could not match account discriminator to IDL account",
        );
        return [];
      }

      logger.info(
        {
          accountName: decoded.name,
          programId: runtime.programId.toString(),
          pubkey: decoded.pubkey.toString(),
        },
        "Decoded writable account",
      );

      return [decoded];
    } catch (error) {
      logger.warn(
        {
          err: error,
          owner: accountInfo.owner,
          programId: runtime.programId.toString(),
          pubkey: pubkeys[index]?.toString(),
        },
        "Could not decode account state",
      );
      return [];
    }
  });
};
