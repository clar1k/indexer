import { describe, expect, it } from "vitest";
import { loadConfig } from "@/env.js";

describe("loadConfig", () => {
  const baseEnv = {
    APP_PORT: "3000",
    DATABASE_URL: "postgres://postgres:postgres@localhost:5432/indexer_test",
    INDEXER_ENABLED: "false",
    PROGRAM_IDL_PATH: "/tmp/indexer-idl.json",
    RPC_URL: "https://rpc.test",
    WS_URL: "wss://ws.test",
  };

  it("parses api-only mode", () => {
    expect(loadConfig(baseEnv)).toEqual({
      appPort: 3000,
      databaseUrl: baseEnv.DATABASE_URL,
      indexerEnabled: false,
      programIdlPath: baseEnv.PROGRAM_IDL_PATH,
      rpcUrl: baseEnv.RPC_URL,
      wsUrl: baseEnv.WS_URL,
    });
  });

  it("parses realtime and both backfill modes", () => {
    expect(
      loadConfig({
        ...baseEnv,
        INDEXER_ENABLED: "true",
        INDEXER_MODE: "realtime",
      }),
    ).toMatchObject({
      indexerEnabled: true,
      indexerMode: "realtime",
    });

    expect(
      loadConfig({
        ...baseEnv,
        BACKFILL_SLOT_FROM: "10",
        BACKFILL_SLOT_TO: "20",
        INDEXER_ENABLED: "true",
        INDEXER_MODE: "backfill",
      }),
    ).toMatchObject({
      backfill: { kind: "slot-range", slotFrom: 10n, slotTo: 20n },
      indexerEnabled: true,
      indexerMode: "backfill",
    });

    expect(
      loadConfig({
        ...baseEnv,
        BACKFILL_SIGNATURES: "sig-1,sig-2,sig-1",
        INDEXER_ENABLED: "true",
        INDEXER_MODE: "backfill",
      }),
    ).toMatchObject({
      backfill: { kind: "signatures", signatures: ["sig-1", "sig-2"] },
      indexerEnabled: true,
      indexerMode: "backfill",
    });
  });

  it("rejects invalid mode combinations and malformed scalar values", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        INDEXER_ENABLED: "wat",
      }),
    ).toThrow("INDEXER_ENABLED must be 'true' or 'false'");

    expect(() =>
      loadConfig({
        ...baseEnv,
        APP_PORT: "0",
      }),
    ).toThrow("APP_PORT must be an integer between 1 and 65535");

    expect(() =>
      loadConfig({
        ...baseEnv,
        BACKFILL_SLOT_FROM: "1",
      }),
    ).toThrow("INDEXER_MODE and BACKFILL_* variables are invalid when INDEXER_ENABLED=false");

    expect(() =>
      loadConfig({
        ...baseEnv,
        INDEXER_ENABLED: "true",
        INDEXER_MODE: "backfill",
      }),
    ).toThrow(
      "INDEXER_MODE=backfill requires either BACKFILL_SIGNATURES or both BACKFILL_SLOT_FROM and BACKFILL_SLOT_TO",
    );

    expect(() =>
      loadConfig({
        ...baseEnv,
        BACKFILL_SIGNATURES: "sig-1",
        BACKFILL_SLOT_FROM: "1",
        INDEXER_ENABLED: "true",
        INDEXER_MODE: "backfill",
      }),
    ).toThrow("BACKFILL_SIGNATURES cannot be combined with BACKFILL_SLOT_FROM or BACKFILL_SLOT_TO");

    expect(() =>
      loadConfig({
        ...baseEnv,
        BACKFILL_SLOT_FROM: "20",
        BACKFILL_SLOT_TO: "10",
        INDEXER_ENABLED: "true",
        INDEXER_MODE: "backfill",
      }),
    ).toThrow("BACKFILL_SLOT_FROM must be less than or equal to BACKFILL_SLOT_TO");
  });
});
