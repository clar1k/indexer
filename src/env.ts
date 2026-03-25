import * as dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  DATABASE_URL: z.url(),
  RPC_URL: z.url(),
});

const envParsed = envSchema.safeParse(process.env);

if (envParsed.error) {
  throw envParsed.error;
}

const env = envParsed.data;

export { env };
