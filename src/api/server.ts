import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { zValidator } from "@hono/zod-validator";
import z from "zod";
import {
  aggregateInstructionRows,
  getProgramStats,
  isHttpError,
  listInstructionRows,
} from "@/api/queryService.js";
import { logger } from "@/logger.js";

export const app = new Hono();

app.get("/", (c) => c.json({ ok: true }));

const instructionNameSchema = zValidator("param", z.object({ name: z.string().min(1) }));

app.get("/api/v1/instructions/:name", instructionNameSchema, async (c) => {
  try {
    const { name } = c.req.valid("param");
    const instructions = await listInstructionRows(name, c.req.query());
    return c.json(instructions);
  } catch (error) {
    return handleHttpError(c, error);
  }
});

app.get("/api/v1/instructions/:name/aggregate", instructionNameSchema, async (c) => {
  try {
    const { name } = c.req.valid("param");
    const result = await aggregateInstructionRows(name, c.req.query());
    return c.json(result);
  } catch (error) {
    return handleHttpError(c, error);
  }
});

app.get("/api/v1/stats", async (c) => {
  try {
    const result = await getProgramStats();
    return c.json(result);
  } catch (error) {
    return handleHttpError(c, error);
  }
});

const handleHttpError = (ctx: Context, error: unknown) => {
  if (isHttpError(error)) {
    return ctx.json({ error: error.message }, error.status as ContentfulStatusCode);
  }

  logger.error({ err: error }, "Unhandled HTTP error");
  return ctx.json({ error: "Internal server error" }, 500);
};

export const startApiServer = ({ port }: { port: number }) =>
  serve(
    {
      fetch: app.fetch,
      port,
    },
    (info) => {
      logger.info({ port: info.port }, "API ready");
    },
  );
