# Universal Solana Indexer

This project builds a Solana program indexer from an Anchor IDL, stores decoded instructions and account snapshots in Postgres, and exposes a small query API.

## Docker Compose

1. Create an env file:

```bash
cp .env.example .env
```

2. Set `RPC_URL` and `WS_URL` to your Solana RPC provider.

3. Start the full stack:

```bash
docker compose up --build
```

That starts:

- `postgres`: the backing database
- `setup`: one-shot schema/bootstrap step using the IDL
- `indexer`: the realtime indexer
- `api`: the HTTP API on `http://localhost:3000`

By default the compose stack uses `/app/idl.json`. To use a different IDL from this repo, override `IDL_PATH` in `.env`, for example:

```bash
IDL_PATH=/app/dflow-idl.json
```

## API

Health check:

```bash
curl http://localhost:3000/
```

List decoded rows for an instruction:

```bash
curl "http://localhost:3000/api/v1/instructions/<instruction_name>"
```

Aggregate instruction rows:

```bash
curl "http://localhost:3000/api/v1/instructions/<instruction_name>/aggregate"
```

Program stats:

```bash
curl "http://localhost:3000/api/v1/stats"
```

## Local Development

If you want to run the pieces outside Docker:

```bash
pnpm install
pnpm start:setup ./idl.json
pnpm start:indexer --mode realtime
pnpm start:api
```
