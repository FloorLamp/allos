// The flat fall-back retest cadence for an analyte the curated dataset gives no
// `retest_days` for. A RETEST CLOCK in the freshness doctrine's terms: the question is
// "is a redraw due?" and the consequence is a nudge.
//
// NOT A PRESENTATION FLOOR, AND ANY AGREEMENT WITH ONE IS A COINCIDENCE (#4242). The
// repo's other lab-wide staleness interval is `RECENT_LAB_STALE_DAYS`
// (lib/recent-labs.ts), which decides whether a glance card may FRAME a reading as
// current — a different question, whose consequence is an age label rather than a
// redraw. The two are deliberately kept as separate values and are never shared by
// reference: moving a retest cadence must not restyle a dashboard, and restyling a
// dashboard must not send somebody for blood work. Whenever the two intervals happen to
// coincide — as they do at the time of writing — that is coincidence; neither may be
// edited by reading the other.
export const STALE_AFTER_DAYS = 365;
// Back-compat alias; the same value read as a default rather than the sole rule. It is an
// alias, so the cross-reference above is stated about the QUESTIONS rather than about a
// number: this name may move off `STALE_AFTER_DAYS` without the note going stale.
export const DEFAULT_RETEST_DAYS = STALE_AFTER_DAYS;

// The recommended retest interval (days) for a biomarker: its curated
// `retest_days` when present and positive, else the flat DEFAULT_RETEST_DAYS. Pure
// selection — the caller supplies the analyte's retest_days (from the canonical
// dataset via lib/biomarker-retest); a null/undefined/non-positive value falls
// back so an uncurated analyte behaves exactly as the old flat 365-day rule.
export function retestIntervalDays(
  retestDays: number | null | undefined
): number {
  return retestDays != null && retestDays > 0
    ? retestDays
    : DEFAULT_RETEST_DAYS;
}

// The retest AGE CEILING (issue #546): a reading older than this is stale BASELINE
// data ("last measured 12 years ago"), not "due for a redraw" — nudging it as an
// urgency-banded action item is dishonest. Past the ceiling a stale reading drops out
// of the retest nudge entirely (a distinct "historical" state), regardless of its
// analyte's cadence. Set well beyond the longest curated cadence (Lp(a)'s 5-year
// clock) so a normal recurring analyte never trips it — only genuinely ancient
// one-offs do.
export const RETEST_AGE_CEILING_DAYS = 3650; // ~10 years

// Whether a reading is beyond the retest age ceiling (issue #546) — so old it's
// historical baseline rather than "retest overdue". Pure; the caller supplies the
// reading's effective date and today.
export function isBeyondRetestHorizon(
  latestDate: string | null | undefined,
  today: string,
  ceilingDays: number = RETEST_AGE_CEILING_DAYS
): boolean {
  if (!latestDate) return false;
  return daysBetween(latestDate, today) > ceilingDays;
}

// Whole days between two YYYY-MM-DD dates (toISO - fromISO), or 0 if unparseable.
export function daysBetween(fromISO: string, toISO: string): number {
  const a = Date.parse(`${fromISO}T00:00:00Z`);
  const b = Date.parse(`${toISO}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}
