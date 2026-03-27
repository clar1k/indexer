import { bootstrapApplication } from "@/bootstrap.js";
import { logger } from "@/logger.js";

bootstrapApplication().catch((error) => {
  logger.error({ err: error }, "Application bootstrap failed");
  process.exitCode = 1;
});
