import { beforeEach, describe, expect, it, vi } from "vitest";
import bs58 from "bs58";

const extractWritableAccounts = vi.fn();
const fetchDecodedWritableAccounts = vi.fn();
const logger = {
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};

vi.mock("@/indexer/accounts.js", () => ({
  extractWritableAccounts,
  fetchDecodedWritableAccounts,
}));

vi.mock("@/logger.js", () => ({ logger }));

describe("indexer core", () => {
  beforeEach(() => {
    vi.resetModules();
    extractWritableAccounts.mockReset();
    fetchDecodedWritableAccounts.mockReset();
    logger.error.mockClear();
    logger.info.mockClear();
    logger.warn.mockClear();
  });

  it("loads checkpoints, paginates signatures, and respects aborts", async () => {
    const { coreDeps, getSignaturesToProcess, loadCheckpointAndTip } =
      await import("@/indexer/core.js");

    vi.spyOn(coreDeps, "getLastProcessedSlot").mockResolvedValue(5n);
    vi.spyOn(coreDeps, "getCurrentSlot").mockResolvedValue(99n);
    vi.spyOn(coreDeps, "retryWithExponentialBackoff").mockImplementation(async (_name, op) => op());

    await expect(
      loadCheckpointAndTip({ toString: () => "program" } as never, {
        slotFrom: 9n,
        slotTo: 1n,
      }),
    ).rejects.toThrow("slot-from (9) must be less than or equal to slot-to (1)");

    expect(
      await loadCheckpointAndTip({ toString: () => "program" } as never, {
        slotFrom: 11n,
        slotTo: 22n,
      }),
    ).toEqual({
      currentSlot: 22n,
      latestProcessedSlot: 11n,
    });

    vi.spyOn(coreDeps, "getSignaturesForAddressPage")
      .mockResolvedValueOnce([
        { signature: "sig-4", slot: 40n },
        { signature: "sig-3", slot: 30n },
      ] as never)
      .mockResolvedValueOnce([
        { signature: "sig-2", slot: 20n },
        { signature: "sig-1", slot: 10n },
      ] as never);

    expect(
      await getSignaturesToProcess({
        currentSlot: 35n,
        latestProcessedSlot: 15n,
        programId: { toString: () => "program" } as never,
      }),
    ).toEqual([
      { signature: "sig-2", slot: 20n },
      { signature: "sig-3", slot: 30n },
    ]);

    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(
      getSignaturesToProcess({
        abortSignal: controller.signal,
        currentSlot: 35n,
        latestProcessedSlot: 15n,
        programId: { toString: () => "program" } as never,
      }),
    ).rejects.toThrow("stop");
  });

  it("decodes only target-program instructions, indexes accounts, and updates checkpoints", async () => {
    const { coreDeps, processTransaction } = await import("@/indexer/core.js");
    const insertedInstructions: string[] = [];
    const insertedAccounts: string[] = [];
    const checkpoints: bigint[] = [];

    vi.spyOn(coreDeps, "retryWithExponentialBackoff").mockImplementation(async (_name, op) => op());
    vi.spyOn(coreDeps, "getTransaction").mockResolvedValue({
      meta: {
        innerInstructions: [
          {
            instructions: [
              {
                accounts: [2],
                data: encodeInstruction("f223c68952e1f2b6"),
                programIdIndex: 1,
              },
            ],
          },
        ],
        loadedAddresses: {
          readonly: [{ toString: () => "OtherProgram" }],
          writable: [{ toString: () => "loaded-writable" }],
        },
      },
      slot: 88,
      transaction: {
        message: {
          accountKeys: [
            { toString: () => "signer-1" },
            { toString: () => "11111111111111111111111111111111" },
            { toString: () => "vault-1" },
          ],
          header: {
            numReadonlySignedAccounts: 0,
            numReadonlyUnsignedAccounts: 1,
            numRequiredSignatures: 1,
          },
          instructions: [
            {
              accounts: [2],
              data: encodeInstruction("f223c68952e1f2b6"),
              programIdIndex: 1,
            },
            {
              accounts: [2],
              data: encodeInstruction("deadbeefdeadbeef"),
              programIdIndex: 1,
            },
            {
              accounts: [2],
              data: encodeInstruction("f223c68952e1f2b6"),
              programIdIndex: 3,
            },
          ],
        },
      },
    } as never);

    vi.spyOn(coreDeps.db, "transaction").mockImplementation(async (callback) =>
      callback({} as never),
    );
    vi.spyOn(coreDeps, "insertInstructionRow").mockImplementation(async ({ instruction }) => {
      insertedInstructions.push(instruction.name);
    });
    vi.spyOn(coreDeps, "insertAccountRow").mockImplementation(async ({ account }) => {
      insertedAccounts.push(account.name);
    });
    vi.spyOn(coreDeps, "upsertLastProcessedSlot").mockImplementation(async ({ slot }) => {
      checkpoints.push(slot);
    });

    extractWritableAccounts.mockReturnValue([{ toString: () => "vault-1" }] as never);
    fetchDecodedWritableAccounts.mockResolvedValue([
      {
        data: { authority: "signer-1" },
        name: "VaultAccount",
        pubkey: { toString: () => "vault-1" },
      },
    ]);

    const runtime = buildRuntime();
    expect(await processTransaction("sig-1" as never, undefined, runtime)).toBe(true);
    expect(insertedInstructions).toEqual(["deposit", "deposit"]);
    expect(insertedAccounts).toEqual(["VaultAccount"]);
    expect(checkpoints).toEqual([88n]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("returns false for missing transactions and avoids checkpoint writes on failures", async () => {
    const { coreDeps, processTransaction } = await import("@/indexer/core.js");
    vi.spyOn(coreDeps, "retryWithExponentialBackoff").mockImplementation(async (_name, op) => op());

    vi.spyOn(coreDeps, "getTransaction").mockResolvedValue(null);
    expect(await processTransaction("sig-null" as never, undefined, buildRuntime())).toBe(false);

    vi.spyOn(coreDeps, "getTransaction").mockResolvedValue({
      meta: {},
      slot: 15,
      transaction: {
        message: {
          accountKeys: [],
          header: {
            numReadonlySignedAccounts: 0,
            numReadonlyUnsignedAccounts: 0,
            numRequiredSignatures: 0,
          },
          instructions: [],
        },
      },
    } as never);
    await expect(
      processTransaction("sig-missing-signer" as never, undefined, buildRuntime()),
    ).rejects.toThrow("Missing signer");

    vi.spyOn(coreDeps, "getTransaction").mockResolvedValue({
      meta: {
        innerInstructions: [],
        loadedAddresses: { readonly: [], writable: [] },
      },
      slot: 22,
      transaction: {
        message: {
          accountKeys: [
            { toString: () => "signer-1" },
            { toString: () => "11111111111111111111111111111111" },
          ],
          header: {
            numReadonlySignedAccounts: 0,
            numReadonlyUnsignedAccounts: 0,
            numRequiredSignatures: 1,
          },
          instructions: [
            {
              accounts: [],
              data: encodeInstruction("f223c68952e1f2b6"),
              programIdIndex: 1,
            },
          ],
        },
      },
    } as never);
    const checkpointSpy = vi
      .spyOn(coreDeps, "upsertLastProcessedSlot")
      .mockResolvedValue(undefined as never);
    vi.spyOn(coreDeps.db, "transaction").mockImplementation(async (callback) =>
      callback({} as never),
    );
    vi.spyOn(coreDeps, "insertInstructionRow").mockRejectedValue(new Error("insert failed"));
    fetchDecodedWritableAccounts.mockResolvedValue([]);
    extractWritableAccounts.mockReturnValue([]);

    await expect(
      processTransaction("sig-fail" as never, undefined, buildRuntime()),
    ).rejects.toThrow("insert failed");
    expect(checkpointSpy).not.toHaveBeenCalled();

    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(
      processTransaction("sig-abort" as never, undefined, buildRuntime(), controller.signal),
    ).rejects.toThrow("stop");
  });
});

const buildRuntime = () =>
  ({
    coder: {
      instruction: {
        decode: (buffer: Buffer) => ({
          data: { marker: buffer[8] ?? 0 },
          name: "deposit",
        }),
      },
    },
    discriminatorMap: new Map([["f223c68952e1f2b6", "deposit"]]),
    idl: {
      address: "11111111111111111111111111111111",
      instructions: [{ accounts: [], args: [], discriminator: [], name: "deposit" }],
      metadata: { name: "sample", spec: "0.1.0", version: "0.1.0" },
    },
    programId: { toString: () => "11111111111111111111111111111111" },
    typesMap: new Map(),
  }) as never;

const encodeInstruction = (discriminatorHex: string) =>
  bs58.encode(Buffer.concat([Buffer.from(discriminatorHex, "hex"), Buffer.from([1])]));
