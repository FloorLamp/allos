// Adherence over a rolling window of daily states, ordered oldest-first (the
// last element is today). Consumed by the intake surfaces to summarize each
// item's recent adherence as a percentage + day counts instead of a per-day
// dot strip.
//
// THERE IS NO STREAK HERE ANY MORE (#1936, owner-decided). The "🔥 Nd" figure this
// module used to expose measured continuity of app-logged behavior rather than
// health, and it had a CLIFF where the percentage beside it degrades gracefully: a
// paused item, an illness episode, a travel week, or a single deliberate skip
// (#232) reset it to zero, which is precisely what the rest of the dose machinery
// is built to accommodate without judgment. The percentage already answers "am I
// consistent?", and a missed day nudges it instead of zeroing it.

import type { IntakeItem } from "./types";
import { isDueOn } from "./intake-schedule";
import { doseOnDay, type DoseCadence } from "./intake-cadence";
import { dateStrInTz, parseUtcSql } from "./date";

// How many days the per-item adherence strip spans (the intake surfaces and
// any windowed-history consumer share the window length).
export const STRIP_DAYS = 14;

// How far back a LIST surface shows recorded administrations in its per-item dose
// history panel (#1933). Longer than the strip on purpose — the strip answers "how has
// this been going", the history panel is where a specific wrong entry gets corrected,
// and the entry you want to fix is often older than two weeks. It is a display bound
// only: the historical-dose write path refuses the future and imposes no lookback, so
// a backfill still reaches any past date.
export const DOSE_HISTORY_DAYS = 90;

// "skipped" (issue #232) is a DELIBERATE decision, distinct from "missed" (a
// lapse): it is excluded from the adherence denominator, like "na" — it is neither
// follow-through nor a lapse.
//
// "excused" (issue #3263) is the THIRD thing that is not a lapse, and the one a
// clock cannot tell from one: the dose's slot never occurred, because a timezone
// switch jumped the profile's own wall clock over it. A missed dose and an
// impossible dose look identical to arithmetic and must never look identical to the
// person, so it is its own state rather than a quiet subtraction — out of the
// denominator like "skipped", but named, counted and legended on its own line.
export type AdherenceState =
  "taken" | "partial" | "skipped" | "missed" | "excused" | "na";

// Whether a dose's slot never occurred on a profile-local day, keyed by the dose's
// raw `time_of_day` column. Structural on purpose: the resolver that answers it
// reads settings (lib/travel-excusal.ts), and this module stays pure.
export type SlotExcusedPredicate = (
  timeOfDay: string | null,
  date: string
) => boolean;

const NOTHING_EXCUSED: SlotExcusedPredicate = () => false;

// What a day's dose COUNTS can resolve to. Neither "na" (that is a question about
// dueness, decided before any counting) nor "excused" (that is a question about the
// profile's own wall clock, which counts cannot see) is reachable from a tally —
// so the reducer over tallies says so in its type instead of carrying two cases
// nothing can produce.
export type CountedDoseDayState = Exclude<AdherenceState, "na" | "excused">;

export interface AdherenceDot {
  date: string;
  state: AdherenceState;
}

export interface AdherenceSummary {
  // Percent of due days taken over the window (0–100), with partial days
  // counting as half. Skipped days are excluded from the denominator (adherence
  // measures follow-through on INTENDED doses).
  //
  // NULL is the NO-HISTORY state, and the boundary is load-bearing (#1442): null
  // means no applicable dose-slot has elapsed in the window at all — the item was
  // added moments ago, or is never due here — so there is nothing to have followed
  // through on and every surface must say so (or say nothing) rather than print a
  // number. A real 0 means slots DID elapse and none were taken; that honest zero
  // is preserved. Feeding this a lifetime-clamped strip (intakeAdherenceStrip)
  // is what keeps the two apart — an unclamped fixed-lookback window manufactures
  // pre-existence "misses" and turns every cold start into 0%.
  pct: number | null;
  takenDays: number;
  partialDays: number;
  // Deliberately-skipped days, surfaced as their own count rather than folded
  // into the percentage (#232).
  skippedDays: number;
  // Days every due dose was EXCUSED on — a travel switch skipped the wall clock
  // they sat at (#3263). Its own count for the same reason "skipped" has one: the
  // percentage must not be the only place the reader can find out why a day is
  // missing from it.
  excusedDays: number;
  applicableDays: number;
}

