import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("docker-compose smoke", () => {
  it("declares the expected services and required application config keys", () => {
    const compose = fs.readFileSync(path.resolve("docker-compose.yml"), "utf8");

    expect(compose).toContain("postgres:");
    expect(compose).toContain("app:");
    expect(compose).toContain("DATABASE_URL:");
    expect(compose).toContain("INDEXER_ENABLED:");
    expect(compose).toContain("INDEXER_MODE:");
    expect(compose).toContain("PROGRAM_IDL_PATH:");
    expect(compose).toContain("RPC_URL:");
    expect(compose).toContain("WS_URL:");
  });
});
