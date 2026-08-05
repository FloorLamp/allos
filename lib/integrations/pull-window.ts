// The PURE decisions every pull-sync run makes (#2040).
//
// Before this module, oura-sync.ts, withings-sync.ts and strava-sync.ts each carried
// their own copy of the same four constants, the same "429 → truncate and keep the
// cursor" rule, and the same trailing-rescan window arithmetic — down to the
// comments, which said so ("Mirrors oura-sync.ts", "Mirrors strava-sync.ts"). Three
// copies of a rule is three chances to fix it in two places, and the planned Garmin
// entry would have been a fourth.
//
// So the rules live HERE, once, with no I/O: the runner (lib/integrations/pull-sync)
// applies them and the provider modules supply only the genuinely per-provider part
// (endpoint shapes, `next_token` vs `offset/more` vs `page`, row mapping).

// ---- The rate-limit / truncate rule ---------------------------------------

// HTTP 429. Every provider we pull speaks it; a few speak a second dialect too
// (Withings signals over-quota as envelope status 601 with HTTP 200).
export const RATE_LIMIT_STATUS = 429;

// Is this failing status the provider saying "slow down" rather than "you're broken"?
// `alsoRateLimited` carries a provider's extra dialect (Withings' 601).
export function isPullRateLimited(
  status: number,
  alsoRateLimited: readonly number[] = []
): boolean {
  return status === RATE_LIMIT_STATUS || alsoRateLimited.includes(status);
}

// What a page-fetch loop does with a non-OK response.
//   "truncate" — keep the items already gathered, stop, and DON'T advance the cursor,
//                so the next run re-fetches the whole window. Nothing is lost.
//   "fail"     — a real error: record a failed sync event and give up on this run.
export type PageOutcome = "truncate" | "fail";

export function pageOutcome(
  status: number,
  alsoRateLimited: readonly number[] = []
): PageOutcome {
  return isPullRateLimited(status, alsoRateLimited) ? "truncate" : "fail";
}

// A page loop that still has more to fetch when it reaches the per-run page cap is
// truncated for the same reason a 429 is: data remains upstream and the cursor must
// stay put. Named so the two callers can't drift into two spellings of it.
export function hitPageCap(page: number, maxPages: number): boolean {
  return page >= maxPages - 1;
}

// ---- The cursor rule -------------------------------------------------------

// What a truncated run does with the cursor.
//
//   "hold-on-truncate"    — Oura and Withings. Their cursor names a WINDOW EDGE
//                           (newest day / newest server updatetime), and the page
//                           loop gathers a window as a whole, so advancing after a
//                           partial fetch would strand the days past the re-scan
//                           margin forever.
//   "advance-to-processed" — Strava. Its cursor names the newest activity actually
//                           PROCESSED, computed row by row as the loop runs, so it
//                           never points past un-imported data even when the run was
//                           cut short — and holding it back would re-fetch (and
//                           re-pay the per-activity detail call for) everything the
//                           truncated run already imported.
export type CursorPolicy = "hold-on-truncate" | "advance-to-processed";

// THE cursor decision, for both policies and both cursor shapes (an ISO day string
// for Oura, epoch seconds for Withings/Strava — both compare correctly with `>`).
// A null/absent `next` means the run learned nothing newer.
export function shouldAdvanceCursor<T extends string | number>(
  policy: CursorPolicy,
  truncated: boolean,
  next: T | null | undefined,
  current: T
): boolean {
  if (next == null) return false;
  if (truncated && policy === "hold-on-truncate") return false;
  return next > current;
}

// ---- The window rule -------------------------------------------------------

function shiftDay(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export interface PullDayWindow {
  startDate: string;
  endDate: string;
}

// The DAY window a run pulls: a trailing re-scan before the cursor (a night or
// workout can be finalized a day or two after its date, and every upsert is keyed, so
// re-fetching is free), or the first-run backfill when there is no cursor yet. The
// end is a day past today to cover device-vs-server timezone slack.
export function pullDayWindow(
  cursor: string | null,
  today: string,
  rescanDays: number,
  backfillDays: number
): PullDayWindow {
  return {
    startDate: cursor
      ? shiftDay(cursor, -rescanDays)
      : shiftDay(today, -backfillDays),
    endDate: shiftDay(today, 1),
  };
}

export const DAY_SECONDS = 86_400;

// The same rule in epoch seconds, for a provider whose cursor is a server timestamp
// rather than a day (Withings' `lastupdate`). Never returns a negative instant.
export function pullSecondsWindow(
  cursor: number,
  nowSec: number,
  rescanDays: number,
  backfillDays: number
): { startSec: number; endSec: number } {
  const startSec =
    cursor > 0
      ? cursor - rescanDays * DAY_SECONDS
      : nowSec - backfillDays * DAY_SECONDS;
  return { startSec: Math.max(0, startSec), endSec: nowSec + DAY_SECONDS };
}
