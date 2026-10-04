import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARBITRUM_SEPOLIA, SETTLEMENT_ABI, SETTLEMENT_ADDRESS, type Attestation } from "../chain/settlement.js";

/**
 * The agent's only way to move money: submit an attestation the verifier
 * signed, for an amount no larger than it allows. The agent holds its own key
 * and nothing else. It cannot sign an attestation, change a payee, raise a
 * limit or approve an escalation; the contract refuses all of those from it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

function loadAgentKey(): Hex {
  const path = process.env.AGENT_ENV_FILE ?? join(HERE, "..", "..", ".agent.env");
  const line = readFileSync(path, "utf8")
    .split("\n")
    .find((l) => l.startsWith("AGENT_PRIVATE_KEY="));
  if (!line) throw new Error("the agent key file has no AGENT_PRIVATE_KEY line");
  return line.slice("AGENT_PRIVATE_KEY=".length).trim() as Hex;
}

export type Submission = {
  attestation: Attestation;
  signature: Hex;
  amountMicro: bigint;
  /**
   * Which payment against this case this is. Every payment is one intent and
   * runs once; a retry of the same intent carries the same number and the
   * contract refuses it. The number is part of the intent, so it has to be
   * decided once and kept, not recomputed on retry.
   */
  intentSeq: bigint;
  /** Why the agent chose this amount. Only its hash goes on chain. */
  reasoning: string;
};

export type SubmitOutcome =
  | { status: "settled_or_escalated"; txHash: Hex; blockNumber: bigint }
  | { status: "refused_by_contract"; error: string; args: readonly unknown[] };

export function reasoningHash(reasoning: string): Hex {
  return keccak256(toBytes(reasoning));
}

const publicClient = createPublicClient({ chain: ARBITRUM_SEPOLIA, transport: http() });

/**
 * Ask the chain first. A refusal costs nothing and names its reason, so the
 * agent learns why without paying for a failed transaction.
 */
export async function simulate(s: Submission, from: Address): Promise<SubmitOutcome | null> {
  try {
    await publicClient.simulateContract({
      address: SETTLEMENT_ADDRESS,
      abi: SETTLEMENT_ABI,
      functionName: "settle",
      args: [s.attestation, s.signature, s.amountMicro, s.intentSeq, reasoningHash(s.reasoning)],
      account: from,
    });
    return null;
  } catch (err) {
    if (err instanceof BaseError) {
      const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
      if (revert instanceof ContractFunctionRevertedError) {
        return {
          status: "refused_by_contract",
          error: revert.data?.errorName ?? "unknown",
          args: revert.data?.args ?? [],
        };
      }
    }
    throw err;
  }
}

export async function submit(s: Submission, key: Hex = loadAgentKey()): Promise<SubmitOutcome> {
  const account = privateKeyToAccount(key);
  const refused = await simulate(s, account.address);
  if (refused) return refused;

  const wallet = createWalletClient({ chain: ARBITRUM_SEPOLIA, transport: http(), account });
  const txHash = await wallet.writeContract({
    address: SETTLEMENT_ADDRESS,
    abi: SETTLEMENT_ABI,
    functionName: "settle",
    args: [s.attestation, s.signature, s.amountMicro, s.intentSeq, reasoningHash(s.reasoning)],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`Settlement transaction reverted: ${txHash}`);
  }
  return { status: "settled_or_escalated", txHash, blockNumber: receipt.blockNumber };
}