export interface AdherenceSummaryVisibility {
  show: boolean;
  showDetail: boolean;
  showSkipped: boolean;
}

// Resting supplement rows should surface adherence only when it carries signal: an
// imperfect follow-through rate or a deliberate skip. Medication surfaces retain
// the full summary by using the default mode. Pure so the UI threshold stays
// explicit and pinned.
//
// `show` used to OR in a long-enough streak (#1936). With that reason gone, a row
// visible ONLY because of its streak falls back to its ordinary rendering — it does
// not vanish, because nothing about the row changed except that one chip.
export function adherenceSummaryVisibility(
  summary: AdherenceSummary,
  noteworthyOnly = false
): AdherenceSummaryVisibility {
  const showSkipped = summary.skippedDays > 0;
  const showDetail =
    summary.pct !== null &&
    (!noteworthyOnly || summary.pct < 100 || showSkipped);
  return {
    show: showDetail || showSkipped,
    showDetail,
    showSkipped,
  };
}

// Roll one item-day's per-dose outcomes into a single strip state (#232).
// `total` is the number of doses due that day; `takenN`/`skippedN` how many were
// taken / deliberately skipped. A day where every due dose is resolved as a skip
// (and none missed) is itself "skipped"; any taken dose makes it taken/partial;
// otherwise it's a real miss. Pure so the page and any other surface share it.
export function aggregateDoseDay(
  total: number,
  takenN: number,
  skippedN: number
): CountedDoseDayState {
  const due = Math.max(total, 1);
  if (takenN >= due) return "taken";
  if (takenN > 0) return "partial";
  // Every due dose resolved as a deliberate skip (none taken, none left missed).
  if (skippedN >= due) return "skipped";
  return "missed";
}

// A per-dose lookup of which dates were taken vs deliberately skipped (#232),
// keyed by dose id. Both intake surfaces and the notifier build these from
// getIntakeLogsInRange and feed them into doseStrip.
export interface DoseDateStatus {
  taken: Set<string>;
  skipped: Set<string>;
}

// Group per-dose log rows (each carrying a status) into taken/skipped date sets
// keyed by dose id. Rows without a status default to "taken" (a pre-#232 log).
export function indexTakenByDose(
  rows: { dose_id: number; date: string; status?: "taken" | "skipped" }[]
): Map<number, DoseDateStatus> {
  const byDose = new Map<number, DoseDateStatus>();
  for (const { dose_id, date, status } of rows) {
    const entry =
      byDose.get(dose_id) ??
      ({
        taken: new Set<string>(),
        skipped: new Set<string>(),
      } as DoseDateStatus);
    (status === "skipped" ? entry.skipped : entry.taken).add(date);
    byDose.set(dose_id, entry);
  }
  return byDose;
}

// Build one dose's adherence strip over `dates` (oldest-first): "na" on days the
// dose wasn't due, "taken" when it was logged taken, "skipped" on a deliberate
// skip (#232), otherwise "missed". `skippedDates` is optional so older callers
// (taken-only) keep working. Pure so the notifier can summarize a single dose's
// streak/percentage without the page's per-item aggregation.
export function doseStrip(
  dates: string[],
  isDue: (date: string) => boolean,
  takenDates: Set<string>,
  skippedDates: Set<string> = new Set(),
  // A day this dose's slot never occurred on (#3263). Checked AFTER the log sets:
  // a dose somebody logged is taken whatever the clock did to its slot, and only an
  // unanswered slot can be excused.
  isExcused: (date: string) => boolean = () => false
): AdherenceDot[] {
  return dates.map((date) => ({
    date,
    state: !isDue(date)
      ? "na"
      : takenDates.has(date)
        ? "taken"
        : skippedDates.has(date)
          ? "skipped"
          : isExcused(date)
            ? "excused"
            : "missed",
  }));
}

