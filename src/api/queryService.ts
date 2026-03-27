import { db } from "@/db/index.js";
import { buildTypesMap, mapType } from "@/idl/index.js";
import type { TypeMap } from "@/idl/index.js";
import { logger } from "@/logger.js";
import { getRuntimeContext } from "@/runtime.js";
import type { IdlInstruction, IdlType } from "@coral-xyz/anchor/dist/cjs/idl.js";
import { sql, type SQL } from "drizzle-orm";
import { toSnakeCase } from "drizzle-orm/casing";

type QueryOrder = "asc" | "desc";
type AggregateMetric = "count" | "sum" | "avg" | "min" | "max";
type FilterOperator = "eq" | "gte" | "lte";

interface InstructionArgMetadata {
  columnName: string;
  fieldName: string;
  filterKind: "numeric" | "scalar" | "unsupported";
  sqlType: string;
}

interface InstructionMetadata {
  args: Map<string, InstructionArgMetadata>;
  name: string;
  tableName: string;
}

interface ParsedFilter {
  column: string;
  operator: FilterOperator;
  value: string;
}

export interface ListInstructionQuery {
  fromSlot?: bigint;
  limit: number;
  order: QueryOrder;
  signer?: string;
  toSlot?: bigint;
  txSignature?: string;
}

export interface AggregateInstructionQuery extends Omit<ListInstructionQuery, "limit" | "order"> {
  field?: string;
  groupBy?: "signer";
  metric: AggregateMetric;
}

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 200;

const getProgramContext = async () => {
  const runtimeContext = getRuntimeContext();
  const setup = {
    idl: runtimeContext.idl,
    programId: runtimeContext.programId,
  };

  const typesMap = buildTypesMap(setup.idl.types ?? []);
  const instructions = new Map<string, InstructionMetadata>();

  for (const instruction of setup.idl.instructions) {
    instructions.set(instruction.name, buildInstructionMetadata(instruction, typesMap));
  }

  return {
    instructions,
    programId: setup.programId,
  };
};

const buildInstructionMetadata = (
  instruction: IdlInstruction,
  typesMap: TypeMap,
): InstructionMetadata => {
  const args = new Map<string, InstructionArgMetadata>();

  for (const arg of instruction.args) {
    const fieldName = arg.name;
    const columnName = toSnakeCase(fieldName);
    const { sqlType } = mapType(arg.type as IdlType, typesMap);

    args.set(fieldName, {
      columnName,
      fieldName,
      filterKind: getFilterKind(sqlType),
      sqlType,
    });
  }

  return {
    args,
    name: instruction.name,
    tableName: `ix_${toSnakeCase(instruction.name)}`,
  };
};

const getFilterKind = (sqlType: string): InstructionArgMetadata["filterKind"] => {
  if (
    sqlType === "SMALLINT" ||
    sqlType === "INTEGER" ||
    sqlType === "BIGINT" ||
    sqlType === "REAL" ||
    sqlType === "DOUBLE PRECISION" ||
    sqlType.startsWith("NUMERIC")
  ) {
    return "numeric";
  }

  if (sqlType === "BOOLEAN" || sqlType === "TEXT" || sqlType.startsWith("VARCHAR")) {
    return "scalar";
  }

  return "unsupported";
};

const requireInstructionMetadata = async (instructionName: string) => {
  const context = await getProgramContext();
  const metadata = context.instructions.get(instructionName);

  if (!metadata) {
    throw new HttpError(404, `Unknown instruction '${instructionName}'`);
  }

  return {
    metadata,
    programId: context.programId,
  };
};

