import type { TypeMap } from "@/idl/index.js";
import { rpc } from "@/solana/index.js";
import type { BorshCoder, Idl } from "@coral-xyz/anchor";
import type { Address, Signature } from "@solana/kit";

type IndexerRpc = typeof rpc;

export type IndexerRuntime = {
  accountDiscriminatorMap: Map<string, string>;
  coder: BorshCoder;
  discriminatorMap: Map<string, string>;
  idl: Idl;
  programId: Address;
  typesMap: TypeMap;
};

export type SlotRangeOptions = {
  slotFrom?: bigint;
  slotTo?: bigint;
};

export type SignatureListOptions = {
  signatures?: Signature[];
};

export type CliOptions = SlotRangeOptions &
  SignatureListOptions & {
    mode: "backfill" | "realtime";
  };

export type CheckpointAndTip = {
  latestProcessedSlot: bigint;
  currentSlot: bigint;
};

export type SignatureWithSlot = Awaited<
  ReturnType<ReturnType<IndexerRpc["getSignaturesForAddress"]>["send"]>
>[number];

export type TransactionResponse = NonNullable<
  Awaited<ReturnType<ReturnType<IndexerRpc["getTransaction"]>["send"]>>
>;

export type TransactionMessageHeader = TransactionResponse["transaction"]["message"]["header"];

export type TransactionInstructionWithAccounts = Pick<
  TransactionResponse["transaction"]["message"]["instructions"][number],
  "accounts"
>;

export type MultipleAccountsResponse = Awaited<
  ReturnType<ReturnType<IndexerRpc["getMultipleAccounts"]>["send"]>
>;

export type AccountInfoResponse = NonNullable<MultipleAccountsResponse["value"][number]>;

export type DecodedAccountSnapshot = {
  data: object;
  name: string;
  pubkey: Address;
};
