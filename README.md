# Universal Solana Indexer

Universal Solana Indexer is a production-oriented indexer that adapts to any Anchor IDL, generates a Postgres schema dynamically, decodes program instructions and account state, and exposes a query API for filtered reads, aggregations, and basic program statistics.

The repository was built around the following requirements:

- Dynamic schema generation from Anchor IDL
- Decoding of both instructions and account states
- Batch backfill by slot range, signature range, or explicit signatures
- Realtime indexing with cold start catch-up
- Reliability features such as retries, exponential backoff, and graceful shutdown
- Docker-based local setup
- Structured logging and environment-based configuration

## Features

- Parses an Anchor IDL at startup and derives the target program id from the IDL itself
- Creates instruction tables and account tables automatically from the IDL
- Decodes instruction payloads using Anchor's `BorshCoder`
- Fetches and decodes writable accounts touched by indexed instructions
- Persists per-program checkpoint state in Postgres
- Supports two indexing modes:
  - `realtime`: catch up from the last processed slot, then subscribe to live logs
  - `backfill`: process a slot range, a signature range, or a fixed list of signatures
- Retries RPC operations with exponential backoff
- Uses transactional writes so decoded instructions, decoded accounts, and checkpoint updates commit together
- Exposes HTTP endpoints for:
  - listing decoded instruction rows
  - filtering by common fields and instruction arguments
  - aggregating numeric instruction fields
  - retrieving basic program-level statistics

## Architecture Overview

At a high level the application starts by loading configuration and parsing the Anchor IDL, then synchronizes the database schema with that IDL, and finally runs the API, the indexer, or both depending on configuration.

<img src="static/indexer-schema.png" alt="Indexer architecture" width="320" />

### Main components

- Bootstrap
  - Loads config, parses the IDL, prepares runtime state, ensures schema, and starts the requested runtime mode.
- Dynamic schema layer
  - Builds SQL for instruction and account tables based on the IDL and applies it on startup.
- Indexer core
  - Fetches signatures and transactions, decodes instructions, fetches writable accounts, decodes account snapshots, and writes rows.
- Realtime coordinator
  - Runs cold start catch-up first, then subscribes to live logs, and restarts the subscription loop if it drops.
- Query API
  - Reads the active IDL-derived metadata at runtime and exposes filtered list and aggregation queries.
- State storage
  - Stores the active program setup and the last processed slot in base tables.

## How It Works

### 1. Parse the IDL and build runtime metadata

On startup the application reads the JSON IDL file from `PROGRAM_IDL_PATH`, validates that the IDL includes a program address, and builds:

- the program id
- an Anchor `BorshCoder`
- instruction discriminator lookup
- account discriminator lookup
- a map of user-defined IDL types

This runtime metadata is reused by both the indexer and the API.

### 2. Generate the database schema dynamically

The schema is derived from the IDL:

- Each instruction becomes a table named `ix_<instruction_name>`
- Each account becomes a table named `acct_<account_name>`
- Instruction arguments are mapped to SQL columns
- Account struct fields are mapped to SQL columns
- Complex values such as vectors, arrays, nested structs, and rich enums are stored as `JSONB`
- Large integer types such as `u128` and `i128` are stored as `NUMERIC(39,0)`

Every instruction table also gets base metadata columns:

- `slot`
- `tx_signature`
- `signer`
- `created_at`

Every account table gets:

- `pubkey`
- `slot`
- `updated_at`

Two base tables are always present:

- `program_setups`
  - stores the active program id and IDL
- `program_indexer_state`
  - stores the latest processed slot for each program

If the configured program id changes between runs, the application resets the database and rebuilds the schema for the new IDL.

### 3. Decode and store instructions

For each relevant transaction:

- the indexer fetches the full transaction by signature
- it filters top-level and inner instructions to only those belonging to the configured program
- it decodes instruction data using the Anchor coder
- it inserts decoded instruction rows into the corresponding `ix_*` table

### 4. Decode and store account snapshots

Instruction indexing is paired with account-state indexing:

- the indexer extracts writable accounts referenced by the matching instructions
- it fetches those accounts with `getMultipleAccounts`
- it keeps only accounts owned by the configured program
- it decodes account data using account discriminators plus the Anchor coder
- it inserts decoded snapshots into the matching `acct_*` table