// The calendar day (in the profile's timezone) a dose first EXISTED — the later of
// the parent item's creation and the dose's own — or null when neither timestamp is
// stored. This is the lower bound of the window a dose can be JUDGED over (#430,
// #1442): a fixed 14/35/56-day lookback reaches back before the item was ever added,
// and every one of those days would otherwise score as a "missed" dose. That is how
// a medication quick-added seconds ago read "0% adherence" — thirteen phantom misses
// against a med that had never had a slot come due (#1442, the #1433 cold-start
// mislabeling class).
//
// Deliberately NOT doseAdherenceSince (lib/adherence-patterns.ts), its re-time-aware
// sibling: the pattern engine ALSO restarts its window at a dose's `updated_at`
// because it infers a claim about the dose's CURRENT slot ("you miss the evening
// dose on Fridays"), and re-accusing a re-timed dose for the weeks it sat in its old
// slot would be wrong. A history strip/percentage asks the narrower question — when
// did this dose exist at all — and must keep showing the days it really was taken in
// its old slot. Two questions, two bounds, both pinned.
//
// The timestamps are UTC SQL ("YYYY-MM-DD HH:MM:SS"); `tz` converts them to the
// profile's calendar day so the bound lines up with the `dates` window (which is
// profile-local). Without that conversion the boundary is off by a day for every
// profile whose offset crosses midnight — an item added at 08:00 in UTC+9 would land
// on "yesterday" and reintroduce exactly the phantom miss this bound removes.
export function doseExistsSince(
  itemCreatedAt: string | null | undefined,
  doseCreatedAt: string | null | undefined,
  tz: string
): string | null {
  const dayOf = (t: string | null | undefined): string | null => {
    const d = parseUtcSql(t);
    return d ? dateStrInTz(tz, d) : null;
  };
  const candidates = [dayOf(itemCreatedAt), dayOf(doseCreatedAt)].filter(
    (d): d is string => d != null
  );
  if (candidates.length === 0) return null;
  // The LATEST bound wins: a dose added to an existing item starts its own clock,
  // and a dose can never predate the item it hangs off.
  return candidates.reduce((a, b) => (a >= b ? a : b));
}

// The first day of the window a dose may be JUDGED over — `doseExistsSince`, widened
// backwards by the dose's own logged history.
//
// A log row is PROOF the dose existed on its date, and it can legitimately predate
// `created_at`: the row's timestamp records when it was WRITTEN, not when the person
// started the medication. A med reconciled off an imported document, a course
// re-entered after a profile move, or a backfilled history all land as a same-day
// `created_at` carrying weeks of real adherence — and clamping those days away would
// blank a history the user actually has. So the bound takes the EARLIER of the two,
// which keeps both halves honest: hard evidence of the dose's existence always
// extends the window, and its absence (the cold start) never does.
export function doseWindowSince(
  itemCreatedAt: string | null | undefined,
  doseCreatedAt: string | null | undefined,
  status: DoseDateStatus | undefined,
  tz: string
): string | null {
  const exists = doseExistsSince(itemCreatedAt, doseCreatedAt, tz);
  if (exists == null) return null; // no bound at all — the whole window is in scope
  let earliest = exists;
  for (const set of [status?.taken, status?.skipped]) {
    if (!set) continue;
    for (const date of set) if (date < earliest) earliest = date;
  }
  return earliest;
}

// The doses `intakeAdherenceStrip` scores, carrying the lifetime timestamp the
// window is clamped to. `created_at` is optional so a fixture (or a caller with only
// ids) still type-checks — an absent timestamp simply means "no known lower bound",
// the pre-#1442 behavior.
export interface AdherenceStripDose extends DoseCadence {
  id: number;
  created_at?: string | null;
  // The dose's own free-text slot ("Morning", "with dinner", "08:00"), read by the
  // travel excusal to place it on a clock (#3263). Optional so a fixture with only
  // ids still type-checks — an absent value simply cannot be excused.
  time_of_day?: string | null;
}

