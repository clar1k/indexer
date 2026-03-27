import { beforeEach, describe, expect, it, vi } from "vitest";

const aggregateInstructionRows = vi.fn();
const getProgramStats = vi.fn();
const isHttpError = vi.fn((error: unknown) => error instanceof Error && "status" in error);
const listInstructionRows = vi.fn();
const logger = {
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};

vi.mock("@/api/queryService.js", () => ({
  aggregateInstructionRows,
  getProgramStats,
  isHttpError,
  listInstructionRows,
}));

vi.mock("@/logger.js", () => ({ logger }));

describe("HTTP API wiring", () => {
  beforeEach(() => {
    vi.resetModules();
    aggregateInstructionRows.mockReset();
    getProgramStats.mockReset();
    listInstructionRows.mockReset();
    logger.error.mockClear();
  });

  it("serves the health route and successful API responses", async () => {
    listInstructionRows.mockResolvedValue({ rows: [{ amount: "1" }] });
    aggregateInstructionRows.mockResolvedValue({ value: "3" });
    getProgramStats.mockResolvedValue({ totalInstructions: "3" });

    const { app } = await import("@/api/server.js");

    expect(await (await app.request("http://localhost/")).json()).toEqual({ ok: true });
    expect(
      await (await app.request("http://localhost/api/v1/instructions/deposit")).json(),
    ).toEqual({
      rows: [{ amount: "1" }],
    });
    expect(
      await (await app.request("http://localhost/api/v1/instructions/deposit/aggregate")).json(),
    ).toEqual({ value: "3" });
    expect(await (await app.request("http://localhost/api/v1/stats")).json()).toEqual({
      totalInstructions: "3",
    });
  });

  it("maps HttpError-like failures and unexpected failures to stable JSON responses", async () => {
    const badRequest = Object.assign(new Error("bad query"), { status: 400 });
    listInstructionRows.mockRejectedValue(badRequest);
    aggregateInstructionRows.mockRejectedValue(new Error("boom"));

    const { app } = await import("@/api/server.js");

    const handled = await app.request("http://localhost/api/v1/instructions/deposit");
    expect(handled.status).toBe(400);
    expect(await handled.json()).toEqual({ error: "bad query" });

    const unhandled = await app.request("http://localhost/api/v1/instructions/deposit/aggregate");
    expect(unhandled.status).toBe(500);
    expect(await unhandled.json()).toEqual({ error: "Internal server error" });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "Unhandled HTTP error",
    );
  });
});
