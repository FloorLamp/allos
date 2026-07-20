// Pure safety-screening COVERAGE summarizer (issue #1032). The safety-logic
// datasets are, by design, curated high-value subsets — and a stack whose items
// match NO curated rule used to render exactly like a stack that was checked and
// came up clean: nothing. The empty state is the more dangerous one (a real
// interaction the curated set simply doesn't cover), so coverage must be legible at
// the point of use: instead of silent null, the safety strips render a calm scope
// line ("Screened against a curated set … N of M match it. No flags found."), and a
// name-only item (no confirmed RxNorm code — even less likely to match a code-keyed
// rule) wears a quiet limited-coverage chip pointing at the #851 confirm flow.
//
// THE PRINCIPLE (stated in docs/internals/findings.md): a safety surface must never
// let absence of a finding read as an affirmative all-clear; when coverage is
// partial, say so. This is a LEGIBILITY fix, not a new warning class — no red, no
// interstitial, and the never-prescriptive posture is untouched.
//
// "Matched" means the item resolves to at least one concept in the curated
// drug-interaction vocabulary through the ONE shared matcher (matchConceptKeys —
// RxCUI-first, folded-name fallback), so the fraction can never disagree with what
// the detector would actually screen. No DB, no network; unit-tested in
// lib/__tests__/safety-coverage.test.ts.

import { matchConceptKeys } from "./drug-interactions";

// The minimal item shape the summarizer reads (the getSupplements projection).
export interface CoverageItem {
  name: string;
  rxcui: string | null;
  rxcuiIngredients?: string[] | null;
  active: boolean;
}

export interface SafetyCoverageModel {
  // Active items considered by the interaction screen (both kinds — a
  // supplement–drug interaction spans them).
  total: number;
  // Items resolving to at least one curated interaction concept.
  matched: number;
  // Items with NO confirmed RxNorm code (name-only) — degraded screening; the
  // #851 confirm flow is the improvement path.
  unresolved: number;
}

// Summarize the ACTIVE stack's screening coverage. Inactive items are out of the
// stack (the detector drops them too).
export function stackScreeningCoverage(
  items: readonly CoverageItem[]
): SafetyCoverageModel {
  const active = items.filter((i) => i.active);
  let matched = 0;
  let unresolved = 0;
  for (const item of active) {
    if (matchConceptKeys(item).length > 0) matched++;
    if (!item.rxcui?.trim()) unresolved++;
  }
  return { total: active.length, matched, unresolved };
}

// Whether an individual item's screening coverage is LIMITED (name-only — no
// confirmed RxNorm code). The med card's quiet chip keys on this.
export function isCoverageLimited(item: { rxcui: string | null }): boolean {
  return !item.rxcui?.trim();
}

// The calm scope line for the safety strips: states what was checked and how much
// of the stack the curated set covers, and — when the check rendered no flags —
// says "no flags" WITHOUT letting it read as clearance. Null for an empty stack
// (nothing was screened, so claiming anything would itself be dishonest).
// `noFlags` is whether the strip is otherwise empty (post-suppression).
export function coverageScopeLine(
  model: SafetyCoverageModel,
  noFlags: boolean
): string | null {
  if (model.total === 0) return null;
  const noun = model.total === 1 ? "active item" : "active items";
  const parts = [
    `Screened against a curated set of common drug and supplement ` +
      `interactions — ${model.matched} of ${model.total} ${noun} match it.`,
  ];
  if (noFlags) {
    parts.push("No flags found — a curated check, not an exhaustive one.");
  }
  if (model.unresolved > 0) {
    parts.push(
      model.unresolved === 1
        ? `1 item has no confirmed RxNorm code, so its screening is name-only.`
        : `${model.unresolved} items have no confirmed RxNorm code, so their screening is name-only.`
    );
  }
  return parts.join(" ");
}

// The quiet per-item chip copy (the med card) — a nudge toward the existing #851
// RxNorm confirm flow, never a warning.
export const COVERAGE_LIMITED_CHIP = "Limited screening";
export const COVERAGE_LIMITED_HINT =
  "No confirmed RxNorm code — interaction and safety checks match this item by name only. Confirm its RxNorm match in the edit form to improve screening.";
