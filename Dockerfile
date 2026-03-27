FROM node:22-bookworm-slim

WORKDIR /app

RUN corepack enable
RUN corepack prepare pnpm@10.33.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
RUN pnpm install --frozen-lockfile

COPY src ./src
COPY idl.json ./idl.json
COPY dflow-idl.json ./dflow-idl.json

CMD ["pnpm", "start"]