The design stores snapshots, not just the latest state. That makes it easier to inspect how on-chain program state evolved across slots.

### 5. Persist checkpoint state

The indexer stores the latest processed slot in `program_indexer_state`. Instruction rows, account rows, and checkpoint updates are written in the same Postgres transaction, which avoids advancing the checkpoint if the decoded data was not committed successfully.

## Indexing Modes

### Realtime mode

Realtime mode is designed as a cold-start pipeline:

1. Load the last processed slot from Postgres
2. Query the current RPC slot
3. Backfill the gap between those two points
4. Subscribe to program log notifications over WebSocket
5. Process new signatures as they arrive
6. If the live subscription drops, restart the loop and catch up again before resubscribing

This avoids the common gap where an indexer starts listening live before it has filled missed history.

### Backfill mode

Backfill mode supports three strategies:

- Slot range
  - process all matching signatures between `BACKFILL_SLOT_FROM` and `BACKFILL_SLOT_TO`
- Signature range
  - process all matching signatures returned by `getSignaturesForAddress` between `BACKFILL_SIGNATURE_BEFORE` and `BACKFILL_SIGNATURE_UNTIL`
- Explicit signatures
  - process a comma-separated list via `BACKFILL_SIGNATURES`

Backfill mode is useful for one-off historical imports or targeted reprocessing.

## Reliability

### Retry and exponential backoff

RPC calls are wrapped in retry logic with exponential backoff:

- base delay: `250ms`
- max delay: `4000ms`
- max attempts: `5`

This is applied to critical RPC operations such as:

- `getSlot`
- `getSignaturesForAddress`
- `getTransaction`
- `getMultipleAccounts`

### Graceful shutdown

In realtime mode the process listens for `SIGINT` and `SIGTERM`, aborts ongoing work via an `AbortController`, stops the HTTP server, and exits cleanly. Because checkpoint updates are transactional, shutdown does not leave partially committed indexing state behind.

### Duplicate protection during live processing

The realtime loop maintains a recent-signature cache to avoid processing duplicate live notifications from the subscription stream.

## API

The API is built with Hono and serves JSON responses.

### `GET /`

Health check.

Example:

```bash
curl http://localhost:3000/
```

### `GET /api/v1/instructions/:name`

Lists decoded rows for a specific instruction table.

Supported query parameters:

- `limit`
- `order=asc|desc`
- `from_slot`
- `to_slot`
- `signer`
- `tx_signature`
- `arg.<field>=<value>`
- `arg.<field>.gte=<value>`
- `arg.<field>.lte=<value>`

Examples:

```bash
curl "http://localhost:3000/api/v1/instructions/placeOrder"
```

```bash
curl "http://localhost:3000/api/v1/instructions/placeOrder?limit=20&order=asc&from_slot=320000000"
```

```bash
curl "http://localhost:3000/api/v1/instructions/placeOrder?signer=YourSignerPubkeyHere"
```

```bash
curl "http://localhost:3000/api/v1/instructions/placeOrder?arg.market=BTC-PERP&arg.size.gte=1"
```

### `GET /api/v1/instructions/:name/aggregate`

Aggregates rows for a specific instruction.

Supported query parameters:

- `metric=count|sum|avg|min|max`
- `field=<numeric_arg_name>` for `sum`, `avg`, `min`, `max`
- `group_by=signer`
- all filtering parameters supported by the list endpoint

Examples:

```bash
curl "http://localhost:3000/api/v1/instructions/placeOrder/aggregate?metric=count"
```

```bash
curl "http://localhost:3000/api/v1/instructions/placeOrder/aggregate?metric=sum&field=size"
```

```bash
curl "http://localhost:3000/api/v1/instructions/placeOrder/aggregate?metric=count&group_by=signer"
```

```bash
curl "http://localhost:3000/api/v1/instructions/placeOrder/aggregate?metric=avg&field=price&arg.market=BTC-PERP"
```

### `GET /api/v1/stats`

Returns basic program-wide statistics derived from all instruction tables:

- per-instruction counts
- per-instruction unique signer counts
- per-instruction latest indexed slot
- total instruction count
- global unique signer count
- latest indexed slot across the program

Example:

