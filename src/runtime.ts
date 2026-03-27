import { buildAccountDiscriminatorMap, buildDiscriminatorMap, buildTypesMap } from "@/idl/index.js";
import type { AppConfig } from "@/env.js";
import type { IndexerRuntime } from "@/indexer/types.js";
import { BorshCoder, type Idl } from "@coral-xyz/anchor";
import { address } from "@solana/kit";

export type AppRuntimeContext = {
  config: AppConfig;
  idl: Idl;
  indexerRuntime: IndexerRuntime;
  programId: string;
};

let runtimeContext: AppRuntimeContext | undefined;

export const buildRuntimeContext = ({
  config,
  idl,
}: {
  config: AppConfig;
  idl: Idl;
}): AppRuntimeContext => {
  const programId = idl.address;

  if (!programId) {
    throw new Error("IDL address is required");
  }

  const programAddress = address(programId);
  const typesMap = buildTypesMap(idl.types ?? []);

  return {
    config,
    idl,
    indexerRuntime: {
      accountDiscriminatorMap: buildAccountDiscriminatorMap(idl),
      coder: new BorshCoder(idl),
      discriminatorMap: buildDiscriminatorMap(idl),
      idl,
      programId: programAddress,
      typesMap,
    },
    programId,
  };
};

export const setRuntimeContext = (nextContext: AppRuntimeContext) => {
  runtimeContext = nextContext;
};

export const getRuntimeContext = () => {
  if (!runtimeContext) {
    throw new Error("Application runtime is not initialized");
  }

  return runtimeContext;
};
