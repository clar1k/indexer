import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyBaseEnv } from "../helpers/test-env.js";
import { sampleIdl } from "../helpers/sample-idl.js";

describe("bootstrap smoke", () => {
  it("loads the real bootstrap module with controlled env and reaches the API-only startup path", async () => {
    const tempIdlPath = path.join(os.tmpdir(), `indexer-idl-${Date.now()}.json`);
    fs.writeFileSync(tempIdlPath, JSON.stringify(sampleIdl));
    applyBaseEnv({
      PROGRAM_IDL_PATH: tempIdlPath,
    });

    const ensureBaseTables = vi.fn();
    const ensureDynamicSchema = vi.fn();
    const getStoredProgramSetup = vi.fn().mockResolvedValue(null);
    const upsertProgramSetup = vi.fn();
    const startApiServer = vi.fn(() => ({ close: vi.fn((cb?: () => void) => cb?.()) }));

    vi.doMock("@/db/index.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../src/db/index.js")>();
      return {
        ...actual,
        ensureBaseTables,
        getStoredProgramSetup,
        resetDatabase: vi.fn(),
        upsertProgramSetup,
      };
    });
    vi.doMock("@/db/idl.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../src/db/idl.js")>();
      return {
        ...actual,
        ensureDynamicSchema,
      };
    });
    vi.doMock("@/api/server.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../src/api/server.js")>();
      return {
        ...actual,
        startApiServer,
      };
    });
    vi.doMock("@/indexer/index.js", () => ({
      startIndexer: vi.fn(),
    }));

    vi.resetModules();
    const { bootstrapApplication } = await import("@/bootstrap.js");
    await bootstrapApplication();

    expect(ensureBaseTables).toHaveBeenCalled();
    expect(ensureDynamicSchema).toHaveBeenCalledWith({ idl: sampleIdl });
    expect(upsertProgramSetup).toHaveBeenCalledWith({
      idl: sampleIdl,
      programId: sampleIdl.address,
    });
    expect(startApiServer).toHaveBeenCalledWith({ port: 3000 });
  });
});
