// THE ANNUAL RETROSPECTIVE (issue #2179) — the DB half: which years exist for a
// profile, and the year-scale recap the page renders.
//
// It is deliberately thin, because the retrospective is a RE-PRESENTATION and not a new
// computation. `gatherRecapInput` at `scale: "year"` already reads the declared window
// through the same query layer the weekly card and the monthly send use, and skips the
// reads whose line does not speak at year scale — so a year gather is BOUNDED by the
// same registry that decides the content (`RECAP_LINE_MODEL`). The per-day dose walk,
// the per-day nutrient walk and the cadence-ledger reads all belong to lines the year
// does not speak, so none of them runs here.
//
// Auth-blind, like every `lib/` read: `profileId` first, no `lib/auth` import. The page
// resolves the profile at the auth boundary and hands it down.

import { hoistedStatement } from "./db";
import { buildRecap, type Recap } from "./recap";
import { gatherRecapInput } from "./notifications/recap-data";
import { retrospectiveWindow } from "./retrospective";
import type { WeightUnit } from "./settings";

// The earliest day this profile has any of the data a retrospective REPORTS ON. Two
// day-grained stores, deliberately: activities and body metrics are what every year
// line ultimately hangs off (counts, composition, the weight arc), and a profile whose
// only row is a five-year-old imported lab result should not be offered five empty
// retrospectives.
//
// HOISTED (`lib/db.ts`): the page reads it once per render and it is a one-line SELECT
// of the kind that turned out to be recompiled ten thousand times a render on
// /household. Hoisting caches the compiled statement and never the value, so a reading
// logged earlier in the same request is still visible.
const FIRST_LOGGED_DAY = hoistedStatement(
  `SELECT MIN(d) AS day FROM (
     SELECT MIN(date) AS d FROM activities WHERE profile_id = ?
     UNION ALL
     SELECT MIN(date) AS d FROM body_metrics WHERE profile_id = ?
   )`
);

/** The profile's first logged day, or null when it has logged nothing at all. */
export function firstLoggedDay(profileId: number): string | null {
  const row = FIRST_LOGGED_DAY.get(profileId, profileId) as
    { day: string | null } | undefined;
  return row?.day ?? null;
}

/**
 * The year-scale recap for one calendar year — the retrospective's whole body.
 *
 * `asOf` and `completed` come from the pure window resolver, so a closed year is
 * narrated as a closed period (exactly as the send narrates a closed week) and the year
 * still running is narrated in progress, with the whole prior year as its comparison in
 * both cases.
 */
export function getRetrospective(
  profileId: number,
  year: number,
  today: string,
  weightUnit: WeightUnit = "kg"
): Recap {
  const win = retrospectiveWindow(year, today);
  return buildRecap(
    gatherRecapInput(profileId, weightUnit, "year", win.completed, win.asOf)
  );
}