const parseListQuery = (
  query: Record<string, string>,
): {
  filters: ParsedFilter[];
  params: ListInstructionQuery;
} => {
  const limitRaw = query.limit;
  const orderRaw = query.order?.toLowerCase();

  const limit = limitRaw ? Number(limitRaw) : LIST_LIMIT_DEFAULT;

  if (!Number.isInteger(limit) || limit < 1 || limit > LIST_LIMIT_MAX) {
    throw new HttpError(400, `limit must be an integer between 1 and ${LIST_LIMIT_MAX}`);
  }

  if (orderRaw && orderRaw !== "asc" && orderRaw !== "desc") {
    throw new HttpError(400, "order must be 'asc' or 'desc'");
  }

  const filters = parseArgFilters(query);

  return {
    filters,
    params: {
      fromSlot: parseOptionalBigInt(query.from_slot, "from_slot"),
      limit,
      order: (orderRaw as QueryOrder | undefined) ?? "desc",
      signer: query.signer,
      toSlot: parseOptionalBigInt(query.to_slot, "to_slot"),
      txSignature: query.tx_signature,
    },
  };
};

const parseAggregateQuery = (
  query: Record<string, string>,
): {
  filters: ParsedFilter[];
  params: AggregateInstructionQuery;
} => {
  const metricRaw = query.metric?.toLowerCase();
  const groupByRaw = query.group_by;

  if (
    metricRaw !== "count" &&
    metricRaw !== "sum" &&
    metricRaw !== "avg" &&
    metricRaw !== "min" &&
    metricRaw !== "max"
  ) {
    throw new HttpError(400, "metric must be one of count, sum, avg, min, max");
  }

  if (groupByRaw && groupByRaw !== "signer") {
    throw new HttpError(400, "group_by must be 'signer'");
  }

  const filters = parseArgFilters(query);

  return {
    filters,
    params: {
      field: query.field,
      fromSlot: parseOptionalBigInt(query.from_slot, "from_slot"),
      groupBy: groupByRaw as "signer" | undefined,
      metric: metricRaw,
      signer: query.signer,
      toSlot: parseOptionalBigInt(query.to_slot, "to_slot"),
      txSignature: query.tx_signature,
    },
  };
};

const parseArgFilters = (query: Record<string, string>): ParsedFilter[] => {
  const filters: ParsedFilter[] = [];

  for (const [key, value] of Object.entries(query)) {
    if (!key.startsWith("arg.")) {
      continue;
    }

    const suffix = key.slice(4);
    const segments = suffix.split(".");

    if (segments.length === 0 || segments.length > 2 || !segments[0]) {
      throw new HttpError(400, `Invalid filter '${key}'`);
    }

    const [fieldName, operatorRaw] = segments;
    const operator = (operatorRaw ?? "eq") as FilterOperator;

    if (operator !== "eq" && operator !== "gte" && operator !== "lte") {
      throw new HttpError(400, `Unsupported operator '${operator}' for filter '${key}'`);
    }

    filters.push({
      column: fieldName,
      operator,
      value,
    });
  }

  return filters;
};

const parseOptionalBigInt = (value: string | undefined, fieldName: string): bigint | undefined => {
  if (!value) {
    return undefined;
  }

  if (!/^-?\d+$/.test(value)) {
    throw new HttpError(400, `${fieldName} must be a valid integer`);
  }

  return BigInt(value);
};

const buildWhereClauses = (
  instruction: InstructionMetadata,
  params: Pick<ListInstructionQuery, "fromSlot" | "signer" | "toSlot" | "txSignature">,
  argFilters: ParsedFilter[],
): SQL[] => {
  const clauses: SQL[] = [];

  if (params.signer) {
    clauses.push(sql`${sql.identifier("signer")} = ${params.signer}`);
  }

  if (params.txSignature) {
    clauses.push(sql`${sql.identifier("tx_signature")} = ${params.txSignature}`);
  }

  if (params.fromSlot !== undefined) {
    clauses.push(sql`${sql.identifier("slot")} >= ${params.fromSlot.toString()}`);
  }

  if (params.toSlot !== undefined) {
    clauses.push(sql`${sql.identifier("slot")} <= ${params.toSlot.toString()}`);
  }

  for (const filter of argFilters) {
    const arg = instruction.args.get(filter.column);

    if (!arg) {
      throw new HttpError(400, `Unknown instruction argument '${filter.column}'`);
    }

    if (arg.filterKind === "unsupported") {
      throw new HttpError(400, `Filtering is not supported for argument '${filter.column}'`);
    }

    if (arg.filterKind === "scalar" && filter.operator !== "eq") {
      throw new HttpError(
        400,
        `Only equality filters are supported for argument '${filter.column}'`,
      );
    }

    const normalizedValue = normalizeFilterValue(arg, filter.value);
    const column = sql.identifier(arg.columnName);

    if (filter.operator === "eq") {
      clauses.push(sql`${column} = ${normalizedValue}`);
    } else if (filter.operator === "gte") {
      clauses.push(sql`${column} >= ${normalizedValue}`);
    } else {
      clauses.push(sql`${column} <= ${normalizedValue}`);
    }
  }

  return clauses;
};