// Per-item windowed adherence strip (issue #313, extracted from the intake
// page). Over `dates` (oldest-first), aggregate an item's doses into one state
// per day: "na" on days it isn't due (its condition + that date's workout context),
// else `aggregateDoseDay` over how many of its doses were taken vs deliberately
// skipped on that date. The per-day workout context comes from `workoutDays` (a set
// of the dates that had activity) so a workout/rest-day item's due-ness varies
// across the window. `situationsOn` resolves which situations were active ON EACH
// PAST DAY (#654) — NOT one snapshot of "now" — so a situational item scores "na" on
// days its situation was inactive and only "due" once it actually turned on (see
// situationHistoryResolver). `takenByDose` is the per-dose taken/skipped index from
// `indexTakenByDose`. `lib/household.intakeAdherenceToday` is the today-only
// sibling; this is the windowed version a weekly recap or history surface wants.
//
// The window is clamped to each dose's LIFETIME (#430/#1442): a day is scored only
// against the doses that already existed on it (doseExistsSince), and a day where
// NONE did — including an item carrying no live dose row at all — is "na", not a
// miss. Nothing existed to take, so there is no follow-through to measure, and the
// percentage summarizing the strip reads "no history yet" (pct null) instead of the
// maximally-wrong 0%. `tz` resolves the UTC creation timestamps onto the same
// profile-local calendar the `dates` window is built from.
export function intakeAdherenceStrip(
  item: IntakeItem,
  doses: readonly AdherenceStripDose[],
  dates: string[],
  workoutDays: ReadonlySet<string>,
  situationsOn: (date: string) => Set<string>,
  takenByDose: Map<number, DoseDateStatus>,
  tz: string,
  // Travel (#3263): which of this item's doses had their slot jumped over on a
  // given profile-local day. Defaults to "none were", which is every profile that
  // has never switched zones — the pre-#3263 behaviour, unchanged.
  isExcused: SlotExcusedPredicate = NOTHING_EXCUSED
): AdherenceDot[] {
  const lifetimes = doses.map((d) => ({
    id: d.id,
    dose: d,
    since: doseWindowSince(
      item.created_at,
      d.created_at,
      takenByDose.get(d.id),
      tz
    ),
  }));
  return dates.map((date) => {
    // Only the doses that existed on this day can be taken or missed — so they
    // also set the day's denominator (a second dose added last week must not
    // retroactively demote every earlier fully-taken day to "partial").
    //
    // The CALENDAR narrows the same denominator (#1602). A dose row is counted on a
    // day only when the row itself lands there — its own weekday subset and validity
    // window — so an alternating-amount pair contributes ONE expected dose per day
    // rather than two, and a taper's expired window stops counting without its history
    // being touched. This is the #430 builder-input-layer failure class: get the
    // denominator wrong and every percentage above it is confidently wrong.
    const live = lifetimes.filter(
      (d) => (d.since == null || date >= d.since) && doseOnDay(d.dose, date)
    );
    if (live.length === 0) return { date, state: "na" };
    // "na", not "missed", on an off-cadence day: nothing was expected, so there is no
    // follow-through to measure. A weekly med taken on its one day reads 100%, not 1/7.
    const applicable = isDueOn(item, {
      date,
      isWorkoutDay: workoutDays.has(date),
      activeSituations: situationsOn(date),
    });
    if (!applicable) return { date, state: "na" };
    // TRAVEL NARROWS THE SAME DENOMINATOR (#3263), the way the calendar does
    // (#1602) and for the same reason: get the denominator wrong and every
    // percentage above it is confidently wrong. A dose whose slot the profile's own
    // wall clock jumped over is dropped from the day's count — but only while it is
    // UNANSWERED. A dose logged taken or skipped on that date was taken or skipped,
    // and no clock arithmetic gets to overrule the log.
    const counted = live.filter((d) => {
      const status = takenByDose.get(d.id);
      if (status?.taken.has(date) || status?.skipped.has(date)) return true;
      return !isExcused(d.dose.time_of_day ?? null, date);
    });
    // Every due dose excused: the day asked nothing of this person, so it is not a
    // miss and not merely "not due" — it is named, so the reader can see why the
    // day is absent from the percentage.
    if (counted.length === 0) return { date, state: "excused" };
    const takenN = counted.reduce(
      (n, d) => n + (takenByDose.get(d.id)?.taken.has(date) ? 1 : 0),
      0
    );
    const skippedN = counted.reduce(
      (n, d) => n + (takenByDose.get(d.id)?.skipped.has(date) ? 1 : 0),
      0
    );
    return { date, state: aggregateDoseDay(counted.length, takenN, skippedN) };
  });
}

