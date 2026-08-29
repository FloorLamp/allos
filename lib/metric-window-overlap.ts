import { utcInstant } from "./date";
import {
  DAY_BUCKET_METRICS,
  SUB_DAILY_WINDOW_MAX_MIN,
} from "./integrations/health-connect-metrics";

// THE OVERLAP-SUPERSEDE RULE for `metric_samples` interval rows (issue #3424).
//
// WHY IT EXISTS. The Health Connect exporter's `daily` setting sends one interval
// record per DEVICE-LOCAL day: window = local midnight to the push moment. #1101 made
// `upsertMetricSamples` idempotent on (profile, metric, source, origin, started_at)
// so a moving END overwrites itself. A TIMEZONE CHANGE moves the START instead: the
// exporter re-anchors "today" to the new zone's midnight, so the re-anchored record
// carries a brand-new natural key, never supersedes the old one, and
// `getMetricDailyTotals` SUMs both into one profile-local day. Measured on prod
// profile 1: 23330 steps for a day with 11721.
//
// THE RULE, AND THE THREE THINGS THAT BOUND IT. "The newer row wins over whatever it
// overlaps" converges an affected span to the exporter's current anchoring. #3424
// justified it with "under one anchoring, same-(metric, origin) day buckets are
// pairwise disjoint, so an overlap is always the mixed-anchoring anomaly". THAT
// PREMISE IS NOT TRUE OF EVERY ROW THE PARSER EMITS, and an adversarial review proved
// it by deleting real readings with it. So the rule states its own preconditions now
// rather than inheriting them:
//
//   1. ONLY THE DAY-BUCKET METRICS (`DAY_BUCKET_METRICS`). Nutrition emits one
//      interval row per nutrient per NutritionRecord on the record's REAL start and
//      end, so a snack logged inside a meal window is two legitimately nested
//      `nutrition_kcal` rows and the rule would delete the meal. `sleep_min` is one row
//      per session on the session's real window, and two overlapping sessions are two
//      readings rather than one anomaly. Neither tiles, so neither may be superseded.
//   2. ONLY AT DAY-BUCKET GRANULARITY (`isDayBucketWindow`). The metric list alone is
//      not enough: the same four metrics arrive as MINUTE buckets at a `1m`/`15m`
//      exporter setting, and two devices that set no `metadata.data_origin` both parse
//      to `origin = null` (`dataOrigin`), which lands their minute buckets in ONE
//      supersede group. Gating on the OBSERVED window rather than on the recommended
//      setting is what makes that unreachable: this repo already calls a window an hour
//      or narrower a fine-grained setting (`SUB_DAILY_WINDOW_MAX_MIN`), and the rule
//      declines to act on one.
//   3. ONLY WHEN THE PAYLOAD SAYS THE INCOMING ROW OUTRANKS THE STORED ONE
//      (`pushOutranks`), below.
//
// FRESHNESS IS STATED BY THE PAYLOAD, NEVER FROM ARRIVAL ORDER AND NEVER FROM A WINDOW.
// Deciding "incoming wins" from position was refuted twice - a push over
// INGEST_CHUNK_SIZE split a mixed-anchoring pair across two chunks and the stale bucket
// deleted the current one, and a byte-identical REPLAY of a pre-switch payload deleted
// the converged row and re-inserted the stale one. So every Health Connect row carries
// `metric_samples.pushed_at`, the instant the EXPORTER stamped on the push that wrote it
// (`payload.timestamp`), and a row may only supersede a stored row whose stamp is
// STRICTLY OLDER. A replay carries the same stamp as the push it replays, so it takes
// nothing.
//
// THAT IS THE FRESHNESS RULE AND IT IS NOT THE ORDERING ONE. Two rows of one push do
// carry the same stamp, so neither can out-rank the other - but that fact was cited for
// years' worth of review rounds as the reason a chunk split is harmless, and it does not
// carry that claim. It says rows of a push cannot be each other's VICTIMS. It says
// nothing about what a row of the push READS, and the read is where two refutations
// landed: the same push stored 11609 or 22609 depending only on where the chunk boundary
// fell, because a delete for one row changed the natural-key twin a later row looked up.
// What makes order and chunking irrelevant is that THE DELETES ARE NOT DECIDED IN THE
// WRITE LOOP AT ALL, and are not decided from the payload either: the victim set is
// derived from THE STORE, in the last chunk's transaction, from the rows that push
// actually wrote - see `supersedeMetricSampleOverlaps` in lib/integrations/normalize.ts.
// This rule is what that derivation consults; it is not what makes it order-free.