const normalizeFilterValue = (arg: InstructionArgMetadata, rawValue: string): boolean | string => {
  if (arg.filterKind === "numeric") {
    if (!/^-?\d+(\.\d+)?$/.test(rawValue)) {
      throw new HttpError(400, `Argument '${arg.fieldName}' expects a numeric value`);
    }

    return rawValue;
  }

  if (arg.sqlType === "BOOLEAN") {
    if (rawValue !== "true" && rawValue !== "false") {
      throw new HttpError(400, `Argument '${arg.fieldName}' expects a boolean value`);
    }

    return rawValue === "true";
  }

  return rawValue;
};

const buildWhereSql = (clauses: SQL[]) =>
  clauses.length > 0 ? sql`WHERE ${sql.join(clauses, sql` AND `)}` : sql.empty();

const getMetricColumn = (
  metric: AggregateMetric,
  instruction: InstructionMetadata,
  field?: string,
) => {
  if (metric === "count") {
    return sql`COUNT(*)::text`;
  }

  if (!field) {
    throw new HttpError(400, "field is required for sum, avg, min, and max metrics");
  }

  const arg = instruction.args.get(field);

  if (!arg) {
    throw new HttpError(400, `Unknown instruction argument '${field}'`);
  }

  if (arg.filterKind !== "numeric") {
    throw new HttpError(400, `Metric '${metric}' requires a numeric argument`);
  }

  const column = sql.identifier(arg.columnName);

  if (metric === "sum") {
    return sql`COALESCE(SUM(${column}), 0)::text`;
  }

  if (metric === "avg") {
    return sql`AVG(${column})::text`;
  }

  if (metric === "min") {
    return sql`MIN(${column})::text`;
  }

  return sql`MAX(${column})::text`;
};

const normalizeRows = (rows: Record<string, unknown>[]) =>
  rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        typeof value === "bigint" ? value.toString() : value,
      ]),
    ),
  );

export const listInstructionRows = async (
  instructionName: string,
  query: Record<string, string>,
) => {
  const { metadata, programId } = await requireInstructionMetadata(instructionName);
  const { filters, params } = parseListQuery(query);
  logger.info(
    {
      filterCount: filters.length,
      instruction: metadata.name,
      limit: params.limit,
      order: params.order,
      programId,
    },
    "Listing instruction rows",
  );
  const clauses = buildWhereClauses(metadata, params, filters);
  const orderSql = sql.raw(params.order.toUpperCase());
  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT *
    FROM ${sql.identifier(metadata.tableName)}
    ${buildWhereSql(clauses)}
    ORDER BY ${sql.identifier("slot")} ${orderSql}, ${sql.identifier("indexer_row_id")} ${orderSql}
    LIMIT ${params.limit}
  `);
  logger.info(
    {
      instruction: metadata.name,
      programId,
      rowCount: result.rows.length,
    },
    "Listed instruction rows",
  );

  return {
    instruction: metadata.name,
    programId,
    rows: normalizeRows(result.rows),
  };
};

export const aggregateInstructionRows = async (
  instructionName: string,
  query: Record<string, string>,
) => {
  const { metadata, programId } = await requireInstructionMetadata(instructionName);
  const { filters, params } = parseAggregateQuery(query);
  logger.info(
    {
      field: params.field,
      filterCount: filters.length,
      groupBy: params.groupBy,
      instruction: metadata.name,
      metric: params.metric,
      programId,
    },
    "Aggregating instruction rows",
  );
  const clauses = buildWhereClauses(metadata, params, filters);
  const metricColumn = getMetricColumn(params.metric, metadata, params.field);

  if (params.groupBy === "signer") {
    const grouped = await db.execute<Record<string, unknown>>(sql`
      SELECT
        ${sql.identifier("signer")} AS signer,
        ${metricColumn} AS value
      FROM ${sql.identifier(metadata.tableName)}
      ${buildWhereSql(clauses)}
      GROUP BY ${sql.identifier("signer")}
      ORDER BY value DESC, signer ASC
    `);
    logger.info(
      {
        groupBy: params.groupBy,
        instruction: metadata.name,
        metric: params.metric,
        programId,
        rowCount: grouped.rows.length,
      },
      "Aggregated instruction rows",
    );

    return {
      group_by: params.groupBy,
      instruction: metadata.name,
      metric: params.metric,
      programId,
      rows: normalizeRows(grouped.rows),
    };
  }

  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT ${metricColumn} AS value
    FROM ${sql.identifier(metadata.tableName)}
    ${buildWhereSql(clauses)}
  `);
  logger.info(
    {
      field: params.field,
      instruction: metadata.name,
      metric: params.metric,
      programId,
      value: result.rows[0]?.value ?? null,
    },
    "Aggregated instruction rows",
  );

  return {
    instruction: metadata.name,
    metric: params.metric,
    programId,
    value: normalizeRows(result.rows)[0]?.value ?? null,
  };
};

