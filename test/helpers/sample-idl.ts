import type { Idl } from "@coral-xyz/anchor";

export const sampleIdl = {
  address: "11111111111111111111111111111111",
  metadata: { name: "sample", spec: "0.1.0", version: "0.1.0" },
  instructions: [
    {
      name: "deposit",
      discriminator: [],
      accounts: [],
      args: [
        { name: "amount", type: "u64" },
        { name: "memo", type: "string" },
        { name: "flag", type: "bool" },
        { name: "metadata", type: { defined: { name: "Metadata" } } },
      ],
    },
    {
      name: "withdraw",
      discriminator: [],
      accounts: [],
      args: [{ name: "amount", type: "u64" }],
    },
  ],
  accounts: [
    { name: "VaultAccount", discriminator: [] },
    { name: "TupleAccount", discriminator: [] },
    { name: "EnumAccount", discriminator: [] },
  ],
  types: [
    {
      name: "VaultAccount",
      type: {
        kind: "struct",
        fields: [
          { name: "authority", type: "pubkey" },
          { name: "nickname", type: { option: "string" } },
          { name: "metadata", type: { defined: { name: "Metadata" } } },
        ],
      },
    },
    {
      name: "TupleAccount",
      type: {
        kind: "struct",
        fields: ["u64", "string"],
      },
    },
    {
      name: "EnumAccount",
      type: {
        kind: "enum",
        variants: [{ name: "Only" }],
      },
    },
    {
      name: "Metadata",
      type: {
        kind: "struct",
        fields: [{ name: "level", type: "u64" }],
      },
    },
    {
      name: "EmptyEnum",
      type: {
        kind: "enum",
        variants: [{ name: "A" }, { name: "B" }],
      },
    },
    {
      name: "RichEnum",
      type: {
        kind: "enum",
        variants: [{ name: "A", fields: [{ name: "value", type: "u64" }] }],
      },
    },
  ],
} as const satisfies Idl;

export const sampleProgramSetup = {
  idl: sampleIdl,
  programId: sampleIdl.address,
};
