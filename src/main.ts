import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import z from "zod";
import { startupIndexerBackfill } from "@/indexer/index.js";

// startupIndexerBackfill();

const app = new Hono();

app.get("/", (c) => c.json({ ok: true }));

const indexSchema = zValidator("param", z.object({ program_id: z.string() }));

app.get("/api/v1/index", indexSchema, (c) => {
  const data = c.req.valid("param");
  // get transaction for program id with limit

  // fetch transaction by slot range
  return c.json({});
});

serve(
  {
    fetch: app.fetch,
    port: 3000,
  },
  (info) => {
    console.log(`Server is running on http://localhost:${info.port}`);
  },
);