```bash
curl "http://localhost:3000/api/v1/stats"
```

## Configuration

The application is configured entirely through environment variables.

| Variable              | Required    | Description                                                 |
| --------------------- | ----------- | ----------------------------------------------------------- |
| `APP_PORT`            | Yes         | Port for the HTTP API                                       |
| `DATABASE_URL`        | Yes         | Postgres connection string                                  |
| `PROGRAM_IDL_PATH`    | Yes         | Path to the Anchor IDL JSON file                            |
| `RPC_URL`             | Yes         | Solana HTTP RPC endpoint                                    |
| `WS_URL`              | Yes         | Solana WebSocket endpoint                                   |
| `INDEXER_ENABLED`     | Yes         | `true` to run indexing, `false` for API-only mode           |
| `INDEXER_MODE`        | Conditional | `realtime` or `backfill` when `INDEXER_ENABLED=true`        |
| `BACKFILL_SIGNATURE_BEFORE` | Conditional | Newer signature boundary for signature-range backfill |
| `BACKFILL_SIGNATURE_UNTIL` | Conditional | Older signature boundary for signature-range backfill |
| `BACKFILL_SLOT_FROM`  | Conditional | Inclusive lower bound for slot-range backfill configuration |
| `BACKFILL_SLOT_TO`    | Conditional | Inclusive upper bound for slot-range backfill configuration |
| `BACKFILL_SIGNATURES` | Conditional | Comma-separated signatures for targeted backfill            |

### Valid configuration combinations

#### API only

```env
APP_PORT=3000
DATABASE_URL=postgres://postgres:postgres@localhost:5432/indexer
PROGRAM_IDL_PATH=./idl.json
RPC_URL=https://your-rpc-endpoint
WS_URL=wss://your-ws-endpoint
INDEXER_ENABLED=false
```

#### Realtime indexing

```env
APP_PORT=3000
DATABASE_URL=postgres://postgres:postgres@localhost:5432/indexer
PROGRAM_IDL_PATH=./idl.json
RPC_URL=https://your-rpc-endpoint
WS_URL=wss://your-ws-endpoint
INDEXER_ENABLED=true
INDEXER_MODE=realtime
```

#### Backfill by slot range

```env
APP_PORT=3000
DATABASE_URL=postgres://postgres:postgres@localhost:5432/indexer
PROGRAM_IDL_PATH=./idl.json
RPC_URL=https://your-rpc-endpoint
WS_URL=wss://your-ws-endpoint
INDEXER_ENABLED=true
INDEXER_MODE=backfill
BACKFILL_SLOT_FROM=320000000
BACKFILL_SLOT_TO=320100000
```

#### Backfill by signature range

```env
APP_PORT=3000
DATABASE_URL=postgres://postgres:postgres@localhost:5432/indexer
PROGRAM_IDL_PATH=./idl.json
RPC_URL=https://your-rpc-endpoint
WS_URL=wss://your-ws-endpoint
INDEXER_ENABLED=true
INDEXER_MODE=backfill
BACKFILL_SIGNATURE_BEFORE=newerBoundarySignature
BACKFILL_SIGNATURE_UNTIL=olderBoundarySignature
```

#### Backfill by signatures

```env
APP_PORT=3000
DATABASE_URL=postgres://postgres:postgres@localhost:5432/indexer
PROGRAM_IDL_PATH=./idl.json
RPC_URL=https://your-rpc-endpoint
WS_URL=wss://your-ws-endpoint
INDEXER_ENABLED=true
INDEXER_MODE=backfill
BACKFILL_SIGNATURES=sig1,sig2,sig3
```

## Quick Start with Docker Compose

### Prerequisites

- Docker
- Docker Compose
- A Solana RPC provider that exposes both HTTP RPC and WebSocket endpoints

### 1. Create a local env file

The repository does not include an `.env.example`, so create `.env` manually:

```env
APP_PORT=3000
RPC_URL=https://your-rpc-endpoint
WS_URL=wss://your-ws-endpoint
INDEXER_ENABLED=true
INDEXER_MODE=realtime
PROGRAM_IDL_PATH=/app/idl.json
```

`DATABASE_URL` is injected by `docker-compose.yml` and points at the bundled Postgres container.

### 2. Start the stack

