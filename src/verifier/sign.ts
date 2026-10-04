import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { ATTESTATION_TYPES, attestationDomain, type Attestation } from "../chain/settlement.js";
import { evidenceHash, type CaseRecord } from "../evidence/case.js";
import { judge, RULE_LABEL, type PayeeRegistry } from "./rules.js";

/**
 * The verifier's signing step.
 *
 * This file is the only place that reads the verifier key, and it reads it
 * from its own file. The agent's code never imports this module and never
 * opens that file; a test in tests/run.ts fails the build if it ever does.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

function loadVerifierKey(): Hex {
  const path = process.env.VERIFIER_ENV_FILE ?? join(HERE, "..", "..", ".verifier.env");
  const line = readFileSync(path, "utf8")
    .split("\n")
    .find((l) => l.startsWith("VERIFIER_PRIVATE_KEY="));
  if (!line) throw new Error("the verifier key file has no VERIFIER_PRIVATE_KEY line");
  return line.slice("VERIFIER_PRIVATE_KEY=".length).trim() as Hex;
}

export type SignRequest = {
  record: CaseRecord;
  registry: PayeeRegistry;
  chainId: number;
  contract: Address;
  token: Address;
  ruleVersion: Hex;
  ttlSeconds: number;
  nowSeconds?: number;
};

export type SignedAttestation = {
  attestation: Attestation;
  signature: Hex;
  signer: Address;
  basis: string[];
};

export type SignOutcome = { signed: true; result: SignedAttestation } | { signed: false; reasons: string[] };

export async function signCase(req: SignRequest, key: Hex = loadVerifierKey()): Promise<SignOutcome> {
  const verdict = judge(req.record, req.registry);
  if (!verdict.sign) return { signed: false, reasons: verdict.reasons };

  const account = privateKeyToAccount(key);
  const now = req.nowSeconds ?? Math.floor(Date.now() / 1000);
  const attestation: Attestation = {
    caseId: req.record.caseId,
    payee: verdict.payee,
    token: req.token,
    maxAmount: BigInt(verdict.maxMicro),
    ruleVersion: req.ruleVersion,
    evidenceHash: evidenceHash(req.record, RULE_LABEL),
    expiry: BigInt(now + req.ttlSeconds),
  };

  const signature = await account.signTypedData({
    domain: attestationDomain(req.chainId, req.contract),
    types: ATTESTATION_TYPES,
    primaryType: "Attestation",
    message: attestation,
  });

  return { signed: true, result: { attestation, signature, signer: account.address, basis: verdict.basis } };
}