export const getProgramStats = async () => {
  const context = await getProgramContext();
  logger.info(
    {
      instructionCount: context.instructions.size,
      programId: context.programId,
    },
    "Loading program stats",
  );
  const instructionStats: Array<{
    count: string;
    latestSlot: string | null;
    name: string;
    uniqueSigners: string;
  }> = [];

  for (const instruction of context.instructions.values()) {
    const result = await db.execute<Record<string, unknown>>(sql`
      SELECT
        COUNT(*)::text AS count,
        COUNT(DISTINCT ${sql.identifier("signer")})::text AS unique_signers,
        MAX(${sql.identifier("slot")})::text AS latest_slot
      FROM ${sql.identifier(instruction.tableName)}
    `);

    const row = result.rows[0] ?? {};

    instructionStats.push({
      count: String(row.count ?? "0"),
      latestSlot:
        row.latest_slot === null || row.latest_slot === undefined ? null : String(row.latest_slot),
      name: instruction.name,
      uniqueSigners: String(row.unique_signers ?? "0"),
    });
  }

  const unionStatements = [...context.instructions.values()].map(
    (instruction) => sql`
    SELECT ${sql.identifier("signer")} AS signer
    FROM ${sql.identifier(instruction.tableName)}
  `,
  );

  const globalUniqueSigners =
    unionStatements.length > 0
      ? await db.execute<Record<string, unknown>>(sql`
      SELECT COUNT(DISTINCT signer)::text AS count
      FROM (${sql.join(unionStatements, sql` UNION ALL `)}) AS signers
    `)
      : { rows: [{ count: "0" }] };

  const totalCount = instructionStats.reduce(
    (sum, instruction) => sum + BigInt(instruction.count),
    0n,
  );
  const latestIndexedSlot = instructionStats.reduce<bigint | null>((latest, instruction) => {
    if (!instruction.latestSlot) {
      return latest;
    }

    const current = BigInt(instruction.latestSlot);
    if (latest === null || current > latest) {
      return current;
    }

    return latest;
  }, null);

  logger.info(
    {
      instructionCount: instructionStats.length,
      latestIndexedSlot: latestIndexedSlot?.toString() ?? null,
      programId: context.programId,
      totalInstructions: totalCount.toString(),
      uniqueSigners: String(globalUniqueSigners.rows[0]?.count ?? "0"),
    },
    "Loaded program stats",
  );

  return {
    instructionCounts: instructionStats,
    latestIndexedSlot: latestIndexedSlot?.toString() ?? null,
    programId: context.programId,
    totalInstructions: totalCount.toString(),
    uniqueSigners: String(globalUniqueSigners.rows[0]?.count ?? "0"),
  };
};

export const isHttpError = (error: unknown): error is HttpError => error instanceof HttpError;
