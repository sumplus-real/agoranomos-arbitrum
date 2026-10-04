import { keccak256, toBytes, type Address, type Hex } from "viem";

/**
 * A case is one question about money: should this be paid, refunded, or held,
 * and how much at most. Its evidence is kept in three layers that are never
 * blended, because they deserve different amounts of trust:
 *
 *   observed   facts someone can go and look at: an order id, a charge, a
 *              file whose duration was measured, a job that failed
 *   contract   which term applies and how it was read
 *   inference  estimates with a range, never a single number
 *
 * Only the observed layer can set how much may be paid. Inference can send a
 * case to a person; it can never raise the amount.
 */

export type CaseKind = "duplicate_charge_refund" | "pay_undisputed" | "tenant_credit_undelivered";

/** An upstream order as the supplier recorded it, joined to our own request. */
export type UpstreamOrder = {
  kind: "upstream_order";
  source: string;
  ref: string;
  taskId: string;
  requestFingerprint: string;
  submittedAtMs: number;
  chargedMicro: number;
};

/** Business intent established from a traceable source, never inferred from a hash.
 * Ingestion must authenticate that source before treating this as observed.
 */
export type DuplicateIntentAssessment = {
  kind: "duplicate_intent_assessment";
  source: string;
  ref: string;
  intentId: string;
  originalTaskId: string;
  repeatedTaskId: string;
  outcome: "confirmed_duplicate" | "intentional_regeneration" | "unknown";
};

/** Gateway accounting observation, not an independent supplier invoice. */
export type GatewaySettlement = {
  kind: "gateway_settlement";
  source: string;
  ref: string;
  jobRef: string;
  requestedSeconds: number;
  reportedSeconds: number;
  settledMicro: number;
  originTime: string;
};

/** A line on a supplier's bill for one piece of delivered work. */
export type VendorCharge = {
  kind: "vendor_charge";
  source: string;
  ref: string;
  jobRef: string;
  billedSeconds: number;
  chargedMicro: number;
};

/** A delivered file whose duration we measured ourselves. */
export type DeliveryMeasured = {
  kind: "delivery_measured";
  source: string;
  ref: string;
  jobRef: string;
  measuredSeconds: number;
};

/** A delivery we could not measure. Not zero seconds: unknown. */
export type DeliveryUnmeasurable = {
  kind: "delivery_unmeasurable";
  source: string;
  ref: string;
  jobRef: string;
  reason: string;
};

/** A debit against a tenant's balance for one job. */
export type TenantDebit = {
  kind: "tenant_debit";
  source: string;
  ref: string;
  jobRef: string;
  debitedMicro: number;
};

/** A job the system itself recorded as failed. */
export type JobFailed = {
  kind: "job_failed";
  source: string;
  ref: string;
  jobRef: string;
};

export type ObservedFact =
  | UpstreamOrder
  | DuplicateIntentAssessment
  | GatewaySettlement
  | VendorCharge
  | DeliveryMeasured
  | DeliveryUnmeasurable
  | TenantDebit
  | JobFailed;

export type ContractReading = {
  clause: string;
  reading: string;
};

export type Inference = {
  claim: string;
  lowMicro: number;
  highMicro: number;
  basis: string;
};

export type CaseRecord = {
  caseId: Hex;
  kind: CaseKind;
  /** Who the counterparty is, by the id the verifier knows them under. */
  counterparty: string;
  observed: ObservedFact[];
  contract: ContractReading[];
  inference: Inference[];
};

/**
 * Canonical JSON: keys sorted at every level, no whitespace. The same record
 * always hashes the same, whichever process built it and in whatever order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * What the attestation commits to. The observed facts are sorted by their own
 * canonical form, so two records listing the same facts in a different order
 * are the same evidence.
 */
export function evidenceHash(record: CaseRecord, ruleLabel: string): Hex {
  const facts = record.observed.map(canonicalJson).sort();
  const payload = canonicalJson({
    caseId: record.caseId,
    kind: record.kind,
    counterparty: record.counterparty,
    observed: facts,
    rules: ruleLabel,
  });
  return keccak256(toBytes(payload));
}

export function caseIdFor(parts: string[]): Hex {
  return keccak256(toBytes(parts.join("|")));
}

export type Payee = Address;