```bash
docker compose up --build
```

This starts:

- `postgres`
- `app`

The app container then:

- loads the configured IDL
- creates or updates the schema
- starts the API on `http://localhost:3000`
- starts indexing if `INDEXER_ENABLED=true`

### 3. Use a different IDL

The image already includes both `idl.json` and `dflow-idl.json`. To use the alternative IDL:

```env
PROGRAM_IDL_PATH=/app/dflow-idl.json
```

## Local Development

### Install dependencies

```bash
pnpm install
```

### Run the application

The main entrypoint is:

```bash
pnpm start
```

For development with file watching:

```bash
pnpm dev
```

### Build

```bash
pnpm build
```

### Format

```bash
pnpm fmt
```

## Example Workflows

### Run API only against an existing database

```bash
APP_PORT=3000 \
DATABASE_URL=postgres://postgres:postgres@localhost:5432/indexer \
PROGRAM_IDL_PATH=./idl.json \
RPC_URL=https://your-rpc-endpoint \
WS_URL=wss://your-ws-endpoint \
INDEXER_ENABLED=false \
pnpm start
```

### Run realtime indexing locally

```bash
APP_PORT=3000 \
DATABASE_URL=postgres://postgres:postgres@localhost:5432/indexer \
PROGRAM_IDL_PATH=./idl.json \
RPC_URL=https://your-rpc-endpoint \
WS_URL=wss://your-ws-endpoint \
INDEXER_ENABLED=true \
INDEXER_MODE=realtime \
pnpm start
```

### Run a one-off slot-range backfill

```bash
APP_PORT=3000 \
DATABASE_URL=postgres://postgres:postgres@localhost:5432/indexer \
PROGRAM_IDL_PATH=./idl.json \
RPC_URL=https://your-rpc-endpoint \
WS_URL=wss://your-ws-endpoint \
INDEXER_ENABLED=true \
INDEXER_MODE=backfill \
BACKFILL_SLOT_FROM=320000000 \
BACKFILL_SLOT_TO=320100000 \
pnpm start
```

### Run a targeted signature backfill

```bash
APP_PORT=3000 \
DATABASE_URL=postgres://postgres:postgres@localhost:5432/indexer \
PROGRAM_IDL_PATH=./idl.json \
RPC_URL=https://your-rpc-endpoint \
WS_URL=wss://your-ws-endpoint \
INDEXER_ENABLED=true \
INDEXER_MODE=backfill \
BACKFILL_SIGNATURES=sig1,sig2,sig3 \
pnpm start
```

## Repository Layout

- `src/bootstrap.ts`
  - startup orchestration
- `src/env.ts`
  - environment validation and mode selection
- `src/idl/`
  - IDL parsing, discriminator maps, type mapping
- `src/db/`
  - base tables, dynamic schema generation, dynamic inserts
- `src/indexer/`
  - backfill, realtime loop, core transaction processing, account decoding
- `src/api/`
  - HTTP routes and query service
- `src/solana/`
  - RPC clients and retry policy

## Architectural Decisions and Trade-offs

### Dynamic per-instruction and per-account tables

Each instruction and account gets its own physical table instead of storing everything in a single generic event table. The benefit is a simpler query model and cleaner SQL for API filters and aggregations. The trade-off is that schema changes are tied to the IDL and cross-program reuse is lower.

### Snapshot-based account indexing

The indexer stores decoded account snapshots every time relevant writable accounts are touched. This makes historical inspection straightforward, but it increases storage usage compared with a latest-state-only design.

### Transactional checkpoint updates

Checkpoint state is updated in the same transaction as decoded inserts. This favors consistency and restart safety over maximum ingestion throughput.

### Cold start before live subscription

The realtime path always catches up before listening live. That reduces missed history during startup or subscription reconnects, but it also means the application can spend noticeable time in catch-up before it begins consuming the live stream.

### SQL-first API over a richer query layer

The API intentionally exposes a compact read surface built from the IDL-derived schema. It supports useful filtering and aggregation without introducing a more complex query language. The trade-off is that advanced analytics remain the responsibility of downstream SQL users.

## Testing

The repository includes unit, component, and integration tests under `test/`, covering schema generation, environment parsing, bootstrap behavior, query logic, and indexer modes.
