import { env } from "@/env.js";
import { logger } from "@/logger.js";
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";

const RETRY_BASE_DELAY_MS = 250;
const RETRY_MAX_DELAY_MS = 4_000;
const RETRY_MAX_ATTEMPTS = 5;

export const rpc = createSolanaRpc(env.RPC_URL);
export const rpcSubscriptions = createSolanaRpcSubscriptions(env.WS_URL);

const isAbortError = (error: unknown) =>
  error instanceof Error &&
  (error.name === "AbortError" || error.message === "This operation was aborted");

const throwIfAborted = (abortSignal?: AbortSignal) => {
  if (abortSignal?.aborted) {
    throw abortSignal.reason ?? new Error("Operation aborted");
  }
};

export const solanaDeps = {
  sleep: (ms: number, abortSignal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (abortSignal?.aborted) {
        reject(abortSignal.reason ?? new Error("Operation aborted"));
        return;
      }

      let onAbort: (() => void) | undefined;
      const timer = setTimeout(() => {
        if (onAbort) {
          abortSignal?.removeEventListener("abort", onAbort);
        }
        resolve();
      }, ms);

      onAbort = () => {
        clearTimeout(timer);
        abortSignal?.removeEventListener("abort", onAbort as () => void);
        reject(abortSignal?.reason ?? new Error("Operation aborted"));
      };

      abortSignal?.addEventListener("abort", onAbort, { once: true });
    }),
};

export const retryConfig = {
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_ATTEMPTS,
  RETRY_MAX_DELAY_MS,
};

export const retryWithExponentialBackoff = async <T>(
  operationName: string,
  operation: () => Promise<T>,
  abortSignal?: AbortSignal,
) => {
  let attempt = 0;

  while (true) {
    throwIfAborted(abortSignal);

    try {
      return await operation();
    } catch (error) {
      if (isAbortError(error) || abortSignal?.aborted) {
        throw error;
      }

      attempt += 1;

      if (attempt >= RETRY_MAX_ATTEMPTS) {
        throw error;
      }

      const delayMs = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);

      logger.warn(
        {
          attempt,
          delayMs,
          err: error,
          maxRetries: RETRY_MAX_ATTEMPTS - 1,
          operationName,
        },
        "RPC call failed, retrying",
      );
      await solanaDeps.sleep(delayMs, abortSignal);
    }
  }
};
