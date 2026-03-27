import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyBaseEnv } from "../helpers/test-env.js";

const sleep = vi.fn();

vi.mock("@solana/kit", () => ({
  createSolanaRpc: vi.fn(() => ({ mocked: "rpc" })),
  createSolanaRpcSubscriptions: vi.fn(() => ({ mocked: "subscriptions" })),
}));

vi.mock("@/logger.js", () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

describe("retryWithExponentialBackoff", () => {
  beforeEach(() => {
    applyBaseEnv({});
    sleep.mockReset();
  });

  it("retries transient failures with capped exponential delays", async () => {
    vi.resetModules();
    const mod = await import("@/solana/index.js");
    vi.spyOn(mod.solanaDeps, "sleep").mockImplementation(sleep);

    let attempt = 0;
    const result = await mod.retryWithExponentialBackoff("rpc-op", async () => {
      attempt += 1;
      if (attempt < 5) {
        throw new Error(`fail-${attempt}`);
      }
      return "ok";
    });

    expect(result).toBe("ok");
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([250, 500, 1000, 2000]);
  });

  it("does not retry abort errors and stops after the max attempts", async () => {
    vi.resetModules();
    const mod = await import("@/solana/index.js");
    vi.spyOn(mod.solanaDeps, "sleep").mockImplementation(sleep);

    const abortError = new Error("This operation was aborted");
    abortError.name = "AbortError";
    await expect(
      mod.retryWithExponentialBackoff("abort", async () => Promise.reject(abortError)),
    ).rejects.toThrow(/aborted/i);
    expect(sleep).not.toHaveBeenCalled();

    let attempt = 0;
    await expect(
      mod.retryWithExponentialBackoff("always-fails", async () => {
        attempt += 1;
        throw new Error("still failing");
      }),
    ).rejects.toThrow("still failing");
    expect(attempt).toBe(mod.retryConfig.RETRY_MAX_ATTEMPTS);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([250, 500, 1000, 2000]);
  });

  it("aborts sleep when the signal is cancelled", async () => {
    vi.resetModules();
    const mod = await import("@/solana/index.js");
    const controller = new AbortController();
    const promise = mod.solanaDeps.sleep(1000, controller.signal);
    controller.abort(new Error("stop"));

    await expect(promise).rejects.toThrow("stop");
  });
});
