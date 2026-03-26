import test from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";

import {
  coreDeps,
  getSignaturesToProcess,
  loadCheckpointAndTip,
  parseCliOptions,
  processTransaction,
} from "../src/indexer/core.js";
import { backfillDeps, runBackfill } from "../src/indexer/backfill.js";
import { realtimeDeps, runRealtime } from "../src/indexer/realtime.js";

const programId = { toString: () => "Program1111111111111111111111111111111111" } as never;
const runtime = {
  coder: {
    instruction: {
      decode: (buffer: Buffer) => ({
        name: buffer[8] === 1 ? "targetInstruction" : "otherInstruction",
        data: { amount: Number(buffer[8] ?? 0) },
      }),
    },
  },
  discriminatorMap: new Map([
    ["0102030405060708", "targetInstruction"],
    ["0807060504030201", "otherInstruction"],
  ]),
  idl: {
    address: "11111111111111111111111111111111",
    metadata: { name: "sample", version: "0.1.0", spec: "0.1.0" },
    instructions: [
      { name: "targetInstruction", discriminator: [], accounts: [], args: [] },
      { name: "otherInstruction", discriminator: [], accounts: [], args: [] },
    ],
  },
  programId,
  typesMap: new Map(),
} as never;

const encodedIx = (discriminatorHex: string, marker: number) =>
  bs58.encode(Buffer.concat([Buffer.from(discriminatorHex, "hex"), Buffer.from([marker])]));

test("parseCliOptions accepts valid backfill combinations and rejects invalid input", () => {
  assert.deepEqual(parseCliOptions(["--mode", "realtime"]), {
    mode: "realtime",
    signatures: undefined,
    slotFrom: undefined,
    slotTo: undefined,
  });

  assert.deepEqual(
    parseCliOptions(["--mode=backfill", "--slot-from=10", "--slot-to", "25"]),
    {
      mode: "backfill",
      signatures: undefined,
      slotFrom: 10n,
      slotTo: 25n,
    },
  );

  assert.deepEqual(parseCliOptions(["--mode", "backfill", "--signatures", "sig-1,sig-2,sig-1"]), {
    mode: "backfill",
    signatures: ["sig-1", "sig-2"],
    slotFrom: undefined,
    slotTo: undefined,
  });

  assert.throws(() => parseCliOptions(["--mode", "invalid"]), /Invalid --mode value/);
  assert.throws(() => parseCliOptions(["--mode", "backfill", "--slot-from", "abc"]), /Invalid --slot-from value/);
  assert.throws(() => parseCliOptions(["--wat"]), /Unknown argument/);
  assert.throws(
    () => parseCliOptions(["--mode", "backfill", "--signatures", "sig-1", "--slot-from", "1"]),
    /--signatures cannot be combined/,
  );
  assert.throws(
    () => parseCliOptions(["--mode", "realtime", "--slot-from", "1"]),
    /only supported in backfill mode/,
  );
});

test("loadCheckpointAndTip prefers explicit slot overrides and rejects inverted ranges", async (t) => {
  t.mock.method(coreDeps, "getLastProcessedSlot", async () => 5n);
  t.mock.method(coreDeps, "retryWithExponentialBackoff", async (_name: string, operation: () => Promise<number>) => operation());
  t.mock.method(coreDeps, "getCurrentSlot", async () => 99);

  await assert.rejects(
    loadCheckpointAndTip(programId, { slotFrom: 50n, slotTo: 10n }),
    /slot-from \(50\) must be less than or equal to slot-to \(10\)/,
  );

  const result = await loadCheckpointAndTip(programId, { slotFrom: 11n, slotTo: 22n });
  assert.deepEqual(result, {
    currentSlot: 22n,
    latestProcessedSlot: 11n,
  });
});

test("getSignaturesToProcess paginates RPC results, applies slot bounds, and returns oldest-first", async (t) => {
  const pages = new Map<string, Array<{ signature: string; slot: bigint }>>([
    [
      "first",
      [
        { signature: "sig-4", slot: 40n },
        { signature: "sig-3", slot: 30n },
      ],
    ],
    [
      "sig-3",
      [
        { signature: "sig-2", slot: 20n },
        { signature: "sig-1", slot: 10n },
      ],
    ],
  ]);

  t.mock.method(coreDeps, "retryWithExponentialBackoff", async (_name: string, operation: () => Promise<unknown>) => operation());
  t.mock.method(coreDeps, "getSignaturesForAddressPage", async (_programId: unknown, before?: string) => pages.get(before ?? "first") ?? []);

  const signatures = await getSignaturesToProcess({
    currentSlot: 35n,
    latestProcessedSlot: 15n,
    programId,
  });

  assert.deepEqual(signatures, [
    { signature: "sig-2", slot: 20n },
    { signature: "sig-3", slot: 30n },
  ]);
});

