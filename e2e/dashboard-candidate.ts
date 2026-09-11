import type { Locator, Page } from "@playwright/test";

// A ROW ON HOME, BY THE ROW CONTRACT'S OWN ID (#5435 §5.1).
//
// THE TESTID WENT WITH THE RANKER, AND THE ID DID NOT, which is the whole reason this
// file still exists. `data-testid="dashboard-candidate"` was rendered by
// `DashboardStandingCluster` and by nothing else, so PR 2 — which stops mounting the
// placement canvas — leaves it absent on every route, for every profile, in every
// state. `data-candidate-id` is the attribute §5.1 keeps ON PURPOSE, precisely so the
// specs that visit `/` need no rename: Home's composer mints the id for an
// attention-model row through the SAME `dashboardAttentionCandidateId` the ranker used,
// so `attention.fact:<key>` resolves to the same row it always did.
//
// WHAT THIS CANNOT DO IS RESURRECT A FAMILY. A prefix naming a row #5435 §4 retired
// from Home — Standing's readings, the pillars, the recap lines, the weekly-target
// progress rows, the mood check-in, the coaching observations — resolves to nothing
// here whatever attribute it is spelled with, because the row is gone rather than
// renamed. A spec asserting one of those is retired, not repaired; this helper is for
// the rows that survived.
export function dashboardCandidatePrefix(page: Page, prefix: string): Locator {
  return page.locator(`[data-candidate-id^="${prefix}"]`);
}

export function dashboardCandidateWithText(
  page: Page,
  prefix: string,
  text: string | RegExp
): Locator {
  return dashboardCandidatePrefix(page, prefix).filter({ hasText: text });
}

// THERE IS NO SECOND OPENER (#4232). `openStandingTail` lived here while the page had
// two folds; Standing has none now, so every spec that wants a quiet row opens the ONE
// fold through `openDashboardAll` in ./helpers.
//
// AND SINCE #5435 THERE IS NO FOLD EITHER: §4 retires the "Show everything" tail with
// the ranker that filled it, so a row is either on the page or it is not on it. Nothing
// here opens anything any more.