// AND A NULL STAMP IS *UNKNOWN*, NOT "OLDER THAN EVERYTHING". This is the third state
// the rule needs, and reading it as the second one was a defect that survived four
// rounds. `pushed_at` is NULL on every row written before the column existed - which on
// deploy day is EVERY row in the store, the correct ones included, and stays NULL - for
// good - on any day the exporter's rolling window no longer reaches. Treating NULL as
// losable made the exact replay this column was added to kill work again: a byte-identical
// re-delivery of a pre-switch push deleted the CORRECT re-anchored row and left the day
// reading 11609 for 11721 walked - LOW, invisible, and with the row that held the right
// number gone. Pre-PR the same day read 23330: wrong, but visibly wrong, and the right
// number still stored beside it. A patch that makes a bug quieter is worse than the bug.
//
// AND NOTHING COMES ALONG LATER TO REPAIR EITHER. #3439 would have replayed the rule over
// stored history; it is CLOSED AS NOT PLANNED (owner ruling, 2026-08-22 - prod was fixed
// separately). This file used to hang "until #3439 runs" on every wrong day it names,
// which read as a promise the state was temporary. It is not: a day outside the window
// keeps whatever it has, indefinitely. That does not weaken the argument below by a word
// - NULL means UNKNOWN because of when the column landed, and the era markers bound the
// collapsible subset by this database's own id counter. Neither ever depended on a replay
// running. What it changes is what VISIBLE buys: not "someone will fix this later", but a
// day that reads HIGH next to a stored row still holding the right number, which a person
// can see and correct, instead of a day that reads low with the right reading deleted.
//
// So a NULL-stamped row is deleted only on PROOF that it predates the stamped era, and
// only by a push that PROVABLY postdates it. The migration records both halves once,
// as two `settings` values (`UnstampedEra`, below):
//
//   * `startedAt`      the instant `metric_samples.pushed_at` began being written.
//   * `lastUnstampedId` the highest `metric_samples.id` that existed at that instant.
//
// THE TWO HALVES ARE NOT EQUALLY EXACT, and saying so is the point of this paragraph.
//
//   * `id <= lastUnstampedId` IS exact. `id` is `INTEGER PRIMARY KEY AUTOINCREMENT`
//     (migration 083), so it is monotonic and never reused: the comparison is a
//     statement about this database's own counter, and it cannot become true for a row
//     written later. Not a heuristic.
//   * `incoming > startedAt` IS NOT. It compares a PHONE's stamp to THIS SERVER's clock
//     at the moment the migration ran - two clocks, never synchronised, and this repo
//     bounds the phone's only in one direction (MAX_PUSH_CLOCK_SKEW_MS, below). A phone
//     running behind the server reads as older than the era it actually postdates.
//     What that costs is bounded and self-healing and points the safe way: such a push
//     collapses NONE of its own pre-era NULLs, so the double count stays visible until
//     real time passes the offset. A phone running AHEAD
//     could in principle claim to postdate an era it predates - but a push that predates
//     the era predates the column, so it cannot be delivered by an exporter that is
//     writing stamps, and the skew bound refuses the far-future case outright.
//
// So together they state something slightly weaker than "the push is newer": the row is
// one of the pre-existing rows the migration itself saw, and this push SAYS it happened
// after the column landed. That is the strongest thing available about a NULL row, and
// where it is wrong it is wrong toward keeping rows. Every OTHER NULL - a row a stampless
// push wrote afterwards, a row whose provenance the store cannot establish - is simply
// not superseded, and the double count stays visible.
//
// TWO CLOSURES WERE WEIGHED AND LOST, both recorded here so this is not re-opened:
//
//   * A PER-GROUP HIGH-WATER MARK (supersede a NULL row only from a push at least as new
//     as the newest stamp seen for that group). It needs no migration state, but its
//     value MOVES AS THIS PUSH WRITES: row 2 of a push reads the stamp row 1 just wrote,
//     so what survives depends on row order and on where the chunk split falls - the
//     class of defect round 1 died on. Making it order-free means computing it for the
//     whole push before any chunk writes and threading it through, and it still cannot
//     act on the FIRST stamped push after deploy, because a store of NULLs offers no
//     high-water mark to beat.
//   * BACKFILLING `pushed_at` in the migration. Same semantics as the era markers, but
//     it writes the migration instant onto every historical row - a value no exporter
//     ever sent - so the column stops meaning what its own docstring says, the store
//     loses the only record of which rows predate the column, and a boot pays a
//     full-table UPDATE instead of two `settings` rows.
//
// AND THE STAMP MUST BE A PUSH TIME, NOT A WINDOW QUANTITY. An earlier version fell
// back, when a push stated no `timestamp`, to the furthest-forward `ended_at` in the
// push. An END is a property of the READING, not of the push. A re-anchored bucket for a
// COMPLETED day ends EARLIER than the old-anchoring "today so far" row it overlaps, so
// the fallback read the correcting push as older and the correcting reading was never
// written at all:
//
//     push 1  steps [15:00Z, 23:00Z) = 3000   old anchoring, still filling
//     push 2  steps [10:00Z, 22:00Z) = 3500   re-anchored, COMPLETED
//     -> stored 3000, for 3500 walked, and no next push fixes it
//
// THAT IS THE FAILURE THIS FILE EXISTS TO NOT HAVE. The bug it was sent to fix reads a
// day too HIGH, which a person can see and which the next push can repair. A missing
// reading reads too LOW, looks exactly like a day you did not walk, and converges on
// nothing. Every trade here goes the other way: a stated stamp or no supersede at all.
//
// MEASURED before removing that fallback: of 228 captured payloads, the 175 carrying an
// `app_version` — every real exporter push — state a readable `timestamp`, 175 of 175.
//
// A PUSH CARRIES ONE ANCHORING. That is measured, not assumed, and it is why there is
// no within-push rule here to read.
//
// #3424 says the rolling ~48h window re-sends the pre-switch record ALONGSIDE the
// re-anchored one, and two versions of this file had a first phase that picked a winner
// between two overlapping rows of ONE push. The owner settled it from the exporter's own
// retained bodies (the ruling on #3424): all 50 pushes spanning the real
// America/New_York -> America/Los_Angeles switch of 2026-08-21T02:11:41Z, and for the
// four day-bucket metrics —
//
//     28 pushes before, 17:49Z..01:58Z   04:00Z starts only (NY midnight)   0 overlaps
//     22 pushes after,  02:14Z..12:05Z   07:00Z starts only (LA midnight)   0 overlaps
//
// The first post-switch push landed three minutes after the switch already carrying
// nothing but the new anchoring, and the old 04:00Z keys never appear again in 22
// pushes — including for the re-anchored 08-19 `active_calories` bucket, which arrives
// re-cut rather than beside its predecessor. The exporter re-queries Health Connect's
// aggregate-by-local-day under the device's CURRENT zone and sends that.
//
// So the pair phase 1 existed to settle is one the exporter does not send, and the only
// evidence that separates two anchorings is the one this rule already uses: the PUSH
// BOUNDARY. Rows of one push share a stamp, so none can be another's victim - and a
// chunk split is harmless for a DIFFERENT and stronger reason, which is that the whole
// push's effect is planned before any of it is written.
//
// Every defect three adversarial passes found lived in that phase — a completed
// re-anchored bucket ranked staler than the still-filling row it corrects (3000 stored
// for 3500 walked, then an already-correct store regressed), and a withheld write that
// dropped a reading and reported "nothing new". If a push ever DOES carry both
// anchorings, both are written: a double count, visible in every total, said out loud in
// Review, and collapsed by the next push with a newer stamp.
//
// COVER THE DAY - THE UNIT OF THE RULE, AND THE THING TEN ROUNDS WERE SPENT FINDING
// (#3424, the owner's ruling of 2026-08-23T00:58Z). A stored day bucket may be deleted
// only when a bucket of the same (profile, metric, source, origin) LANDED IN THIS PUSH
// ON THE VICTIM'S OWN `date` and overlaps it:
//
//     EXISTS (stamped row, same group, date = victim.date, overlapping)
//
// OVERLAP IS STILL A GATE - it is what excludes the rollover pair and the same-anchoring
// neighbours. THE DATE IS WHAT CARRIES THE JUSTIFICATION. Both halves are load-bearing
// and neither is sufficient:
//
//   * OVERLAP ALONE deletes a reading. Day buckets CHAIN ACROSS DAYS - the LA 08-19
//     bucket [08-19 07:00Z, 08-20 07:00Z) overlaps the NY 08-20 bucket
//     [08-20 04:00Z, 08-21 04:00Z) by three hours - so the PREVIOUS day's re-anchored
//     bucket could justify deleting a row on a day this push never replaced. A tombstone
//     or a #1101 stale-retry on the row that WOULD have replaced it did not stop that,
//     because a different row of the same push overlapped the victim anyway, and the day
//     went to ZERO. "A suppressed replacement justifies nothing" was true of the ROW and
//     false of the PUSH.
//   * COVER-THE-WINDOW (the union of this push's stamped windows must contain the
//     victim's) never fires on the shape the exporter actually sends. Westward the new
//     anchoring's bucket STARTS LATER than the old one's (LA 07:00Z vs NY 04:00Z);
//     eastward it ENDS EARLIER (Tokyo 15:00Z vs NY 04:00Z next day). A single new bucket
//     never covers an old one, and the union that would - two consecutive
//     new-anchoring days - only ever arrives in a rollover push. Prod's four doubled
//     pairs would stay doubled, and this rule would be inert on its own P1.
//
// WHAT THE DATE TERM BUYS, AS AN INVARIANT RATHER THAN A CASE LIST: A DATE ALWAYS KEEPS
// A READING. A victim on date D is deleted only because a row filed under D landed in
// this push; that row is in the store (the derivation reads it back from there) and can
// never itself be a victim (rows carrying this push's stamp are excluded from the
// candidate set). So D is left holding at least the row that justified the delete. The
// mechanism cannot empty a day. That is structural, not a property of the fixtures, and
// lib/__db_tests__/hc-overlap-supersede-refutations.test.ts asserts it around EVERY
// attack in the file rather than at one example.
//
// WHAT IT ACCEPTS, AND THE ACCEPTANCE IS DELIBERATE: THE SWITCH DAY'S LEADING SLIVER.
// A re-anchored bucket that starts AFTER the stored bucket it replaces takes that
// bucket's leading hours, [stored.start, incoming.start), with it. Westward that sliver
// is the old zone's midnight to the new zone's midnight - near-zero steps, a few hours
// of BMR on total_kcal. Eastward it is a MORNING: the first Tokyo bucket starts 15:00Z,
// so replacing the NY row on that date drops the NY morning. THE DAY KEEPS A READING, A
// SMALLER ONE FOR THAT SPAN. That is the trade, in one sentence, and it is the sentence
// docs/internals/integrations-sync.md carries.
//
// It is NOT claimed to be distinguishable in Review. `superseded: 1` reads the same for
// a lossless interior collapse and for a sliver drop, and the rule no longer needs the
// distinction: the failure that claim was excusing - a date left with nothing - can no
// longer occur.
//
// IT FAILS TOWARD KEEPING ROWS. This path DELETES stored health data, so every
// uncertainty resolves to "no supersede": an instant this module cannot read as an
// unambiguous UTC instant, a window with no duration, a window at sub-daily
// granularity, a metric that can nest, a push with no readable stamp, a candidate filed
// under a different `date`. A false negative leaves a double count the next push fixes;
// a false positive destroys a reading nobody can get back.

