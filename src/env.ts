import * as dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const emptyToUndefined = (value: string | undefined) =>
  value === undefined || value.trim() === "" ? undefined : value;

const parseBoolean = (value: string, fieldName: string) => {
  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new Error(`${fieldName} must be 'true' or 'false'`);
};

const parsePort = (value: string) => {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("APP_PORT must be an integer between 1 and 65535");
  }

  return parsed;
};

const parseBigIntField = (value: string, fieldName: string) => {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${fieldName} must be an unsigned integer`);
  }

  return BigInt(value);
};

const parseSignatureList = (value: string) => {
  const signatures = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (signatures.length === 0) {
    throw new Error("BACKFILL_SIGNATURES must contain at least one signature");
  }

  return [...new Set(signatures)];
};

const rawEnvSchema = z.object({
  APP_PORT: z.string().min(1),
  BACKFILL_SIGNATURES: z.preprocess(emptyToUndefined, z.string().optional()),
  BACKFILL_SLOT_FROM: z.preprocess(emptyToUndefined, z.string().optional()),
  BACKFILL_SLOT_TO: z.preprocess(emptyToUndefined, z.string().optional()),
  DATABASE_URL: z.url(),
  INDEXER_ENABLED: z.string().min(1),
  INDEXER_MODE: z.string().optional(),
  PROGRAM_IDL_PATH: z.string().min(1),
  RPC_URL: z.url(),
  WS_URL: z.url(),
});

export type ApiOnlyConfig = {
  appPort: number;
  databaseUrl: string;
  indexerEnabled: false;
  programIdlPath: string;
  rpcUrl: string;
  wsUrl: string;
};

export type RealtimeConfig = {
  appPort: number;
  databaseUrl: string;
  indexerEnabled: true;
  indexerMode: "realtime";
  programIdlPath: string;
  rpcUrl: string;
  wsUrl: string;
};

export type BackfillConfig = {
  appPort: number;
  backfill:
    | {
        kind: "signatures";
        signatures: string[];
      }
    | {
        kind: "slot-range";
        slotFrom: bigint;
        slotTo: bigint;
      };
  databaseUrl: string;
  indexerEnabled: true;
  indexerMode: "backfill";
  programIdlPath: string;
  rpcUrl: string;
  wsUrl: string;
};

export type AppConfig = ApiOnlyConfig | RealtimeConfig | BackfillConfig;

const buildBaseConfig = (env: z.infer<typeof rawEnvSchema>) => ({
  appPort: parsePort(env.APP_PORT),
  databaseUrl: env.DATABASE_URL,
  programIdlPath: env.PROGRAM_IDL_PATH,
  rpcUrl: env.RPC_URL,
  wsUrl: env.WS_URL,
});

export const loadConfig = (source: NodeJS.ProcessEnv = process.env): AppConfig => {
  const parsed = rawEnvSchema.safeParse(source);

  if (!parsed.success) {
    throw new Error(
      `Invalid environment:\n${parsed.error.issues
        .map((issue) => `- ${issue.path.join(".") || "env"}: ${issue.message}`)
        .join("\n")}`,
    );
  }

  const env = parsed.data;
  const indexerEnabled = parseBoolean(env.INDEXER_ENABLED, "INDEXER_ENABLED");
  const baseConfig = buildBaseConfig(env);

  if (!indexerEnabled) {
    if (
      env.INDEXER_MODE !== undefined ||
      env.BACKFILL_SLOT_FROM !== undefined ||
      env.BACKFILL_SLOT_TO !== undefined ||
      env.BACKFILL_SIGNATURES !== undefined
    ) {
      throw new Error(
        "INDEXER_MODE and BACKFILL_* variables are invalid when INDEXER_ENABLED=false",
      );
    }

    return {
      ...baseConfig,
      indexerEnabled: false,
    };
  }

  if (env.INDEXER_MODE !== "realtime" && env.INDEXER_MODE !== "backfill") {
    throw new Error(
      "INDEXER_MODE must be either 'realtime' or 'backfill' when INDEXER_ENABLED=true",
    );
  }

  if (env.INDEXER_MODE === "realtime") {
    if (
      env.BACKFILL_SLOT_FROM !== undefined ||
      env.BACKFILL_SLOT_TO !== undefined ||
      env.BACKFILL_SIGNATURES !== undefined
    ) {
      throw new Error(
        "BACKFILL_SLOT_FROM, BACKFILL_SLOT_TO, and BACKFILL_SIGNATURES are invalid when INDEXER_MODE=realtime",
      );
    }

    return {
      ...baseConfig,
      indexerEnabled: true,
      indexerMode: "realtime",
    };
  }

  const hasSlotFrom = env.BACKFILL_SLOT_FROM !== undefined;
  const hasSlotTo = env.BACKFILL_SLOT_TO !== undefined;
  const hasSignatures = env.BACKFILL_SIGNATURES !== undefined;

  if (hasSignatures && (hasSlotFrom || hasSlotTo)) {
    throw new Error(
      "BACKFILL_SIGNATURES cannot be combined with BACKFILL_SLOT_FROM or BACKFILL_SLOT_TO",
    );
  }

  if (!hasSignatures && !(hasSlotFrom && hasSlotTo)) {
    throw new Error(
      "INDEXER_MODE=backfill requires either BACKFILL_SIGNATURES or both BACKFILL_SLOT_FROM and BACKFILL_SLOT_TO",
    );
  }

  if (hasSignatures) {
    return {
      ...baseConfig,
      backfill: {
        kind: "signatures",
        signatures: parseSignatureList(env.BACKFILL_SIGNATURES ?? ""),
      },
      indexerEnabled: true,
      indexerMode: "backfill",
    };
  }

  const slotFrom = parseBigIntField(env.BACKFILL_SLOT_FROM ?? "", "BACKFILL_SLOT_FROM");
  const slotTo = parseBigIntField(env.BACKFILL_SLOT_TO ?? "", "BACKFILL_SLOT_TO");

  if (slotFrom > slotTo) {
    throw new Error("BACKFILL_SLOT_FROM must be less than or equal to BACKFILL_SLOT_TO");
  }

  return {
    ...baseConfig,
    backfill: {
      kind: "slot-range",
      slotFrom,
      slotTo,
    },
    indexerEnabled: true,
    indexerMode: "backfill",
  };
};

let configCache: AppConfig | undefined;

export const getConfig = () => {
  configCache ??= loadConfig();
  return configCache;
};
