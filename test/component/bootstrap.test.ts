import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyBaseEnv } from "../helpers/test-env.js";
import { sampleIdl } from "../helpers/sample-idl.js";

const logger = {
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};

vi.mock("@/logger.js", () => ({ logger }));

describe("bootstrapApplication", () => {
  beforeEach(() => {
    vi.resetModules();
    applyBaseEnv({});
    logger.error.mockClear();
    logger.info.mockClear();
  });

  it("boots API-only mode and resets the database when the program changes", async () => {
    const ensureBaseTables = vi.fn();
    const ensureDynamicSchema = vi.fn();
    const getStoredProgramSetup = vi
      .fn()
      .mockResolvedValue({ idl: sampleIdl, programId: "old-program" });

    const resetDatabase = vi.fn();

    const upsertProgramSetup = vi.fn();

    const parseIdl = vi.fn(() => sampleIdl);

    const startApiServer = vi.fn(() => ({
      close: vi.fn((cb?: () => void) => cb?.()),
    }));

    const startIndexer = vi.fn();
    const setRuntimeContext = vi.fn();

    vi.doMock("@/db/index.js", () => ({
      ensureBaseTables,
      getStoredProgramSetup,
      resetDatabase,
      upsertProgramSetup,
    }));

    vi.doMock("@/db/idl.js", () => ({
      ensureDynamicSchema,
    }));

    vi.doMock("@/idl/index.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../src/idl/index.js")>();
      return {
        ...actual,
        parseIdl,
      };
    });

    vi.doMock("@/api/server.js", () => ({ startApiServer }));

    vi.doMock("@/indexer/index.js", () => ({
      startIndexer,
    }));
    vi.doMock("@/runtime.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../src/runtime.js")>();
      return {
        ...actual,
        setRuntimeContext,
      };
    });

    const { bootstrapApplication } = await import("../../src/bootstrap.js");
    await bootstrapApplication();

    expect(ensureBaseTables).toHaveBeenCalledTimes(2);
    expect(resetDatabase).toHaveBeenCalledTimes(1);
    expect(ensureDynamicSchema).toHaveBeenCalledWith({ idl: sampleIdl });
    expect(upsertProgramSetup).toHaveBeenCalledWith({
      idl: sampleIdl,
      programId: sampleIdl.address,
    });
    expect(setRuntimeContext).toHaveBeenCalledTimes(1);
    expect(startApiServer).toHaveBeenCalledWith({ port: 3000 });
    expect(startIndexer).not.toHaveBeenCalled();
  });

  it("boots backfill mode without starting the API server", async () => {
    applyBaseEnv({
      INDEXER_ENABLED: "true",
      INDEXER_MODE: "backfill",
      BACKFILL_SLOT_FROM: "1",
      BACKFILL_SLOT_TO: "2",
    });

    const ensureBaseTables = vi.fn();
    const ensureDynamicSchema = vi.fn();
    const getStoredProgramSetup = vi.fn().mockResolvedValue(null);
    const upsertProgramSetup = vi.fn();
    const parseIdl = vi.fn(() => sampleIdl);
    const startApiServer = vi.fn();
    const startIndexer = vi.fn();

    vi.doMock("@/db/index.js", () => ({
      ensureBaseTables,
      getStoredProgramSetup,
      resetDatabase: vi.fn(),
      upsertProgramSetup,
    }));
    vi.doMock("@/db/idl.js", () => ({ ensureDynamicSchema }));
    vi.doMock("@/idl/index.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../src/idl/index.js")>();
      return {
        ...actual,
        parseIdl,
      };
    });
    vi.doMock("@/api/server.js", () => ({ startApiServer }));
    vi.doMock("@/indexer/index.js", () => ({ startIndexer }));

    const { bootstrapApplication } = await import("../../src/bootstrap.js");
    await bootstrapApplication();

    expect(startApiServer).not.toHaveBeenCalled();
    expect(startIndexer).toHaveBeenCalledTimes(1);
  });

  it("boots realtime mode and propagates shutdown to the server and indexer", async () => {
    applyBaseEnv({
      INDEXER_ENABLED: "true",
      INDEXER_MODE: "realtime",
    });

    const ensureBaseTables = vi.fn();
    const ensureDynamicSchema = vi.fn();
    const getStoredProgramSetup = vi.fn().mockResolvedValue(null);
    const upsertProgramSetup = vi.fn();
    const parseIdl = vi.fn(() => sampleIdl);
    const close = vi.fn((cb?: (error?: Error) => void) => cb?.());
    const startApiServer = vi.fn(() => ({ close }));
    const startIndexer = vi.fn(async ({ abortSignal }) => {
      process.emit("SIGINT");
      expect(abortSignal.aborted).toBe(true);
    });

    vi.doMock("@/db/index.js", () => ({
      ensureBaseTables,
      getStoredProgramSetup,
      resetDatabase: vi.fn(),
      upsertProgramSetup,
    }));
    vi.doMock("@/db/idl.js", () => ({ ensureDynamicSchema }));
    vi.doMock("@/idl/index.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../src/idl/index.js")>();
      return {
        ...actual,
        parseIdl,
      };
    });
    vi.doMock("@/api/server.js", () => ({ startApiServer }));
    vi.doMock("@/indexer/index.js", () => ({ startIndexer }));

    const { bootstrapApplication } = await import("../../src/bootstrap.js");
    await bootstrapApplication();

    expect(startApiServer).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ signal: "SIGINT" }),
      "Shutdown requested",
    );
  });
});
