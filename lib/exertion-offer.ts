// THE UNCLAIMED EFFORTS ONE DAY HOLDS (issue #5113, reader 2's half of it).
//
// `lib/exertion-window.ts` already holds the whole judgment about what a finished
// effort is. This is its database tier for a NAMED DAY and nothing more: it gathers
// what `exertionWindows` takes, asks it, drops the spans the person has already said
// no to, and hands back the newest one as local clocks a form can carry.
//
// A SPAN IS A SUGGESTION UNTIL A ROW CLAIMS IT (the #5194 ruling, applied here without
// being asked). Nothing in this module writes. The offer it returns is a DEFAULT in two
// fields that the person edits or ignores, and the row is written by the save they tap.
//
// ── THE OFFER IS MADE ONCE, ACROSS EVERY READER ──────────────────────────────
// Readers 2 to 4 (#5195, #5196, #5197) all ask this module, and a span the person has
// declined ANYWHERE is filtered here rather than at each surface — which is why the
// filter is on this side of the seam and not in the form. The store is the existing
// suppression bus (`upcoming_dismissals`), read through `getFindingSuppressions`, under
// the `exertion-span:` namespace declared in lib/dismissal-keys.ts. There is no second
// way to remember a refusal, and #5197's decline writes THAT key.
//
// ── THE RECOVERY AND THE FLOOR COME FROM ONE READ ────────────────────────────
// `exertionWindows` wants two priors — how long this person usually takes to come back
// inside their resting range, and how short their own sessions run. Both are answered
// from the same capped page of their recent windowed activities, so the cost of this is
// a constant and not a function of account age.
//
// ACROSS TYPES, DELIBERATELY, and this is the one place this module reads a usual
// differently from `lib/queries/event-physiology.ts`. That module's `usualRecoveryMin`
// is documented per KIND because its callers hold a row and therefore a type. A form
// opened blank holds neither: the person has not said what they did, and the heart rate
// cannot tell a run from a sauna. So the priors here are the profile's recent windowed
// sessions whatever they were, which is the only honest answer to "how long does this
// person take to come down" when nobody has said what this one was.

import { getTimezone } from "./settings/display";
import { shiftDateStr, zonedMinuteStr, zonedWallTimeToUtc } from "./date";
import {
  exertionWindows,
  type ExertionSpan,
  type ExertionSample,
} from "./exertion-window";
import { db, today } from "./db";
import { getHrInstantsInRange } from "./queries/metrics";
import {
  restingCeilingBpm,
  usualRecoveryMin,
} from "./queries/event-physiology";
import { USUAL_RECENT_EVENTS } from "./event-physiology";
import {
  activityWindow,
  activityWindows,
  type ActivityWindowInput,
} from "./training-zones";
import { getFindingSuppressions } from "./queries/upcoming/suppressions";
import { isSuppressed } from "./upcoming-suppress";
import { exertionSpanDismissalKey } from "./dismissal-keys";

/** A span, as the local clocks a form or a chart states. */
export interface ExertionOffer {
  /** `HH:MM`, profile-local. */
  start: string;
  end: string;
  /** Its row on the suppression bus, so a decline is remembered once for every reader. */
  dismissalKey: string;
}

/**
 * The profile's recent windowed sessions, newest first and capped — the page both
 * priors are read from. "Prior" is the days BEFORE the day being offered on: a session
 * already logged on that day is a CLAIM, and it is read as one below rather than as
 * evidence about how this person recovers.
 */
function priorWindows(profileId: number, date: string): ActivityWindowInput[] {
  return db
    .prepare(
      `SELECT date, start_time, end_time, duration_min FROM activities
        WHERE profile_id = ? AND start_time IS NOT NULL AND date < ?
        ORDER BY date DESC, id DESC
        LIMIT ?`
    )
    .all(profileId, date, USUAL_RECENT_EVENTS) as ActivityWindowInput[];
}

/** The shortest of those sessions, in minutes, or null when they hold none. */
function shortestWindowMin(
  priors: readonly ActivityWindowInput[],
  tz: string
): number | null {
  let shortest: number | null = null;
  for (const prior of priors) {
    const window = activityWindow(prior);
    if (!window) continue;
    const from = zonedWallTimeToUtc(tz, ...splitLocal(window.start));
    const to = zonedWallTimeToUtc(tz, ...splitLocal(window.end));
    if (!from || !to) continue;
    const minutes = (to.getTime() - from.getTime()) / 60_000;
    if (minutes > 0 && (shortest == null || minutes < shortest))
      shortest = minutes;
  }
  return shortest;
}