/**
 * One stored or incoming `metric_samples` window, in the columns this rule reads.
 * Structural, so the pure tier can exercise it without a live schema.
 */
export interface MetricWindow {
  id: number;
  /** Profile-local day the row is filed under (`YYYY-MM-DD`). */
  date: string;
  started_at: string;
  ended_at: string;
  /** The #133 user-edit lock. NULL on rows written before migration 115. */
  edited: number | null;
  /**
   * The exporter's stamp on the push that wrote this row. NULL on every row stored
   * before `20260821-hc-overlap-supersede`, and on every non-Health-Connect row.
   */
  pushed_at: string | null;
}

// The tiling metrics live beside the exporter's own granularity guidance, because that
// is what they are a fact about; re-exported here so a reader of the rule finds them.
// Nutrition emits one interval row per nutrient per NutritionRecord on the record's REAL
// window, so a snack logged inside a meal is two legitimately nested `nutrition_kcal`
// rows and the rule would delete the meal. `sleep_min` is one row per session. Both are
// `daily` in SOURCE_FIDELITY, but nothing ENFORCES that — `FINE_GRAINED_CHECK` says in
// its own comment that detection is informational — so the rule cannot lean on a setting.
export { DAY_BUCKET_METRICS };

/** Is this a metric whose Health Connect windows tile, so an overlap is an anomaly? */
export function isDayBucketMetric(metric: string): boolean {
  return DAY_BUCKET_METRICS.has(metric);
}

