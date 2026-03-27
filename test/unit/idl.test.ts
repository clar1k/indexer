import { describe, expect, it, vi } from "vitest";
import { sampleIdl } from "../helpers/sample-idl.js";

vi.mock("@/logger.js", () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

describe("idl helpers", () => {
  it("maps primitive and complex IDL types into SQL column definitions", async () => {
    const { buildTypesMap, mapType } = await import("@/idl/index.js");
    const typesMap = buildTypesMap(sampleIdl.types as never);

    expect(mapType("bool", typesMap)).toEqual({ nullable: false, sqlType: "BOOLEAN" });
    expect(mapType("u128", typesMap)).toEqual({ nullable: false, sqlType: "NUMERIC(39,0)" });
    expect(mapType("pubkey", typesMap)).toEqual({ nullable: false, sqlType: "VARCHAR(44)" });
    expect(mapType("bytes", typesMap)).toEqual({ nullable: false, sqlType: "BYTEA" });
    expect(mapType({ option: "u64" }, typesMap)).toEqual({ nullable: true, sqlType: "BIGINT" });
    expect(mapType({ vec: "u8" }, typesMap)).toEqual({ nullable: false, sqlType: "JSONB" });
    expect(mapType({ array: ["u8", 4] }, typesMap)).toEqual({
      nullable: false,
      sqlType: "JSONB",
    });
    expect(mapType({ defined: { name: "Metadata" } }, typesMap)).toEqual({
      nullable: false,
      sqlType: "JSONB",
    });
    expect(mapType({ defined: { name: "EmptyEnum" } }, typesMap)).toEqual({
      nullable: false,
      sqlType: "TEXT",
    });
    expect(mapType({ defined: { name: "RichEnum" } }, typesMap)).toEqual({
      nullable: false,
      sqlType: "JSONB",
    });
    expect(mapType({ defined: { name: "MissingType" } }, typesMap)).toEqual({
      nullable: false,
      sqlType: "JSONB",
    });
  });

  it("builds type and discriminator maps for instructions and accounts", async () => {
    const { buildAccountDiscriminatorMap, buildDiscriminatorMap, buildTypesMap } =
      await import("@/idl/index.js");

    const typesMap = buildTypesMap(sampleIdl.types as never);
    const instructionMap = buildDiscriminatorMap(sampleIdl as never);
    const accountMap = buildAccountDiscriminatorMap(sampleIdl as never);

    expect(typesMap.get("Metadata")?.name).toBe("Metadata");
    expect(instructionMap.get("f223c68952e1f2b6")).toBe("deposit");
    expect(accountMap.size).toBe(3);
  });
});