// Drop a trailing "missed" day — today, still pending: nothing logged yet, so it
// should penalize neither the percentage (adherenceSummary) nor the pattern
// detectors (#430.3). A day still in progress reads as "missed" all day otherwise,
// which can tip a boundary (a false Friday miss viewed Friday morning). Both the
// intake summary and the pattern builder share this ONE guard so the
// pattern window and the strip it summarizes can't disagree about "today". Pure.
export function stripWithoutTrailingPending(
  strip: AdherenceDot[]
): AdherenceDot[] {
  const i = trailingPendingIndex(strip);
  return i < 0 ? strip : strip.slice(0, i);
}

// The index of that still-pending trailing day, or -1 when the strip has none. The
// EXTRACTED core of the guard above (#2796), for the consumer that must not drop the
// day but must not score it either: a month calendar has a cell for today, and
// removing it makes today vanish from the grid while the page beside it is still
// offering "Mark taken". The calendar renders this index as its own neutral "pending"
// state instead. Both readings come from this ONE rule, so the summary's denominator
// and the calendar's legend cannot disagree about which day is unsettled.
//
// Positional, like the guard it came from: the caller's window must END at the
// profile's today (`lastNDates(today(profileId), n)` builds exactly that), which is
// the same contract adherenceSummary already relies on.
export function trailingPendingIndex(strip: readonly AdherenceDot[]): number {
  const n = strip.length;
  return n > 0 && strip[n - 1].state === "missed" ? n - 1 : -1;
}

/**
 * The days a backfill may be OFFERED for, newest first (#3674) — read straight off
 * the strip the card already renders, never derived again (#3369's query budget,
 * #221's one-computation rule).
 *
 * ONLY `missed`. A `skipped` day is a decision and an `excused` day is an
 * impossibility (#232/#3263); offering either would ask someone to correct a record
 * that is already right. A trailing `missed` today is not a lapse either — it is a
 * day still in progress, which is why `adherenceSummary` drops it from the
 * denominator — so the same `trailingPendingIndex` keeps it out of the offer.
 */
export function missedDoseDays(strip: readonly AdherenceDot[]): string[] {
  const pending = trailingPendingIndex(strip);
  const days: string[] = [];
  for (let i = strip.length - 1; i >= 0; i -= 1) {
    if (i !== pending && strip[i].state === "missed") days.push(strip[i].date);
  }
  return days;
}

export function adherenceSummary(strip: AdherenceDot[]): AdherenceSummary {
  // A trailing "missed" today means today is still pending — nothing logged
  // yet. Drop it so a day still in progress does not penalize the percentage
  // (which would otherwise read it as a miss all day).
  const settled = stripWithoutTrailingPending(strip);

  // "skipped" days are a decision, not an intended dose — excluded from the
  // denominator (alongside "na"), but surfaced as their own count (#232).
  const skippedDays = settled.filter((d) => d.state === "skipped").length;
  // "excused" days leave the denominator too (#3263) — the dose was impossible, not
  // declined and not lapsed — and are counted separately for the same reason.
  const excusedDays = settled.filter((d) => d.state === "excused").length;
  const applicable = settled.filter(
    (d) => d.state !== "na" && d.state !== "skipped" && d.state !== "excused"
  );
  const applicableDays = applicable.length;
  const takenDays = applicable.filter((d) => d.state === "taken").length;
  const partialDays = applicable.filter((d) => d.state === "partial").length;
  // Partial days count as half a taken day toward the percentage.
  const pct =
    applicableDays > 0
      ? Math.round(((takenDays + partialDays * 0.5) / applicableDays) * 100)
      : null;

  return {
    pct,
    takenDays,
    partialDays,
    skippedDays,
    excusedDays,
    applicableDays,
  };
}
