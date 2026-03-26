# Test Plan

This repository has no automated tests yet. Based on the scope in [task.md](/Users/clar1k/repos/indexer/task.md), the minimum useful coverage should focus on the production-critical paths below.

## 1. IDL Parsing, Dynamic Schema, and Decoding

These tests map directly to the "dynamic schema and decoding" requirement.

- `src/idl/index.ts`
  - `mapType` maps primitive Anchor types to the expected SQL types.
  - `mapType` marks `option<T>` fields as nullable.
  - `mapType` falls back to `JSONB` for vectors, arrays, structs, unknown defined types, and complex enums.
  - `buildTypesMap` indexes custom types by name.
  - `buildDiscriminatorMap` generates deterministic instruction discriminators.
- `src/db/idl.ts`
  - `buildInstructionTables` creates one table per instruction with base columns and indexes.
  - `buildAccountTables` creates one table per account with base columns and mapped fields.
  - `buildAccountTables` skips tuple fields and non-struct / missing account types safely.
  - `insertInstructionRow` inserts decoded instruction args into the correct columns.
  - value normalization handles bigint / BN-like / pubkey-like / bytes / JSON payloads correctly.
- `src/indexer/core.ts`
  - instruction decoding succeeds for a known discriminator.
  - unknown discriminators are ignored without crashing.

## 2. Backfill and Realtime Indexing Flow

These tests map to the "batch mode" and "real-time mode with cold start" requirements.

- `src/indexer/core.ts`
  - `parseCliOptions` accepts valid realtime and backfill combinations.
  - `parseCliOptions` rejects invalid modes, invalid slots, unknown flags, and mixed `--signatures` with slot range flags.
  - `loadCheckpointAndTip` prefers explicit slot overrides and rejects `slot-from > slot-to`.
  - `getSignaturesToProcess` paginates RPC results, filters by slot bounds, and returns oldest-to-newest order.
  - `processTransaction` extracts only instructions for the target program and updates the last processed slot.
  - `processTransaction` returns `false` when transaction lookup returns `null`.
  - `processTransaction` throws when signer data is missing.
- `src/indexer/backfill.ts`
  - slot-range backfill skips when already up to date.
  - slot-range backfill processes every discovered signature in order.
  - signature-list backfill skips empty input.
  - backfill stops cleanly when aborted.
- `src/indexer/realtime.ts`
  - realtime mode performs cold-start backfill before subscribing.
  - realtime mode processes live notifications after subscription starts.
  - duplicate live signatures are ignored.
  - malformed notifications are skipped.
  - dropped subscriptions restart unless shutdown was requested.

## 3. Reliability and Shutdown

These tests map to the "exponential backoff", "retry mechanism", and "graceful shutdown" requirements.

- `src/solana/index.ts`
  - `retryWithExponentialBackoff` retries failed operations until success.
  - retry delay grows exponentially and caps at the configured maximum.
  - abort errors are not retried.
  - non-abort errors are rethrown after the max attempts.
- `src/indexer/core.ts`
  - abort signals stop long-running signature fetching.
  - abort signals stop transaction processing before side effects.
- `src/indexer/backfill.ts` and `src/indexer/realtime.ts`
  - shutdown leaves loops without continuing extra work after abort.

## 4. API Query Validation, Filtering, Aggregation, and Stats

These tests map to the "advanced API" requirement.

- `src/api/queryService.ts`
  - list query parsing applies default `limit` and `order`.
  - list query parsing rejects invalid `limit`, `order`, and malformed slot filters.
  - argument filters support `eq`, `gte`, and `lte` for numeric fields.
  - scalar filters reject `gte` / `lte`.
  - unknown instruction names return 404.
  - unknown instruction arguments return 400.
  - aggregate queries require a valid metric.
  - `sum`, `avg`, `min`, and `max` require a numeric field.
  - `count` works without a field.
  - grouping by signer returns grouped rows in deterministic order.
  - bigint DB values are normalized to strings in API responses.
  - program stats return per-instruction counts, unique signer counts, total instructions, and latest indexed slot.

## 5. API Surface

These tests cover the exposed HTTP contract in `src/main.ts`.

- `GET /` returns `{ ok: true }`.
- `GET /api/v1/instructions/:name` returns 200 with list payload for valid queries.
- `GET /api/v1/instructions/:name/aggregate` returns 200 with aggregate payload for valid queries.
- `GET /api/v1/stats` returns 200 with stats payload.
- HTTP routes convert `HttpError` failures into the correct status and JSON body.
- unexpected errors return 500 with a stable error response.
