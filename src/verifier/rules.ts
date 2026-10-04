import type { Address } from "viem";
import type {
  CaseRecord,
  DeliveryMeasured,
  DuplicateIntentAssessment,
  DeliveryUnmeasurable,
  JobFailed,
  ObservedFact,
  TenantDebit,
  UpstreamOrder,
  VendorCharge,
} from "../evidence/case.js";
import { canonicalJson } from "../evidence/case.js";

/**
 * The verifier's rules, version 2.
 *
 * These run in the verifier's process, not the agent's. They look only at the
 * observed layer of a case and work out, by themselves, the most that may be
 * paid. The agent never tells the verifier a number; the verifier computes
 * its own ceiling, and the contract refuses anything above it.
 *
 * When the facts do not settle the question, the answer is a refusal to sign,
 * with the reason. A person picks it up from there.
 */

export const RULE_LABEL = "agoranomos-rules-v2";

/**
 * Matching fingerprints within this window identify candidates only.
 * A traceable business-intent assessment must separately confirm each repeat.
 */
export const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

/**
 * A delivered clip is accepted as the length billed when it is at most this
 * much shorter. Encoders round frame boundaries; this is not a discount.
 */
export const DURATION_TOLERANCE_SECONDS = 0.5;

/**
 * Who each counterparty is paid at. Kept by the verifier, not supplied by the
 * agent, so a case cannot redirect money by naming a different address.
 */
export type PayeeRegistry = Record<string, Address>;

export type Verdict =
  | { sign: true; maxMicro: number; payee: Address; basis: string[] }
  | { sign: false; reasons: string[] };

export function judge(record: CaseRecord, registry: PayeeRegistry): Verdict {
  const payee = registry[record.counterparty];
  if (!payee) {
    return { sign: false, reasons: [`no payment address is registered for ${record.counterparty}`] };
  }
  switch (record.kind) {
    case "duplicate_charge_refund":
      return duplicateCharge(record, payee);
    case "pay_undisputed":
      return payUndisputed(record, payee);
    case "tenant_credit_undelivered":
      return tenantCredit(record, payee);
  }
}

function duplicateCharge(record: CaseRecord, payee: Address): Verdict {
  const orders = record.observed.filter((f): f is UpstreamOrder => f.kind === "upstream_order");
  if (orders.some((o) => !positiveSafeAmount(o.chargedMicro))) {
    return { sign: false, reasons: ["an observed order has an invalid charge amount"] };
  }
  if (orders.some((o) => !Number.isSafeInteger(o.submittedAtMs) || o.submittedAtMs < 0)) {
    return { sign: false, reasons: ["an observed order has an invalid submission timestamp"] };
  }
  const byTask = new Map<string, UpstreamOrder>();
  for (const o of orders) {
    const previous = byTask.get(o.taskId);
    if (previous && canonicalJson(previous) !== canonicalJson(o)) {
      return { sign: false, reasons: [`conflicting observations for task ${o.taskId}`] };
    }
    byTask.set(o.taskId, o);
  }
  const assessments = uniqueRows(record.observed.filter((f): f is DuplicateIntentAssessment => f.kind === "duplicate_intent_assessment"));
  if (!assessments) return { sign: false, reasons: ["conflicting duplicate intent assessment rows"] };
  const intentByRepeat = new Map<string, DuplicateIntentAssessment>();
  for (const a of assessments) {
    if (![a.source, a.ref, a.intentId, a.originalTaskId, a.repeatedTaskId].every((v) => typeof v === "string" && v.trim().length > 0)
      || !["confirmed_duplicate", "intentional_regeneration", "unknown"].includes(a.outcome)
      || a.originalTaskId === a.repeatedTaskId
      || !byTask.has(a.originalTaskId) || !byTask.has(a.repeatedTaskId)) {
      return { sign: false, reasons: ["invalid or unbound duplicate intent assessment"] };
    }
    const previous = intentByRepeat.get(a.repeatedTaskId);
    if (previous && (previous.originalTaskId !== a.originalTaskId || previous.intentId !== a.intentId || previous.outcome !== a.outcome)) {
      return { sign: false, reasons: [`conflicting business intent for task ${a.repeatedTaskId}`] };
    }
    intentByRepeat.set(a.repeatedTaskId, a);
  }
  const byFingerprint = new Map<string, UpstreamOrder[]>();
  for (const o of byTask.values()) {
    byFingerprint.set(o.requestFingerprint, [...(byFingerprint.get(o.requestFingerprint) ?? []), o]);
  }

  let maxMicro = 0;
  const basis: string[] = [];
  for (const [fingerprint, group] of byFingerprint) {
    const sorted = [...group].sort((a, b) => a.submittedAtMs - b.submittedAtMs || a.taskId.localeCompare(b.taskId));
    const distinctTasks = new Set(sorted.map((o) => o.taskId));
    if (distinctTasks.size < 2) continue;
    const first = sorted[0];
    for (const later of sorted.slice(1)) {
      if (later.taskId === first.taskId) continue;
      if (later.submittedAtMs - first.submittedAtMs > DUPLICATE_WINDOW_MS) continue;
      const assessment = intentByRepeat.get(later.taskId);
      if (!assessment || assessment.originalTaskId !== first.taskId || assessment.outcome !== "confirmed_duplicate") {
        return { sign: false, reasons: [`business intent for ${later.taskId} repeating ${first.taskId} is not confirmed; matching fingerprints do not prove a duplicate charge`] };
      }
      if (!Number.isSafeInteger(maxMicro + later.chargedMicro)) {
        return { sign: false, reasons: ["duplicate charge sum exceeds the safe integer range"] };
      }
      // Only the explicitly confirmed repeat contributes to the ceiling.
      maxMicro += later.chargedMicro;
      basis.push(`${later.taskId} repeats ${first.taskId} for confirmed intent ${assessment.intentId} (fingerprint ${fingerprint.slice(0, 12)}) and was charged ${later.chargedMicro}`);
    }
  }

  if (maxMicro === 0) {
    return { sign: false, reasons: ["no two distinct orders share a fingerprint inside the window, so there is no observed duplicate"] };
  }
  return { sign: true, maxMicro, payee, basis };
}

