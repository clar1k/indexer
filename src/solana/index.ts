import { env } from "@/env.js";
import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  sendAndConfirmTransactionFactory,
} from "@solana/kit";
import { Connection } from "@solana/web3.js";

export const rpc = createSolanaRpc(env.RPC_URL);
const rpcSubscriptions = createSolanaRpcSubscriptions("wss://api.devnet.solana.com");

const sendAndConfirmTransaction = sendAndConfirmTransactionFactory({
  rpc,
  rpcSubscriptions,
});
