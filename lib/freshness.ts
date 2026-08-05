// The SHARED freshness vocabulary (issues #2023 / #2025). PURE — no DB, no network.
//
// "Is this dated reading still current?" is ONE question, asked by several domains over
// different clocks: a biomarker against its curated retest cadence, a fitness-battery test
// against its declared freshness policy, a body-composition value against the profile's
// check cadence. Before this module each asked it locally (`age > cadenceDays` inline in
// the fitness model, `daysBetween(...) > retestIntervalDays(...)` in the biomarker retest
// classifier), so the boundary condition, the "no clock applies here" case, and the
// counting vocabulary were re-derived per surface and free to drift.
//
// This module owns the DECISION and the COUNTING VOCABULARY only. Each domain keeps what
// is genuinely its own: which interval applies (a curated retest cadence, a per-test
// policy) and which readings are EXEMPT from having a clock at all (genomics, immutable
// attributes, durable immunity, QC metrics — all biomarker grammar, none of it belongs
// here). Domains adapt onto this; they do not fork it (the #221 one-question-one-
// computation rule, and the cadence-ledger tenancy shape one level down).
//
// Deliberately NOT here: any phrasing. "Retest due", "needs a re-check" and "based on
// older results" are each their own surface's copy over the same three states.

import { daysBetweenDateStr } from "./date";

// The three states a dated reading can be in against its clock:
//   • "current"        — measured within its interval.
//   • "due"            — measured, but past its interval; still real data, no longer
//                        something a surface may present as today's value.
//   • "not-applicable" — no clock applies: no date, no interval, or the domain exempted
//                        the reading (a value that cannot change has no retest clock).
// A domain must never collapse "not-applicable" into "due": an immutable blood type is
// not overdue, and an unmeasured fitness test is not stale.
export type FreshnessState = "current" | "due" | "not-applicable";

// The age of a reading in whole days, or null when either date is unparseable/absent.
// Callers that already hold an age (the fitness model computes one for its provenance
// line) pass it straight to `freshnessState` instead.
export function freshnessAgeDays(
  date: string | null | undefined,
  today: string | null | undefined
): number | null {
  if (!date || !today) return null;
  return daysBetweenDateStr(date, today);
}

// The ONE freshness decision. `ageDays` is the reading's age (null ⇒ undatable);
// `intervalDays` is the clock the domain resolved for THIS reading (null/non-positive ⇒
// no clock); `exempt` is the domain's own "this reading never goes stale" verdict.
//
// Boundary: stale STRICTLY AFTER the interval (age > interval), matching the biomarker
// retest clock this vocabulary was extracted from — a reading taken exactly one interval
// ago is still current, and comes due tomorrow.
export function freshnessState(
  ageDays: number | null | undefined,
  intervalDays: number | null | undefined,
  opts?: { exempt?: boolean }
): FreshnessState {
  if (opts?.exempt) return "not-applicable";
  if (ageDays == null || !Number.isFinite(ageDays)) return "not-applicable";
  if (intervalDays == null || !Number.isFinite(intervalDays) || intervalDays <= 0)
    return "not-applicable";
  return ageDays > intervalDays ? "due" : "current";
}

// The counting vocabulary every consuming aggregate reports in, so "3 of 12 based on older
// results" and "2 tests want a re-check" are the same arithmetic. `notApplicable` is
// carried separately and NEVER folded into either of the other two — that fold is exactly
// how an exempt reading becomes a phantom overdue one.
export interface FreshnessTally {
  current: number;
  due: number;
  notApplicable: number;
}

export function emptyFreshnessTally(): FreshnessTally {
  return { current: 0, due: 0, notApplicable: 0 };
}

export function tallyFreshness(
  states: Iterable<FreshnessState>
): FreshnessTally {
  const t = emptyFreshnessTally();
  for (const s of states) {
    if (s === "current") t.current++;
    else if (s === "due") t.due++;
    else t.notApplicable++;
  }
  return t;
}

// Whether an aggregate has NOTHING current to speak for it — every reading it counted is
// either past its clock or has no clock. The honesty gate both #2023 (the optimal-
// biomarker pillar must not paint an old panel green) and #2025 (completion copy must not
// read "current" off stale values) hang their neutral/older-results presentation on, so
// the two surfaces answer it identically.
export function hasNoCurrentReading(t: FreshnessTally): boolean {
  return t.current === 0;
}
