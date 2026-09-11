import {
  LOG_HABIT_WINDOW_DAYS,
  LOG_LEDGER_SEGMENT,
  type LogSegmentId,
  type SegmentLogDays,
} from "@/lib/log-sheet";
import { channelDays, getSurfaceUsage } from "@/lib/queries/surface-usage";

// THE "MOST-LOGGED DOMAIN" GATHER (issue #2709) — the data half of the dashboard
// sheet's opening segment. `lib/log-sheet.ts` owns the decision, the window, the
// evidence floor and the churn argument; this module only folds.
//
// ── WHAT IT COUNTS, AND WHY THAT AND NOT ROWS ────────────────────────────────
//
// DISTINCT DAYS on which the segment was logged at all, over the trailing
// `LOG_HABIT_WINDOW_DAYS`. The day grain is the stabiliser the ruling asked for
// (the argument is in the decision module): a rows measure would let one evening
// of six food taps outweigh a fortnight of morning weigh-ins, and would move the
// opening segment on a burst.
//
// ── AND WHY WEB DAYS ONLY (#4249) ────────────────────────────────────────────
//
// THE DEFECT THIS REPLACES. The question is which domain this person reaches THE
// SHEET for, and the sheet is on the web. The measure used to answer it with
// `source` filters, and `source` describes device-versus-hand, not surface: two
// ledgers took no source filter at all, and every Telegram write is manual-source
// anyway. So a profile who logged food exclusively through the chat taught the WEB
// sheet a food habit it did not have on the web, and the sheet opened on Consume
// for somebody who had never logged food there. The filter read like evidence
// while measuring a different quantity.
//
// WHAT IT ASKS NOW. The surface-usage read model (lib/queries/surface-usage.ts)
// over `logged_via` — the column that has recorded exactly this since #3087 — and
// the `web` channel of it. An ingested row answers `import` and is not a web act,
// so the wearable argument the `source` filters existed for still holds, now as a
// consequence of asking the right column rather than as a per-store predicate.
//
// THE THREE STABILISERS ARE UNCHANGED: the 90-day window, the day grain, and the
// seven-day floor are exactly what they were, and `LOG_HABIT_WINDOW_DAYS` is
// passed to the read model explicitly rather than inherited, because the sheet's
// window is the sheet's own argument (see its declaration).
//
// ── WHAT MOVES, AND WHAT MAY NEVER ───────────────────────────────────────────
//
// Profiles who log a domain only in the chat, only from an import, or only before
// #3087's tranche stamped anything now have LESS evidence than before, so more of
// them fall under the floor and keep the route's own default. That is the
// intended direction: under the floor the answer is not adapted at all. The #3077
// guardrail binds the rest — usage evidence may pick a default or an order, never
// remove or hide. Every segment stays on the track, every entry stays one tap
// away, and no profile can lose a domain because of what this counts.

/**
 * How many DAYS in the trailing `LOG_HABIT_WINDOW_DAYS` this profile logged each
 * segment on FROM THE WEB. `today` is the profile's own local day, resolved by the
 * caller.
 *
 * Day sets are unioned before they are counted: Consume is fed by three ledgers
 * and a day somebody logged food AND a dose on is one day's evidence, exactly as
 * six food taps in one evening are.
 *
 * Read-only and side-effect free. The decision over it is `openingLogSegment`
 * (lib/log-sheet.ts), which is where the window, the floor and the fallback live.
 */
export function getSegmentLogDays(
  profileId: number,
  today: string
): SegmentLogDays {
  const web = channelDays(
    getSurfaceUsage(profileId, today, LOG_HABIT_WINDOW_DAYS),
    "web"
  );
  const bySegment = new Map<LogSegmentId, Set<string>>();
  for (const [ledger, days] of web) {
    // A ledger the census does not declare contributes nothing rather than
    // guessing a segment for it — the census is the only place the pairing is
    // decided, and it is checked in both directions by its own test.
    const segment = LOG_LEDGER_SEGMENT[ledger];
    if (!segment) continue;
    const into = bySegment.get(segment) ?? new Set<string>();
    for (const day of days) into.add(day);
    bySegment.set(segment, into);
  }
  // Omitted at zero — a segment with no web day gets no key, and the decision over
  // this map (`openingLogSegment`) reads a missing segment as none.
  const out: Partial<Record<LogSegmentId, number>> = {};
  for (const [segment, days] of bySegment) out[segment] = days.size;
  return out;
}