/** `YYYY-MM-DDTHH:MM` as the (date, HH:MM) pair the zone resolver takes. */
function splitLocal(local: string): [string, string] {
  return [local.slice(0, 10), local.slice(11, 16)];
}

/**
 * Every window an activity or a practice already accounts for over the day and the one
 * before it. The day before is included because a session that crossed midnight claims
 * the morning of this one, and a span overlapping a logged practice is that practice's
 * physiology rather than a workout nobody logged.
 */
function claimedSpans(
  profileId: number,
  date: string,
  tz: string
): ExertionSpan[] {
  const from = shiftDateStr(date, -1);
  const rows = [
    ...(db
      .prepare(
        `SELECT date, start_time, end_time, duration_min FROM activities
          WHERE profile_id = ? AND date >= ? AND date <= ? AND start_time IS NOT NULL`
      )
      .all(profileId, from, date) as ActivityWindowInput[]),
    ...(db
      .prepare(
        `SELECT date, start_time, end_time, duration_min FROM practice_logs
          WHERE profile_id = ? AND date >= ? AND date <= ? AND start_time IS NOT NULL`
      )
      .all(profileId, from, date) as ActivityWindowInput[]),
  ];
  const spans: ExertionSpan[] = [];
  for (const window of activityWindows(rows)) {
    const start = zonedWallTimeToUtc(tz, ...splitLocal(window.start));
    const end = zonedWallTimeToUtc(tz, ...splitLocal(window.end));
    if (start && end) spans.push({ from: start.getTime(), to: end.getTime() });
  }
  return spans;
}

/**
 * The finished efforts this profile-local day holds that nothing has claimed and nobody
 * has declined, oldest first. The shared reader for #5195, #5196 and #5197 — each
 * surface states these differently, and none of them re-derives them.
 */
export function unclaimedExertionSpans(
  profileId: number,
  date: string
): ExertionSpan[] {
  const tz = getTimezone(profileId);
  // A BARE WRIST COSTS ONE READ. With no trace there is no answer, and asking for it
  // first means the priors below — ten windows, each its own HR read through
  // `usualRecoveryMin` — never run for a profile that was never going to get one.
  const samples: ExertionSample[] = getHrInstantsInRange(profileId, date, date);
  if (samples.length === 0) return [];
  // No resting range of their own is no ceiling to compare against, and this feature
  // refuses to invent one (#4775).
  const ceiling = restingCeilingBpm(profileId);
  if (ceiling == null) return [];

  const priors = priorWindows(profileId, date);
  const spans = exertionWindows({
    samples,
    ceilingBpm: ceiling,
    usualRecoveryMin: usualRecoveryMin(profileId, priors),
    minWindowMin: shortestWindowMin(priors, tz),
    claimed: claimedSpans(profileId, date, tz),
  });
  if (spans.length === 0) return [];

  const suppressions = getFindingSuppressions(profileId);
  const asOf = today(profileId);
  return spans.filter((span) => {
    const record = suppressions.get(
      exertionSpanDismissalKey(spanStartLocal(span, tz))
    );
    return record == null || !isSuppressed(record, asOf);
  });
}

/** The local minute a span began — its identity on the suppression bus. */
function spanStartLocal(span: ExertionSpan, tz: string): string {
  return zonedMinuteStr(tz, new Date(span.from));
}

/**
 * The newest unclaimed effort of the day as local clocks, or null when the trace does
 * not say. The LATEST one because the form is being opened now, about the session that
 * just happened; the earlier spans of a two-session day stay available to the chart.
 */
export function latestExertionOffer(
  profileId: number,
  date: string
): ExertionOffer | null {
  const spans = unclaimedExertionSpans(profileId, date);
  const span = spans[spans.length - 1];
  if (!span) return null;
  const tz = getTimezone(profileId);
  return {
    start: zonedMinuteStr(tz, new Date(span.from)).slice(11, 16),
    end: zonedMinuteStr(tz, new Date(span.to)).slice(11, 16),
    dismissalKey: exertionSpanDismissalKey(spanStartLocal(span, tz)),
  };
}
