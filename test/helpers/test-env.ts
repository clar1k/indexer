import { vi } from "vitest";

const baseEnv = {
  APP_PORT: "3000",
  DATABASE_URL: "postgres://postgres:postgres@localhost:5432/indexer_test",
  INDEXER_ENABLED: "false",
  PROGRAM_IDL_PATH: "/tmp/indexer-test-idl.json",
  RPC_URL: "https://rpc.test",
  WS_URL: "wss://ws.test",
} as const;

export const applyBaseEnv = (
  overrides: Partial<Record<keyof typeof baseEnv | string, string>> = {},
) => {
  for (const [key, value] of Object.entries({ ...baseEnv, ...overrides })) {
    vi.stubEnv(key, value);
  }

  for (const key of [
    "BACKFILL_SIGNATURES",
    "BACKFILL_SLOT_FROM",
    "BACKFILL_SLOT_TO",
    "INDEXER_MODE",
  ]) {
    if (!(key in overrides)) {
      vi.stubEnv(key, "");
      delete process.env[key];
    }
  }
};

applyBaseEnv({});
