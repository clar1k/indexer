import { address, type Address, type Signature } from "@solana/kit";
import { rpc } from "@/solana/index.js";
import { createHash } from "crypto";
import { BorshCoder, type Idl } from "@coral-xyz/anchor";
import { readFileSync } from "fs";
import { buildDiscriminatorMap } from "@/idl/index.js";
import bs58 from "bs58";

const idl = JSON.parse(readFileSync("./idl.json", "utf-8")) as Idl;
const discriminatorMap = buildDiscriminatorMap(idl);
console.log(discriminatorMap);
const programId = address("DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH");
const coder = new BorshCoder(idl);

export const startupIndexerBackfill = async ({ programId }: { programId: Address }) => {
  // TODO: Fix later on actual API responses.
  const latestProcessedSlot = BigInt(408800929);
  const currentSlot = BigInt(408800929 + 2);

  // Get transactions for programId from latest processed slot to the current one
  const signatures = await rpc.getSignaturesForAddress(programId).send();

  const sigs = signatures.slice(0, 1);

  for (const sig of sigs) {
    // const isValidSlot = sig.slot > latestProcessedSlot && sig.slot <= currentSlot;

    // if (!isValidSlot) {
    //   console.log("Invalid slot")
    //   continue;
    // }
    // process transaction
    await processTransaction(sig.signature);
    await saveProcessedSlot(sig.slot);
  }

  // Process transactions and insert them into the database to appropriate tables
  // Track account state also

  // Subscribe to a program updates.
};

const processTransaction = async (signature: Signature) => {
  const response = await rpc
    .getTransaction(signature, {
      encoding: "json",
      maxSupportedTransactionVersion: 0,
    })
    .send();

  if (!response) {
    return;
  }
  const { transaction, meta } = response;
  const staticKeys = transaction.message.accountKeys;
  const writableLoaded = meta?.loadedAddresses?.writable ?? [];
  const readonlyLoaded = meta?.loadedAddresses?.readonly ?? [];
  const accountKeys = [...staticKeys, ...writableLoaded, ...readonlyLoaded];

  const allInstructions = [
    ...transaction.message.instructions,
    ...(meta?.innerInstructions?.flatMap((ix) => ix.instructions) ?? []),
  ];

  const filteredInstructions = allInstructions.filter((ix) => {
    const programAddress = accountKeys[ix.programIdIndex];
    const isValidProgram = programAddress.toString() === programId.toString();
    return isValidProgram;
  });

  for (const ix of filteredInstructions) {
    const decoded = decodeInstruction(ix.data, idl, coder, discriminatorMap);

    if (!decoded) {
      console.log("Could not decode the instruction", ix);
      continue;
    }

    console.log(decoded);
  }
};


const decodeInstruction = (
  dataBase58: string,
  idl: Idl,
  coder: BorshCoder,
  discriminatorMap: Map<string, string>,
) => {
  const buffer = Buffer.from(bs58.decode(dataBase58));
  const discriminator = buffer.slice(0, 8).toString("hex");

  const ixName = discriminatorMap.get(discriminator);

  if (!ixName) {
    return null;
  } // not our program's instruction

  return coder.instruction.decode(buffer); // → { name, data: { ...args } }
};

const saveProcessedSlot = async (slot: bigint) => {};

startupIndexerBackfill({ programId });



type GetTransactionResponse = Awaited<ReturnType<ReturnType<typeof rpc.getTransaction>["send"]>>;
type TransactionWithMeta = Extract<GetTransactionResponse, { meta?: unknown }>;
type InnerInstructions = NonNullable<NonNullable<TransactionWithMeta["meta"]>["innerInstructions"]>;
