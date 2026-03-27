import { beforeEach, describe, expect, it, vi } from "vitest";

const retryWithExponentialBackoff = vi.fn();
const rpcGetMultipleAccountsSend = vi.fn();
const rpc = {
  getMultipleAccounts: vi.fn(() => ({
    send: rpcGetMultipleAccountsSend,
  })),
};
const logger = {
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};

vi.mock("@/solana/index.js", () => ({
  retryWithExponentialBackoff,
  rpc,
}));

vi.mock("@/logger.js", () => ({ logger }));

describe("account indexing helpers", () => {
  beforeEach(() => {
    retryWithExponentialBackoff.mockReset();
    retryWithExponentialBackoff.mockImplementation(async (_name, op) => op());
    rpc.getMultipleAccounts.mockClear();
    rpcGetMultipleAccountsSend.mockReset();
    logger.info.mockClear();
    logger.warn.mockClear();
  });

  it("extracts only writable accounts referenced by target instructions", async () => {
    const { extractWritableAccounts } = await import("@/indexer/accounts.js");

    const accounts = extractWritableAccounts({
      accountKeys: [
        { toString: () => "11111111111111111111111111111111" },
        { toString: () => "SysvarC1ock11111111111111111111111111111111" },
        { toString: () => "ComputeBudget111111111111111111111111111111" },
        { toString: () => "Vote111111111111111111111111111111111111111" },
        { toString: () => "Stake11111111111111111111111111111111111111" },
        { toString: () => "Config1111111111111111111111111111111111111" },
      ] as never,
      header: {
        numReadonlySignedAccounts: 1,
        numReadonlyUnsignedAccounts: 1,
        numRequiredSignatures: 2,
      },
      instructions: [{ accounts: [0, 1, 2, 3, 4, 5] }, { accounts: [2, 4] }] as never,
      loadedWritableCount: 1,
      staticAccountCount: 4,
    });

    expect(accounts.map((entry) => entry.toString())).toEqual([
      "11111111111111111111111111111111",
      "ComputeBudget111111111111111111111111111111",
      "Stake11111111111111111111111111111111111111",
    ]);
  });

  it("decodes writable accounts and skips foreign owners, unknown discriminators, and bad encodings", async () => {
    const { buildAccountDiscriminatorMap } = await import("@/idl/index.js");
    const { decodeAccountSnapshot, fetchDecodedWritableAccounts } =
      await import("@/indexer/accounts.js");
    const { sampleIdl } = await import("../helpers/sample-idl.js");

    const discriminatorMap = buildAccountDiscriminatorMap(sampleIdl as never);
    const knownDiscriminator = [...discriminatorMap.keys()][0]!;
    const payload = Buffer.concat([Buffer.from(knownDiscriminator, "hex"), Buffer.from([1, 2])]);

    const runtime = {
      accountDiscriminatorMap: discriminatorMap,
      coder: {
        accounts: {
          decodeAny: vi.fn(() => ({ authority: "owner" })),
        },
      },
      programId: { toString: () => sampleIdl.address },
    } as never;

    expect(
      decodeAccountSnapshot({
        accountInfo: {
          data: [payload.toString("base64"), "base64"],
          owner: sampleIdl.address,
        } as never,
        pubkey: { toString: () => "acct-1" } as never,
        runtime,
      }),
    ).toMatchObject({
      name: "VaultAccount",
      pubkey: { toString: expect.any(Function) },
    });

    rpcGetMultipleAccountsSend.mockResolvedValue({
      value: [
        {
          data: [payload.toString("base64"), "base64"],
          owner: sampleIdl.address,
        },
        {
          data: [payload.toString("base64"), "base64"],
          owner: "ForeignProgram1111111111111111111111111111111",
        },
        {
          data: [Buffer.from("0000000000000000", "hex").toString("base64"), "base64"],
          owner: sampleIdl.address,
        },
        {
          data: ["payload", "jsonParsed"],
          owner: sampleIdl.address,
        },
      ],
    });

    const decoded = await fetchDecodedWritableAccounts({
      pubkeys: [
        { toString: () => "acct-1" },
        { toString: () => "acct-foreign" },
        { toString: () => "acct-unknown" },
        { toString: () => "acct-bad" },
      ] as never,
      runtime,
    });

    expect(decoded).toHaveLength(1);
    expect(decoded[0]?.name).toBe("VaultAccount");
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});