test("processTransaction indexes only target-program instructions and advances the checkpoint", async (t) => {
  const inserted: Array<{ name: string; txSignature: string; signer: string; slot: bigint }> = [];
  const checkpoints: bigint[] = [];

  t.mock.method(coreDeps, "retryWithExponentialBackoff", async (_name: string, operation: () => Promise<unknown>) => operation());
  t.mock.method(coreDeps, "getTransaction", async () => ({
    slot: 88,
    meta: {
      innerInstructions: [
        {
          instructions: [
            { data: encodedIx("0102030405060708", 1), programIdIndex: 1 },
            { data: encodedIx("0102030405060708", 1), programIdIndex: 2 },
          ],
        },
      ],
      loadedAddresses: {
        readonly: [{ toString: () => "OtherProgram" }],
        writable: [],
      },
    },
    transaction: {
      message: {
        accountKeys: [
          { toString: () => "Signer11111111111111111111111111111111111" },
          { toString: () => "Program1111111111111111111111111111111111" },
        ],
        instructions: [
          { data: encodedIx("0102030405060708", 1), programIdIndex: 1 },
          { data: encodedIx("0102030405060708", 1), programIdIndex: 2 },
        ],
      },
    },
  }));
  t.mock.method(coreDeps.db, "transaction", async (callback: (tx: object) => Promise<void>) => callback({}));
  t.mock.method(coreDeps, "insertInstructionRow", async (args: { instruction: { name: string }; signer: string; slot: bigint; txSignature: string }) => {
    inserted.push({
      name: args.instruction.name,
      signer: args.signer,
      slot: args.slot,
      txSignature: args.txSignature,
    });
  });
  t.mock.method(coreDeps, "upsertLastProcessedSlot", async ({ slot }: { slot: bigint }) => {
    checkpoints.push(slot);
  });

  const processed = await processTransaction("sig-1" as never, 5n, runtime);
  assert.equal(processed, true);
  assert.deepEqual(inserted, [
    {
      name: "targetInstruction",
      signer: "Signer11111111111111111111111111111111111",
      slot: 88n,
      txSignature: "sig-1",
    },
    {
      name: "targetInstruction",
      signer: "Signer11111111111111111111111111111111111",
      slot: 88n,
      txSignature: "sig-1",
    },
  ]);
  assert.deepEqual(checkpoints, [88n]);
});

test("processTransaction returns false for missing transactions, throws on missing signer, and aborts before side effects", async (t) => {
  t.mock.method(coreDeps, "retryWithExponentialBackoff", async (_name: string, operation: () => Promise<unknown>) => operation());

  t.mock.method(coreDeps, "getTransaction", async () => null);
  assert.equal(await processTransaction("sig-null" as never, undefined, runtime), false);

  t.mock.method(coreDeps, "getTransaction", async () => ({
    slot: 15,
    meta: {},
    transaction: {
      message: {
        accountKeys: [],
        instructions: [],
      },
    },
  }));
  await assert.rejects(processTransaction("sig-missing-signer" as never, undefined, runtime), /Missing signer/);

  const abortController = new AbortController();
  abortController.abort(new Error("stop"));
  const transactionMock = t.mock.method(coreDeps.db, "transaction", async () => undefined as never);
  await assert.rejects(processTransaction("sig-abort" as never, undefined, runtime, abortController.signal), /stop/);
  assert.equal(transactionMock.mock.callCount(), 0);
});

test("runBackfill skips up-to-date ranges and empty signature lists, processes ordered work, and stops on abort", async (t) => {
  const processed: Array<{ signature: string; slot: bigint | undefined }> = [];
  const abortController = new AbortController();

  t.mock.method(backfillDeps, "getSignaturesToProcess", async () => [
    { signature: "sig-1", slot: 11n },
    { signature: "sig-2", slot: 12n },
  ]);
  t.mock.method(backfillDeps, "processTransaction", async (signature: string, slot: bigint | undefined) => {
    processed.push({ signature: signature.toString(), slot });
    if (signature.toString() === "sig-1") {
      abortController.abort();
    }
  });

  await runBackfill({
    fromExclusive: 5n,
    programId,
    runtime,
    toInclusive: 5n,
  });
  assert.deepEqual(processed, []);

  await runBackfill({
    programId,
    runtime,
    signatures: [],
  });
  assert.deepEqual(processed, []);

  await runBackfill({
    abortSignal: abortController.signal,
    fromExclusive: 10n,
    programId,
    runtime,
    toInclusive: 20n,
  });

  assert.deepEqual(processed, [{ signature: "sig-1", slot: 11n }]);
});

test("runRealtime performs cold-start backfill, processes live notifications, skips malformed and duplicate signatures, and restarts dropped subscriptions", async (t) => {
  const processed: Array<{ signature: string; slot: bigint }> = [];
  const backfills: Array<{ fromExclusive: bigint; toInclusive: bigint }> = [];
  const subscribeAttempts: number[] = [];
  const checkpoints = [
    { latestProcessedSlot: 4n, currentSlot: 10n },
    { latestProcessedSlot: 10n, currentSlot: 12n },
  ];
  const abortController = new AbortController();

  t.mock.method(realtimeDeps, "loadCheckpointAndTip", async () => checkpoints.shift() ?? { latestProcessedSlot: 12n, currentSlot: 12n });
  t.mock.method(realtimeDeps, "runBackfill", async ({ fromExclusive, toInclusive }: { fromExclusive: bigint; toInclusive: bigint }) => {
    backfills.push({ fromExclusive, toInclusive });
  });
  t.mock.method(realtimeDeps, "processTransaction", async (signature: string, slot: bigint) => {
    processed.push({ signature: signature.toString(), slot });
  });
  t.mock.method(realtimeDeps, "createLogsSubscription", async () => {
    subscribeAttempts.push(subscribeAttempts.length + 1);

    if (subscribeAttempts.length === 1) {
      throw new Error("socket dropped");
    }

    return (async function* () {
      yield { context: {}, value: {} };
      yield { context: { slot: 11 }, value: { signature: "live-1" } };
      yield { context: { slot: 11 }, value: { signature: "live-1" } };
      abortController.abort();
    })();
  });

  await runRealtime({
    abortSignal: abortController.signal,
    programId,
    runtime,
  });

  assert.deepEqual(backfills, [
    { fromExclusive: 4n, toInclusive: 10n },
    { fromExclusive: 10n, toInclusive: 12n },
  ]);
  assert.deepEqual(processed, [{ signature: "live-1", slot: 11n }]);
  assert.equal(subscribeAttempts.length, 2);
});