// An instant this rule is willing to compare, in epoch ms - or null when it is not.
//
// An explicit UTC designator (`Z`) or a numeric offset is REQUIRED. `metric_samples`
// instant columns are documented `mixed` (docs/internals/time-columns.md): they hold
// vendor ISO for an imported sample AND a bare `${date}T00:00:00` - a profile-local
// day midnight, not an instant - for a reading whose author stated only a day. Those
// bare strings parse against the HOST's zone, which would make a delete decision
// depend on where the server runs, so they are refused outright.
export function instantMs(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Do two half-open windows `[start, end)` overlap, as INSTANTS?
 *
 * A window with no duration (`end <= start`) is a POINT reading - HRV, skin
 * temperature, lean mass, height, BMR all store `started_at === ended_at` - and never
 * overlaps anything, in either role. That is the guard that keeps the interval rule
 * off the point rows: the textbook half-open test `aStart < bEnd && bStart < aEnd`
 * answers TRUE for a degenerate window sitting inside a real one, which would let a
 * daily bucket delete a point reading it merely contains.
 *
 * Comparison is on parsed instants, never on the strings: `2026-05-02T00:00:00.000Z`
 * and `2026-05-02T00:00:00Z` are the same moment and sort the wrong way lexically,
 * and an offset spelling (`2026-05-02T09:00:00+09:00`) does not sort at all.
 */
export function windowsOverlap(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string
): boolean {
  const as = instantMs(aStart);
  const ae = instantMs(aEnd);
  const bs = instantMs(bStart);
  const be = instantMs(bEnd);
  if (as === null || ae === null || bs === null || be === null) return false;
  if (ae <= as || be <= bs) return false; // point reading - not an interval
  return as < be && bs < ae;
}

/**
 * Is this window one the exporter cut as a DAY BUCKET rather than a fine-grained one?
 *
 * The threshold is `SUB_DAILY_WINDOW_MAX_MIN`, the constant the at-ingest granularity
 * detector already uses for exactly this judgement: "a daily-stored additive metric
 * arriving in windows an hour or narrower is a fine-grained setting regardless of how
 * few rows the push carried". Reused rather than re-picked, so the two cannot drift and
 * the number keeps its one derivation.
 *
 * A genuine `daily` bucket pushed within the first hour of local midnight is itself an
 * hour or narrower, so this declines to act on it — in BOTH roles. As the incoming row
 * that is transient: the next push carries the same day grown past the hour and acts.
 * As the STORED row it is PERMANENT: nothing ever widens a row already in the table, so
 * no later push may collapse it and no historical replay is coming either (#3439, closed
 * as not planned). The day reads high for as long as both rows are stored. Measured: a
 * 20-minute stored bucket under three later day-bucket pushes left a day reading 9200 for
 * 9000 walked, indefinitely.
 *
 * That is still the safe direction — the alternative is a rule that deletes minute
 * buckets — but it is a residual rather than a delay, so it is counted into the overlaps
 * LEFT STANDING and said out loud, and this comment no longer claims otherwise.
 */
export function isDayBucketWindow(start: string, end: string): boolean {
  const s = instantMs(start);
  const e = instantMs(end);
  if (s === null || e === null) return false;
  return e - s > SUB_DAILY_WINDOW_MAX_MIN * 60_000;
}

/**
 * Order two window starts oldest-first, as INSTANTS where both are readable and
 * lexically otherwise - the `isStaleMetricSnapshot` discipline, for the same reason:
 * `started_at` holds more than one spelling and a write order must not depend on which
 * one a vendor chose.
 */
export function compareWindowStarts(a: string, b: string): number {
  const am = instantMs(a);
  const bm = instantMs(b);
  if (am !== null && bm !== null) return am - bm;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Is this a window the rule may act on at all: a readable, non-degenerate interval of
 * a tiling metric, cut at day-bucket granularity?
 */
export function isSupersedingWindow(
  metric: string,
  start: string,
  end: string
): boolean {
  return (
    isDayBucketMetric(metric) &&
    windowsOverlap(start, end, start, end) &&
    isDayBucketWindow(start, end)
  );
}

// ---- THE DAY A BUCKET NAMES, READ OFF ITS OWN ANCHOR (#3901) ----
//
// A day bucket's window is cut by the DEVICE: `started_at` IS a device-local midnight.
// `metric_samples.date` used to be an attribution of that instant under the PROFILE's
// zone at push time, and the two disagree for hours around every travel switch — the
// phone re-anchors on landing, the profile flips when the person taps the travel banner.
// Measured on prod (#3901): an NY-anchored bucket (`start_time 2026-08-27T04:00:00Z`)
// arriving while the profile still held America/Los_Angeles was filed under 08-26, met
// cover-the-day against the real, completed 08-26 bucket and superseded it — and then
// the re-send re-derived its own `date` to 08-27 and walked off the day it had emptied.
// Two days of steps, distance and kcal, unrecoverable from the exporter's 48 h window.
//
// So the day is derived from the WINDOW instead: the implied offset is the one that
// makes `started_at` a midnight, and the bucket's day is the calendar date there. That
// makes `date` a pure function of `started_at`, which is in the natural key — a re-send
// cannot move it, and the "a date always keeps a reading" invariant becomes true ACROSS
// pushes rather than only within one.
const DAY_MS = 24 * 60 * 60 * 1000;
// A real zone offset runs [-12:00, +14:00] and lands on a quarter hour (+05:30, +05:45,
// +12:45). Nothing here needs to know WHICH zone — only whether the offset an anchor
// implies is one a zone could have. An anchor off the quarter-hour grid is not a
// midnight any zone keeps, so it implies nothing and the caller keeps today's answer.
const MIN_ZONE_OFFSET_MS = -12 * 60 * 60 * 1000;
const MAX_ZONE_OFFSET_MS = 14 * 60 * 60 * 1000;
const ZONE_OFFSET_STEP_MS = 15 * 60 * 1000;

// The offsets `o` for which `started_at + o` is a midnight: `o = -(started_at mod 24h)`,
// normalized into the real-offset range. There are two representatives a day apart and
// at least one is always in range — `west` breaks the -12 h floor above 12:00Z, `east`
// breaks the +14 h ceiling below 10:00Z. 10:00Z-12:00Z is the band where BOTH hold
// (UTC-10…-12 against UTC+12…+14) and is the only genuine ambiguity a bucket can carry.
function anchorOffsets(ms: number): number[] {
  const anchor = ((ms % DAY_MS) + DAY_MS) % DAY_MS;
  if (anchor % ZONE_OFFSET_STEP_MS !== 0) return [];
  const west = -anchor;
  const east = DAY_MS - anchor;
  const offsets: number[] = [];
  if (west >= MIN_ZONE_OFFSET_MS) offsets.push(west);
  if (east <= MAX_ZONE_OFFSET_MS) offsets.push(east);
  return offsets;
}

function dayAt(ms: number, offsetMs: number): string {
  return new Date(ms + offsetMs).toISOString().slice(0, 10);
}

/**
 * The day a Health Connect day bucket names, or `null` when this window is not one.
 *
 * GATED ON `isSupersedingWindow`, AND THE GATE IS THE SAFETY. The same four metrics
 * arrive as MINUTE buckets at a `1m`/`15m` exporter setting, and a 15-minute window
 * starting 14:00Z would "imply" UTC+10 and file a New York afternoon on tomorrow. Only
 * a window the rule already reads as a device-cut day bucket states an anchor.
 *
 * `profileOffsetMs` BREAKS THE ONE AMBIGUITY and nothing else. In the 10:00Z-12:00Z
 * band the anchor is equally a UTC-10…-12 midnight and a UTC+12…+14 one, so the window
 * states nothing and the profile decides — by its own DAY, not by offset distance; see
 * the body. Outside that band the argument is unused, so a wrong or stale zone cannot
 * move a day.
 */
export function anchorImpliedDay(
  metric: string,
  startedAt: string,
  endedAt: string,
  profileOffsetMs: number
): string | null {
  const ms = instantMs(startedAt);
  if (ms === null || !isSupersedingWindow(metric, startedAt, endedAt)) {
    return null;
  }
  const offsets = anchorOffsets(ms);
  if (offsets.length === 0) return null;
  if (offsets.length === 1) return dayAt(ms, offsets[0]);
  // THE AMBIGUOUS BAND, WHERE THE ANCHOR IS SILENT AND THE PROFILE IS THE ONLY EVIDENCE.
  // Both candidate days are equally consistent with a 10:00Z-12:00Z anchor, so the window
  // carries nothing the profile does not — and deferring to the profile's own DAY is
  // therefore never worse than the derivation this replaced, and sometimes a whole day
  // better.
  //
  // NEAREST OFFSET IS THE WRONG METRIC, and reaching for it cost a review round (#3924).
  // Five hours of offset difference can be a one-day date difference: a completed
  // Honolulu 08-25 bucket (10:00Z) arriving against a profile already on Tokyo time sits
  // 5h from +14 and 19h from -10, so nearest-offset filed it on 08-26 — where the genuine
  // JST bucket superseded it and 08-25 kept nothing. That is this issue's own loss,
  // reintroduced by its own fix, and `anchorRefusesDay` is structurally blind to it
  // because 08-26 IS one of the two admissible days.
  const profileDay = dayAt(ms, profileOffsetMs);
  const days = offsets.map((o) => dayAt(ms, o));
  if (days.includes(profileDay)) return profileDay;
  // Neither candidate is the profile's day: the profile lies further west than the
  // anchor's own west representative (only reachable at a 10:00Z or 11:00Z anchor).
  // Nothing points at a day, so fall back to the nearer offset, which points west with
  // the profile — the direction the device is likeliest to be.
  const offset = offsets.reduce((best, o) =>
    Math.abs(o - profileOffsetMs) < Math.abs(best - profileOffsetMs) ? o : best
  );
  return dayAt(ms, offset);
}

/**
 * Does this bucket's own anchor CONTRADICT the day the store filed it under (#3901)?
 *
 * The defence in depth behind the derivation above, and the reason it is worth having a
 * second reader: with the derivation correct this can never be true, so if it ever is,
 * something has mislabeled a bucket — and the incoming row then WRITES (a double count,
 * visible in every total and counted in `overlapsLeft`) while deleting nothing. The next
 * attribution bug is a day reading high, not a day with a hole in it.
 *
 * IT TAKES NO ZONE, deliberately. In the ambiguous band a bucket has two admissible
 * days, and a guard that picked between them from the profile's CURRENT zone would fire
 * on a legitimate Honolulu bucket the moment the person's profile reached Tokyo. Either
 * admissible day is consistent with the anchor, so either one is accepted, and an anchor
 * that implies nothing at all refuses nothing.
 */
export function anchorRefusesDay(startedAt: string, date: string): boolean {
  const ms = instantMs(startedAt);
  if (ms === null) return false;
  const offsets = anchorOffsets(ms);
  return offsets.length > 0 && !offsets.some((o) => dayAt(ms, o) === date);
}

/**
 * WHEN THE COLUMN STARTED BEING WRITTEN, AND WHAT WAS ALREADY IN THE TABLE.
 *
 * Recorded once by `20260821-hc-overlap-supersede` and never moved again. It is the
 * only thing that licenses deleting a NULL-stamped row — see the header, which is also
 * where the difference between these two halves is spelled out:
 *
 *   - `lastUnstampedId` is `MAX(metric_samples.id)` at that instant, and comparing
 *     against it is EXACT. The column is `INTEGER PRIMARY KEY AUTOINCREMENT`
 *     (migration 083): monotonic, never reused, so `id <= lastUnstampedId` cannot become
 *     true for a row written later.
 *   - `startedAt` is the instant the migration ran, ON THIS SERVER'S CLOCK, and the
 *     stamp it is compared against comes from a PHONE. That comparison is therefore not
 *     exact — it is a cross-clock one, bounded in the direction that matters and failing
 *     toward keeping rows: a phone behind the server collapses none of its own pre-era
 *     NULLs until real time passes the offset.
 */
export interface UnstampedEra {
  startedAt: string;
  lastUnstampedId: number;
}

// The two app-global `settings` keys the era is written to. They live HERE, in the
// db-free rule module, because the migration that WRITES them and the reader that
// consumes them must not be able to drift apart — and the migration cannot import the
// reader, which reaches the settings table through `@/lib/db`.
export const UNSTAMPED_ERA_AT_KEY = "hc_overlap_unstamped_era_at";
export const UNSTAMPED_ERA_MAX_ID_KEY = "hc_overlap_unstamped_era_max_id";

/**
 * May the push carrying an incoming row supersede this stored row, on freshness?
 *
 * THREE STATES, not two.
 *
 *   - The stored row HAS a stamp: the plain comparison. Strictly newer wins, so a
 *     replay (same stamp) and a second chunk of the same push (same stamp) take nothing.
 *   - The stored row's stamp is NULL and it is one of the rows the migration SAW
 *     (`id <= era.lastUnstampedId`, an exact statement about this database's own id
 *     counter), and this push SAYS it happened after the migration
 *     (`incoming > era.startedAt`, a phone stamp against a server instant — see the
 *     header, and note it is the cross-clock half): superseded. That is the pre-PR
 *     double count the fix exists to collapse.
 *   - The stored row's stamp is NULL and either half is unproven: NOT superseded. NULL
 *     means UNKNOWN. A row whose provenance the store cannot establish is not a row this
 *     path may delete, so the double count stays — visible and counted, and it stays for
 *     good: a stored NULL never becomes non-NULL and the era markers never grow, so no
 *     later push can reach it either. What visible buys is a day that reads HIGH beside
 *     a stored row still holding the right number, not a repair that is coming.
 *
 * An unreadable or absent INCOMING stamp is refused outright in every state: a push that
 * cannot say when it happened gets to delete nothing.
 */
export function pushOutranks(
  incomingPushedAt: string | null | undefined,
  stored: Pick<MetricWindow, "id" | "pushed_at">,
  era: UnstampedEra | null
): boolean {
  const incoming = instantMs(incomingPushedAt);
  if (incoming === null) return false;
  const storedMs = instantMs(stored.pushed_at);
  if (storedMs !== null) return incoming > storedMs;
  if (era === null) return false;
  const eraMs = instantMs(era.startedAt);
  if (eraMs === null) return false;
  if (!Number.isFinite(stored.id) || stored.id > era.lastUnstampedId)
    return false;
  return incoming > eraMs;
}

// HOW FAR AHEAD OF THIS MACHINE'S CLOCK A PUSH MAY CLAIM TO HAVE HAPPENED.
//
// The stamp comes from a phone, and a phone's clock can be wrong. A stamp far in the
// future is written onto the rows that push stores, and every later HONEST push then
// reads as older than them - so nothing can ever supersede those rows again. Bounding
// it keeps that to a bad hour rather than forever.
//
// The unit is milliseconds of real time, and the bound is deliberately generous: this
// is not a clock-sync check, it is a "that cannot be a push" check. A device several
// hours ahead is still believed; a device claiming next week is not.
//
// It reads the SERVER clock, which nothing else in this module does - and that is safe
// in the one direction that matters, because failing this check yields NO STAMP, and no
// stamp means no supersede. It can only ever make this path delete less.
export const MAX_PUSH_CLOCK_SKEW_MS = 12 * 60 * 60 * 1000;

/**
 * The stamp to record on every row of one push, and to compare a future push against.
 *
 * ONLY what the exporter stated (`ParsedPayload.pushedAt`, from `payload.timestamp`).
 * There is no window-derived fallback and there must not be one: see the header. A push
 * that states no readable instant gets `null`, and a null stamp supersedes nothing.
 *
 * RETURNED CANONICAL (`utcInstant`), never in the spelling it arrived in: `pushed_at` is
 * a new column and there is no reason for it to be born `mixed`. The cost is second
 * resolution - two pushes inside ONE second compare equal, so the later supersedes
 * nothing and the double count waits for the push after it, which is the safe direction.
 */
export function pushStampFor(
  stated: string | null | undefined,
  now: Date = new Date()
): string | null {
  const ms = instantMs(stated);
  if (ms === null) return null;
  if (ms > now.getTime() + MAX_PUSH_CLOCK_SKEW_MS) return null;
  return utcInstant(new Date(ms));
}

/**
 * Plan what an INCOMING window does to the stored rows it overlaps.
 *
 * `incoming` IS A ROW THE STORE ALREADY HOLDS, in the one caller that matters: the row
 * this push wrote, read back inside the transaction that will do the deleting. Nothing
 * about that changes the decision below, which is why this function is unchanged by the
 * ruling that moved it - it was always a statement about two windows and two stamps.
 *
 * `stored` is the candidate set for one (profile, metric, source, origin) group, already
 * narrowed to the incoming row's own `date` and with every row THIS push wrote excluded
 * - the caller (`supersedeMetricSampleOverlaps`) owns that exclusion, spelled
 * `pushed_at IS NOT ?`, and it is what keeps two rows of one push from being each
 * other's victims. This function just decides.
 *
 * THE `date` TERM IS STATED HERE TOO, and that is not a redundancy with the caller's
 * SQL: it is the two-encodings discipline this module is built on. SQL NARROWS on the
 * indexed prefix; THIS FILE DECIDES. A reader who widens the SQL - to report more, to
 * chase an index - must not thereby widen what gets DELETED, and
 * lib/__db_tests__/hc-overlap-supersede.test.ts pins the two encodings against each
 * other on a store the narrowing genuinely narrows.
 *
 * A stored row is superseded when ALL of these hold: it is filed under the incoming
 * row's own `date` (COVER THE DAY - see the header, and note it decides `left` as well
 * as `supersede`); the incoming window is a day-bucket window of a tiling metric; the
 * two overlap as instants; the STORED window is itself a day-bucket window; the incoming
 * PUSH outranks the one that wrote the stored row (`pushOutranks`, which is where a NULL
 * stamp is read as UNKNOWN rather than as old); and the #133 lock does not protect it.
 *
 * `locked` is every overlapped row the edit lock held out, reported rather than dropped.
 *
 * `left` IS THE ROWS, NOT A TALLY OF LOOKS AT THEM. Every stored day bucket this
 * incoming row overlapped and did not collapse, whatever the reason - so the caller can
 * union them across the whole push and count DISTINCT rows. Counting pairs said "2 daily
 * totals" when two incoming buckets declined over ONE stored row, which is not what the
 * Review line it feeds claims to be counting. `locked` rows are in both lists: the lock
 * is one of the reasons a day is still double counted.
 *
 * WHICH OVERLAPS ARE COUNTED, AND THE ONE THAT IS NOT. An overlap goes into `left` when
 * EITHER side is a day bucket. That admits the two shapes that are otherwise silent -
 * a stored sub-daily bucket the rule may never collapse (permanent, full stop), and a
 * fine-grained incoming row landing on a stored day bucket - and excludes the one shape
 * where an overlap is not a double count at all: two devices that set no
 * `metadata.data_origin` both parse to `origin = null` and their MINUTE buckets share a
 * group, where an overlap is two readings being legitimately summed. The remaining
 * over-report is a `daily` device and a `1m` device sharing `origin = null`; that warns
 * where it need not, which is the cheaper error than a permanently wrong day nothing
 * mentions.
 *
 * NOTHING HERE WITHHOLDS A WRITE, and that is a rule rather than an omission. An
 * earlier version also reported the stored rows the incoming row was NOT newer than,
 * and the caller DROPPED the incoming row instead of storing it, so that a replay
 * would be inert rather than merely harmless. It made this path able to LOSE a
 * reading, silently: a dropped row was counted `unchanged`, which Review renders as
 * "nothing new", muted. The most a stale row may now do is sit beside the fresh one
 * as a double count, which is visible in every total and which the next stamped push
 * collapses.
 */
export function planSupersede(
  incoming: {
    metric: string;
    /** The profile-local day this row is filed under — the unit the rule protects. */
    date: string;
    started_at: string;
    ended_at: string;
    pushedAt?: string | null;
  },
  stored: readonly MetricWindow[],
  era: UnstampedEra | null = null
): { supersede: MetricWindow[]; locked: MetricWindow[]; left: MetricWindow[] } {
  const supersede: MetricWindow[] = [];
  const locked: MetricWindow[] = [];
  // Overlapping stored day buckets this row did NOT replace, for ANY reason. A double
  // count left standing, which the caller surfaces rather than leaving to be noticed.
  const left: MetricWindow[] = [];
  // Nutrition and sleep nest legitimately, so nothing about them is an anomaly and
  // nothing about them is reportable either.
  if (!isDayBucketMetric(incoming.metric)) return { supersede, locked, left };
  const incomingIsBucket = isSupersedingWindow(
    incoming.metric,
    incoming.started_at,
    incoming.ended_at
  );
  // THE ANCHOR GUARD (#3901), and it is a fact about the INCOMING ROW, so it is asked
  // once. A day bucket states its own day in `started_at`; if the store filed it
  // somewhere else, the row is mislabeled and may not delete a neighbour on the strength
  // of a label that is wrong. It still WRITES — the day reads high, `overlapsLeft` says
  // so, and the next correctly-filed push collapses it. That is the direction this whole
  // file resolves in: a visible double count over a hole nobody can refill.
  const anchorContradictsDate =
    incomingIsBucket && anchorRefusesDay(incoming.started_at, incoming.date);
  for (const row of stored) {
    // COVER THE DAY, AND IT IS THE FIRST THING ASKED because everything below is about
    // rows that are already on one date. A stored row may only be collapsed by a row
    // filed under ITS OWN `date` — the unit `getMetricDailyTotals` sums by, and the unit
    // a person reads. See the header: this is the whole of the ruling, and it is why the
    // date-mismatched candidate is not counted in `left` either. Two rows on different
    // dates never sum into one day, so the pair is not a double count to report.
    if (row.date !== incoming.date) continue;
    if (
      !windowsOverlap(
        incoming.started_at,
        incoming.ended_at,
        row.started_at,
        row.ended_at
      )
    ) {
      continue;
    }
    const storedIsBucket = isDayBucketWindow(row.started_at, row.ended_at);
    // Two fine-grained windows overlapping is two devices being summed, not a double
    // count — see the docstring. Nothing to do and nothing to say.
    if (!incomingIsBucket && !storedIsBucket) continue;
    // A stored row cut at sub-daily granularity is not a bucket this rule may collapse,
    // whatever the incoming row looks like — and it is the one residual that NO later
    // push repairs, so it is the one that most needs saying out loud.
    if (!storedIsBucket) {
      left.push(row);
      continue;
    }
    // A fine-grained incoming row cannot collapse anything either, but it does land on
    // top of a stored day bucket, and that day reads high until something else moves.
    if (!incomingIsBucket) {
      left.push(row);
      continue;
    }
    // The payload's own account of which push is newer, with a NULL stored stamp read
    // as UNKNOWN. A replay, or a second chunk of the SAME push, does not outrank, so it
    // takes nothing. It is still WRITTEN — see the note above about never withholding.
    if (!pushOutranks(incoming.pushedAt, row, era)) {
      left.push(row);
      continue;
    }
    // The incoming row's own anchor says it does not belong to this date, so its claim
    // to outrank a row that does is worth nothing. Counted in `left`: two rows are still
    // summing into one day, which is exactly what that number reports.
    if (anchorContradictsDate) {
      left.push(row);
      continue;
    }
    // The #133 lock, spelled as the #608 sweep spells it: NULL is "not locked".
    if (row.edited) {
      locked.push(row);
      left.push(row);
    } else supersede.push(row);
  }
  return { supersede, locked, left };
}
