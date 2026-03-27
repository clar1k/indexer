import { beforeEach, describe, expect, it, vi } from "vitest";

const logger = {
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};

vi.mock("@/logger.js", () => ({ logger }));

describe("backfill and realtime loops", () => {
  beforeEach(() => {
    vi.resetModules();
    logger.error.mockClear();
    logger.info.mockClear();
    logger.warn.mockClear();
  });

  it("runs slot-range and signature backfills with clean abort handling", async () => {
    const { backfillDeps, runBackfill } = await import("@/indexer/backfill.js");
    const processed: string[] = [];

    vi.spyOn(backfillDeps, "getSignaturesToProcess").mockResolvedValue([
      { signature: "sig-1", slot: 1n },
      { signature: "sig-2", slot: 2n },
    ] as never);
    vi.spyOn(backfillDeps, "processTransaction").mockImplementation(async (signature) => {
      processed.push(signature.toString());
      return true;
    });

    await runBackfill({
      fromExclusive: 5n,
      programId: { toString: () => "program" } as never,
      runtime: {} as never,
      toInclusive: 5n,
    });
    expect(backfillDeps.getSignaturesToProcess).not.toHaveBeenCalled();

    await runBackfill({
      fromExclusive: 0n,
      programId: { toString: () => "program" } as never,
      runtime: {} as never,
      toInclusive: 2n,
    });
    expect(processed).toEqual(["sig-1", "sig-2"]);

    processed.length = 0;
    await runBackfill({
      programId: { toString: () => "program" } as never,
      runtime: {} as never,
      signatures: [],
    });
    expect(processed).toEqual([]);

    const controller = new AbortController();
    vi.spyOn(backfillDeps, "processTransaction").mockImplementation(async (signature) => {
      processed.push(signature.toString());
      controller.abort();
      return true;
    });
    await runBackfill({
      abortSignal: controller.signal,
      programId: { toString: () => "program" } as never,
      runtime: {} as never,
      signatures: ["sig-a", "sig-b"] as never,
    });
    expect(processed).toEqual(["sig-a"]);
  });

  it("runs realtime cold-start, processes live signatures, dedupes, restarts, and stops on abort", async () => {
    const { realtimeDeps, runRealtime } = await import("@/indexer/realtime.js");
    const processed: string[] = [];
    let subscriptionAttempt = 0;
    const controller = new AbortController();

    vi.spyOn(realtimeDeps, "loadCheckpointAndTip").mockResolvedValue({
      currentSlot: 10n,
      latestProcessedSlot: 5n,
    });
    vi.spyOn(realtimeDeps, "runBackfill").mockResolvedValue(undefined);
    vi.spyOn(realtimeDeps, "processTransaction").mockImplementation(async (signature) => {
      processed.push(signature.toString());
      if (signature.toString() === "sig-2") {
        controller.abort();
      }
      return true;
    });
    vi.spyOn(realtimeDeps, "createLogsSubscription").mockImplementation(async () => {
      subscriptionAttempt += 1;

      if (subscriptionAttempt === 1) {
        throw new Error("socket dropped");
      }

      return (async function* () {
        yield {
          context: { slot: 11n },
          value: { err: null, logs: [], signature: "sig-1" },
        } as never;
        yield {
          context: { slot: 12n },
          value: { err: null, logs: [], signature: "sig-1" },
        } as never;
        yield { context: {}, value: {} } as never;
        yield {
          context: { slot: 13n },
          value: { err: null, logs: [], signature: "sig-2" },
        } as never;
      })();
    });

    await runRealtime({
      abortSignal: controller.signal,
      programId: { toString: () => "program" } as never,
      runtime: {} as never,
    });

    expect(realtimeDeps.runBackfill).toHaveBeenCalledTimes(2);
    expect(processed).toEqual(["sig-1", "sig-2"]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), programId: "program" }),
      "Realtime subscription dropped, restarting",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ notification: expect.any(Object) }),
      "Skipping malformed log notification",
    );
  });
});
