// The one-tap "Refilled" affordance's recency line (issue #1893 defect 2).
//
// `refillSupply` is already a good model core — typed outcomes, a lock-read-relative
// increment, pool-aware (#1374). The gap is that the operation is ADDITIVE: an accidental
// double-tap adds two bottles and nothing on the affordance says "you just refilled".
//
// The treatment is the #798 pattern — INFORMATIONAL, NEVER PERMISSIVE. Two bottles is a
// legitimate restock (a 90-count and a spare, a pharmacy that filled 180 as two bottles),
// so blocking or disabling the second tap would refuse a real write the user meant. The
// line TELLS: it names what the previous tap added, for a short window, and the button
// stays fully enabled the entire time. Exactly the PRN redose-window line's posture
// (lib/prn-redose.ts) one domain over.
//
// Pure: no DB, no clock, no React. The affordance holds the last refill it performed and
// asks this module what to say about it.

// How long "just now" lasts. Short on purpose: the line exists to catch the SECOND tap of
// a double-tap (or a glance back a moment later), not to summarize the day. Past this it
// says nothing rather than making a vaguer claim — a stale "just refilled" on a genuinely
// separate restock would be the informational half telling the same lie the permissive
// half was rejected for.
export const REFILL_RECENCY_WINDOW_MS = 2 * 60 * 1000;

// A refill this affordance performed: how many units it added, and when.
export interface RecentRefill {
  fillSize: number;
  atMs: number;
}

// A fill size as the line prints it: whole numbers bare, fractions to at most two
// decimals with trailing zeros trimmed (a 0.5 mL dropper refill reads "+0.5", not
// "+0.50").
function fillText(fillSize: number): string {
  // Number→String already drops trailing zeros, so the rounding is the whole job.
  return String(Math.round(fillSize * 100) / 100);
}

// "Refilled just now (+90)", or null when there is nothing recent to say — no refill has
// been performed here, or the window has passed. Never returns a message that gates: the
// caller renders it beside an enabled button.
export function refillRecencyLine(
  last: RecentRefill | null | undefined,
  nowMs: number
): string | null {
  if (!last) return null;
  if (!Number.isFinite(last.fillSize) || last.fillSize <= 0) return null;
  // A clock that moved backwards (skew, a frozen test clock) still reads as "just now" —
  // the elapsed time is only ever used to decide when to STOP saying it.
  if (nowMs - last.atMs >= REFILL_RECENCY_WINDOW_MS) return null;
  return `Refilled just now (+${fillText(last.fillSize)})`;
}

// When the line should disappear, as a delay from `nowMs` in milliseconds — so the
// affordance can schedule exactly one timer instead of ticking. Null when there is
// nothing showing.
export function refillRecencyExpiryMs(
  last: RecentRefill | null | undefined,
  nowMs: number
): number | null {
  if (refillRecencyLine(last, nowMs) == null) return null;
  return Math.max(0, last!.atMs + REFILL_RECENCY_WINDOW_MS - nowMs);
}