function payUndisputed(record: CaseRecord, payee: Address): Verdict {
  const charges = uniqueRows(record.observed.filter((f): f is VendorCharge => f.kind === "vendor_charge"));
  if (!charges) return { sign: false, reasons: ["conflicting vendor charge rows share a source and reference"] };
  if (charges.some((c) => !positiveSafeAmount(c.chargedMicro))) {
    return { sign: false, reasons: ["an observed vendor charge has an invalid amount"] };
  }
  if (charges.some((c) => !Number.isFinite(c.billedSeconds) || c.billedSeconds <= 0)) {
    return { sign: false, reasons: ["an observed vendor charge has an invalid billed duration"] };
  }
  if (new Set(charges.map((c) => c.jobRef)).size !== charges.length) {
    return { sign: false, reasons: ["multiple vendor charges name one job without an explicit multi-charge rule"] };
  }
  const measurements = record.observed.filter((f): f is DeliveryMeasured => f.kind === "delivery_measured");
  if (measurements.some((m) => !Number.isFinite(m.measuredSeconds) || m.measuredSeconds < 0)) {
    return { sign: false, reasons: ["a delivery measurement has an invalid duration"] };
  }
  const measured = new Map<string, DeliveryMeasured>();
  for (const m of measurements) {
    const previous = measured.get(m.jobRef);
    if (previous && canonicalJson(previous) !== canonicalJson(m)) {
      return { sign: false, reasons: [`conflicting delivery measurements for job ${m.jobRef}`] };
    }
    measured.set(m.jobRef, m);
  }
  const unmeasurable = new Set(
    record.observed
      .filter((f): f is DeliveryUnmeasurable => f.kind === "delivery_unmeasurable")
      .map((f) => f.jobRef),
  );
  if ([...measured.keys()].some((jobRef) => unmeasurable.has(jobRef))) {
    return { sign: false, reasons: ["the same delivery is both measured and unmeasurable"] };
  }

  let maxMicro = 0;
  const basis: string[] = [];
  const withheld: string[] = [];
  for (const c of charges) {
    const m = measured.get(c.jobRef);
    if (!m) {
      withheld.push(
        unmeasurable.has(c.jobRef)
          ? `${c.ref}: the delivery could not be measured, so it is neither confirmed nor disputed`
          : `${c.ref}: no delivery on record for this charge`,
      );
      continue;
    }
    if (m.measuredSeconds + DURATION_TOLERANCE_SECONDS < c.billedSeconds) {
      withheld.push(`${c.ref}: billed ${c.billedSeconds}s, delivered ${m.measuredSeconds}s`);
      continue;
    }
    if (!Number.isSafeInteger(maxMicro + c.chargedMicro)) {
      return { sign: false, reasons: ["vendor charge sum exceeds the safe integer range"] };
    }
    maxMicro += c.chargedMicro;
    basis.push(`${c.ref}: billed ${c.billedSeconds}s, delivered ${m.measuredSeconds}s`);
  }

  if (maxMicro === 0) {
    return { sign: false, reasons: withheld.length ? withheld : ["no charges in this case"] };
  }
  return { sign: true, maxMicro, payee, basis: [...basis, ...withheld.map((w) => `withheld ${w}`)] };
}

function tenantCredit(record: CaseRecord, payee: Address): Verdict {
  const debits = uniqueRows(record.observed.filter((f): f is TenantDebit => f.kind === "tenant_debit"));
  if (!debits) return { sign: false, reasons: ["conflicting tenant debit rows share a source and reference"] };
  if (debits.some((d) => !positiveSafeAmount(d.debitedMicro))) {
    return { sign: false, reasons: ["an observed tenant debit has an invalid amount"] };
  }
  const failed = new Set(
    record.observed.filter((f): f is JobFailed => f.kind === "job_failed").map((f) => f.jobRef),
  );

  let maxMicro = 0;
  const basis: string[] = [];
  const notCredited: string[] = [];
  for (const d of debits) {
    if (failed.has(d.jobRef)) {
      if (!Number.isSafeInteger(maxMicro + d.debitedMicro)) {
        return { sign: false, reasons: ["tenant debit sum exceeds the safe integer range"] };
      }
      maxMicro += d.debitedMicro;
      basis.push(`${d.ref}: debited ${d.debitedMicro} for a job recorded as failed`);
    } else {
      notCredited.push(`${d.ref}: the job is not recorded as failed`);
    }
  }

  if (maxMicro === 0) {
    return { sign: false, reasons: notCredited.length ? notCredited : ["no debits in this case"] };
  }
  return { sign: true, maxMicro, payee, basis };
}

function positiveSafeAmount(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/** Repeated ingestion of one raw row is not another charge or debit. */
function uniqueRows<T extends ObservedFact>(rows: T[]): T[] | null {
  const byReference = new Map<string, T>();
  for (const row of rows) {
    const key = JSON.stringify([row.source, row.ref]);
    const previous = byReference.get(key);
    if (previous && canonicalJson(previous) !== canonicalJson(row)) return null;
    byReference.set(key, row);
  }
  return [...byReference.values()];
}
