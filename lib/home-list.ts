// HOME'S ONE LIST (#5435 §3.2) — the fixed-seat composer.
//
// Home v2 ranked candidates into four lanes and cut them to a cap, so what a person
// saw at 07:40 was not what they saw at 16:00 and neither was the whole of what was
// owed. v3 replaces the ranking with SEATS: every row kind belongs to one band and one
// place inside it, the order never changes through the day, and what changes through
// the day is only which rows have arrived. This module is that decision, and nothing
// else — it renders nothing, reads no DB and takes no clock of its own.
//
// It composes over the readers that already exist:
//
//   * the shared eligible-action list (`lib/attention.ts`), grouped into one entry per
//     dose slot by `attentionEntries`, which is the model's own answer to "how many
//     things is this person being asked to do" and not a second one;
//   * the day bounds and quiet readings of `lib/open-episode.ts`, so Training, Fast and
//     Period are three renderings of ONE lifecycle question rather than three machines
//     (#5142);
//   * the coaching bus's already-admitted setup findings (`lib/findings.ts`).
//
// It does NOT gather. Everything below is a function of what it was handed.

// The dashboard's view of the attention model: one entry per dose slot. It is a
// READER over the shared list, not ranker vocabulary — no scores, no lanes — so it
// outlives the ranker's deletion (#5435 §8) and moves out of the candidate directory
// with it. Reused rather than reimplemented: "how many things is this person being
// asked to do" must have one answer.
import {
  attentionEntries,
  doseSlotKey,
  itemDoseBucket,
  itemIsActionable,
} from "./dashboard-candidates/attention";
import {
  dashboardAttentionCandidateId,
  dashboardAttentionFactKey,
} from "./dashboard-attention-identity";
import type { Finding } from "./findings";
import { pickNextAppointment } from "./household";
import { TIME_BUCKET_OPENS_AT, type TimeBucket } from "./intake-schedule";
import {
  dayEpisodeState,
  episodeIsOpen,
  episodeState,
  type DayEpisodeState,
  type OpenDayEpisode,
  type OpenEpisode,
  type OpenEpisodeState,
} from "./open-episode";
import type { LocalDay } from "./temporal-types";
import {
  bandForItem,
  compareWithinBand,
  daysUntilDue,
  type UpcomingItem,
} from "./upcoming";

// ── The row contract (#5435 §5.1) ───────────────────────────────────────────────
//
// The ranker's candidate carried fourteen fields; the fixed-order composer needs four
// of them, and the fifth — the typed illness episode group that orders a cockpit's
// members — stays with the cockpit, which is the only thing that reads it. Relevance
// policy, presence and engagement tiers, rank reasons, timing, reading promotion,
// source order, the nav-duplicate flag and the four candidate kinds were all vocabulary
// for deciding which rows won a seat. Nothing wins a seat here; it either has one or is
// not on the page.

export type HomeSubject =
  { scope: "profile"; profileId: number } | { scope: "login" };

export interface HomeRow {
  // The stable identity an e2e locator, a dismissal and a Telegram handoff's scroll
  // target all key on (#5435 §5.2, §6.2). Minted through the shared attention identity
  // helper for every row that projects an Upcoming item, so a Home row and its Upcoming
  // twin can never acquire parallel namespaces.
  id: string;
  // ONE FACT RENDERS ONCE across Current care and Today. The bands below are disjoint by
  // construction — an action is current or it is later, never both — so this is the key
  // that lets a caller prove it rather than a filter that hides a collision.
  factKey: string;
  subject: HomeSubject;
  // Does this row kind apply to this profile at all — life stage, training relevance,
  // and, for a row that is ONLY an offer, write access to the target. Composed rows are
  // filtered on it, exactly as the ranker filtered its candidates; a row whose control
  // is gated but whose FACT stands is applicable and loses only the control (§6.5).
  applicable: boolean;
}

// ── The Later fold (§3.2 band 1) ────────────────────────────────────────────────

// What one row inside the fold IS. Names and windows, and NOTHING that writes: nothing
// on Home pre-logs, the same rule the quick-log sheet keeps (#5211). That is a property
// of this type rather than of the renderer — there is no control to leave out, and no
// `UpcomingItem` riding along to reach one through.
export type HomeLaterContent =
  // A dose slot whose window has not opened yet. `count` is what the fold summarizes
  // ("Evening 3"); the bucket names the slot and carries its own opening minute.
  | { kind: "dose-slot"; bucket: TimeBucket; count: number; opensAt: number }
  // A single action declared for later today, named rather than counted — a lone dose
  // in a slot the model does not group (#5063), which is the only reader that declares
  // a clock window today. Care, follow-up and practice actions carry no time of day in
  // the shared model, so they are current whenever they are due; the day one of them
  // declares a window is the day it arrives here beside the doses.
  | { kind: "action"; name: string; opensAt: number }
  // A dated commitment in the 1–7 day tail, or the one next appointment beyond it.
  | { kind: "commitment"; name: string; on: string | null };

export interface HomeLaterEntry extends HomeRow {
  content: HomeLaterContent;
}

export interface HomeLaterFold {
  // The single folded row. Depth above the Now rule is ALWAYS one row, whatever the
  // schedule (§3.2): six dose slots and a dentist appointment are one line, and so is
  // one slot.
  row: HomeRow;
  entries: readonly HomeLaterEntry[];
}

// ── The Now band (§3.2 band 2) ──────────────────────────────────────────────────

// The seats, in the order they are rendered. A row does not compete for one.
export const HOME_NOW_SEATS = [
  "dose",
  "practice",
  "care",
  "training",
  "fast",
  "period",
] as const;

export type HomeNowSeat = (typeof HOME_NOW_SEATS)[number];

const SEAT_ORDER: Record<HomeNowSeat, number> = {
  dose: 0,
  practice: 1,
  care: 2,
  training: 3,
  fast: 4,
  period: 5,
};

// Training's three states in one day (§3.2). The logged and next arms carry no facts
// here: their detail is the session and the recommendation the caller already holds.
export type HomeTrainingState =
  | { kind: "in-progress"; episode: OpenEpisodeState }
  | { kind: "logged" }
  | { kind: "next" };

// The period row's two states. A CLOSED period is neither: it contributes no row, which
// is why `DayEpisodeState` needs no `finished` arm (see lib/open-episode.ts).
export type HomePeriodState =
  | { kind: "open"; day: number; episode: DayEpisodeState }
  | { kind: "start-offer" };

export type HomeNowContent =
  // A slot's due doses are ONE act at one moment (#5063), so they are one row with its
  // members. `overdue` is why an already-open slot may not sink into the record.
  | {
      kind: "dose-slot";
      bucket: TimeBucket;
      items: readonly UpcomingItem[];
      overdue: boolean;
    }
  | { kind: "item"; item: UpcomingItem }
  | { kind: "training"; state: HomeTrainingState }
  | { kind: "fast"; episode: OpenEpisodeState }
  | { kind: "period"; state: HomePeriodState };

export interface HomeNowRow extends HomeRow {
  seat: HomeNowSeat;
  content: HomeNowContent;
}

export interface HomeNowBand {
  // The profile-local clock the "Now · HH:MM" rule states. Carried so the rule and the
  // rows below it are read off one instant.
  minutesOfDay: number;
  rows: readonly HomeNowRow[];
}

// ── The Setup list (§3.4) ───────────────────────────────────────────────────────

export interface HomeSetupRow extends HomeRow {
  finding: Finding;
}

// ── Inputs ──────────────────────────────────────────────────────────────────────

export interface HomeTrainingInput {
  // A workout draft as an open episode. Its quiet decides whether it is still a session
  // in progress; a draft the model has given up on falls through to the arms below
  // rather than offering End on something nothing will finish.
  live: OpenEpisode | null;
  // A session already recorded on the profile's today. One that ended before midnight
  // belongs to yesterday's record, which the reader resolves.
  loggedToday: boolean;
  // The shared next-workout recommendation exists.
  recommended: boolean;
  // Training relevance for this profile (§5.1's applicable gate).
  applicable: boolean;
}

export interface HomePeriodInput {
  // The open period as a day episode: its start IS its last signal, since the row
  // carries no time column. Null when no period is open.
  episode: OpenDayEpisode | null;
  // The cycle domain's own answer to "may a tap start a period today" — already false
  // under a recorded pregnancy and already false while one is open (`cycleControlState`).
  // Read rather than re-derived: two formulas over one plausibility window is exactly
  // how the hero and the forecast card came to contradict each other.
  canStartToday: boolean;
  // Write access to this profile. The start offer IS a write, so without it there is no
  // row; the open period's day count is a fact and keeps its seat with the End control
  // gated by the caller's existing write-target machinery.
  writable: boolean;
}

export interface HomeListInput {
  // The day being rendered, and the profile's today. The Now rule and the Later fold
  // exist ONLY on today: any earlier day is the plain record (§3.2, §6.6).
  day: LocalDay;
  today: LocalDay;
  // The instant the minute-counted episodes are read against, and the profile-local
  // clock the Now rule states and the dose windows are compared to.
  now: number;
  minutesOfDay: number;
  subject: HomeSubject;
  // The shared eligible-action list, in the model's own order (`buildAttentionModel`):
  // date → priority → domain → dose-day slot → title → key.
  attention: readonly UpcomingItem[];
  // The low-supply cue keys the caller can mount the shared refill action on (#5121).
  // Empty is a complete answer: it means no cue is seated, which is what a surface with
  // no way to offer the action should render.
  refillTargets: ReadonlySet<string>;
  training: HomeTrainingInput;
  fast: OpenEpisode | null;
  period: HomePeriodInput;
}

export interface HomeList {
  later: HomeLaterFold | null;
  now: HomeNowBand | null;
}

// ── Classification ──────────────────────────────────────────────────────────────

// Home's Now band is exact current ACTIONS (§2.2), and "can the person DO this" is
// `itemIsActionable`, imported above. It is the attention model's own predicate, not
// Home's reading of it: one question, one answer, one place it can change.

// A PRACTICE TARGET IS A DUE ACTION IN ITS OWN RIGHT (§3.2). It arrives banded `week`
// because /upcoming plans a week, but the control on it logs a session TODAY, so on
// Home it is current. Its unmet training-scope twin carries no control and stays a
// reading: unmet weekly pace never becomes a newly owed action.
function isPracticeTarget(item: UpcomingItem): boolean {
  return item.practiceLog != null;
}

// A LOW-SUPPLY CUE IS AN ACTION WHOSE CONTROL THE MODEL HAS NO WORD FOR (#5121,
// #5435 §9). `itemIsActionable` asks the item what it can host, and the affordance
// fields it reads are the typed one-taps `UpcomingItem` declares — `doseId`,
// `practiceLog`, `followUpResolve` and the rest. There is no refill field among them,
// so a tracked item that has run out reaches Home as a dated fact with no control and
// is seated nowhere: the page neither states the shortage nor offers the fix, which is
// the gap §9's #5121 row names.
//
// THE CONTROL ALREADY EXISTS AND IS SHARED — the #852 one-tap Refilled over the
// compare-and-set write core that Manage, the medication row and the medication card
// all mount. What was missing is only a SEAT, so the decision is made here, where
// every other seat decision is, rather than by teaching the shared model an affordance
// that /upcoming, the digest, the app badge and the calendar feed would then all have
// to carry.
//
// AN ACTION OR NOTHING (§2.2/§2.4), which is why this asks the CALLER rather than the
// item. `refillTargets` is the set of cue keys the caller can actually mount the
// shared action on; a cue it cannot is not admitted, so this never seats a row whose
// control would be missing. A pooled bottle and a private supply are the same question
// here — both are keyed by the shared minters, and which of them the caller can name
// is the caller's answer, not a second rule in this file.
//
// ELIGIBLE MEANS TODAY (§2.1). A refill still days out is a dated commitment and keeps
// the Later fold's tail, where it already sits with no control; only a cue whose own
// run-out date has arrived is a current action. The item arrives already
// snooze/dismiss-filtered by the shared gather, so "eligible" asks for nothing more.
function isRefillCue(
  item: UpcomingItem,
  refillTargets: ReadonlySet<string>
): boolean {
  return item.domain === "refill" && refillTargets.has(item.key);
}

// Whole days from today to the item's own date. A null date is now, not undated
// forever — the same convention every other reader of this model keeps.
function daysAhead(item: UpcomingItem, today: LocalDay): number {
  return daysUntilDue(item.dueDate, today);
}

function itemName(item: UpcomingItem): string {
  return item.shortLabel ?? item.title;
}

// ── Composition ─────────────────────────────────────────────────────────────────

/**
 * Home's three composed bands for one day.
 *
 * The Later fold and the Now rule exist only on TODAY: any earlier day is the plain
 * record of that day, which owes nothing and forecasts nothing (§3.2, §6.6).
 */
export function composeHomeList(input: HomeListInput): HomeList {
  if (input.day !== input.today) return { later: null, now: null };
  const actions = partitionActions(input);
  return {
    later: composeLater(input, actions),
    now: {
      minutesOfDay: input.minutesOfDay,
      rows: composeNowRows(input, actions),
    },
  };
}

interface PartitionedActions {
  // Current actions, already in seat and model order.
  current: HomeNowRow[];
  // Dose slots whose window has not opened yet, in window order.
  laterToday: HomeLaterEntry[];
  // Dated commitments in the 1–7 day band, in the band's own order.
  commitments: UpcomingItem[];
  // Everything past day 7, from which exactly one appointment is drawn.
  beyond: UpcomingItem[];
}

// The slot a due dose sits in, for the one-member case `attentionEntries` leaves as a
// plain item. A slot's window is its bucket's, whether it holds one dose or six.
function doseBucket(item: UpcomingItem): TimeBucket | null {
  return item.doseId == null ? null : itemDoseBucket(item);
}

function attentionRow(
  input: HomeListInput,
  key: string,
  seat: HomeNowSeat,
  content: HomeNowContent
): HomeNowRow {
  return {
    id: dashboardAttentionCandidateId(key),
    factKey: dashboardAttentionFactKey(key),
    subject: input.subject,
    applicable: true,
    seat,
    content,
  };
}

function partitionActions(input: HomeListInput): PartitionedActions {
  const { today, minutesOfDay } = input;
  const doses: HomeNowRow[] = [];
  const care: HomeNowRow[] = [];
  const laterToday: {
    entry: HomeLaterEntry;
    opensAt: number;
    order: number;
  }[] = [];
  const commitments: UpcomingItem[] = [];
  const beyond: UpcomingItem[] = [];

  // A dose's window is its bucket's whether the model grouped the bucket into a slot or
  // left a lone dose as itself (#5063), so both arms decide the same way and only what
  // they place differs: the slot is counted, the lone dose is named.
  const placeDose = (
    bucket: TimeBucket,
    items: readonly UpcomingItem[],
    key: string,
    order: number,
    later: HomeLaterContent,
    now: HomeNowContent
  ) => {
    const opensAt = TIME_BUCKET_OPENS_AT[bucket];
    // AN OVERDUE DOSE PINS TO NOW whatever its window says (§3.2). One still owed from a
    // window that opened hours ago is the one thing that must not sink into the record,
    // and it is also the one thing a window comparison alone would sink.
    if (
      !items.some((item) => daysAhead(item, today) < 0) &&
      minutesOfDay < opensAt
    ) {
      laterToday.push({
        opensAt,
        order,
        entry: {
          id: dashboardAttentionCandidateId(key),
          factKey: dashboardAttentionFactKey(key),
          subject: input.subject,
          applicable: true,
          content: later,
        },
      });
      return;
    }
    doses.push(attentionRow(input, key, "dose", now));
  };

  for (const entry of attentionEntries(input.attention)) {
    if (entry.kind === "dose-slot") {
      const key = doseSlotKey(entry.bucket);
      const opensAt = TIME_BUCKET_OPENS_AT[entry.bucket];
      placeDose(
        entry.bucket,
        entry.items,
        key,
        entry.sourceIndex,
        {
          kind: "dose-slot",
          bucket: entry.bucket,
          count: entry.items.length,
          opensAt,
        },
        {
          kind: "dose-slot",
          bucket: entry.bucket,
          items: entry.items,
          overdue: entry.items.some((item) => daysAhead(item, today) < 0),
        }
      );
      continue;
    }
    const item = entry.item;
    const bucket = doseBucket(item);
    if (bucket != null) {
      placeDose(
        bucket,
        [item],
        item.key,
        entry.sourceIndex,
        {
          kind: "action",
          name: itemName(item),
          opensAt: TIME_BUCKET_OPENS_AT[bucket],
        },
        { kind: "item", item }
      );
      continue;
    }
    const band = bandForItem(item, today);
    if (band === "week") {
      commitments.push(item);
      continue;
    }
    if (band === "later") {
      beyond.push(item);
      continue;
    }
    // Overdue or due today. Only an ACTION earns a seat under the rule; a dated fact
    // with no control is the record's or the glance card's, stated once there (§2.4).
    if (itemIsActionable(item) || isRefillCue(item, input.refillTargets))
      care.push(attentionRow(input, item.key, "care", { kind: "item", item }));
  }

  // THE PRACTICE TARGET COMES BACK FROM THE MODEL'S OWN LIST. `attentionEntries` drops
  // every weekly floor target because v2 stated them in the Standing cluster and one
  // screen may not say one thing twice. v3 deletes Standing (§4), and of those rows the
  // practice target is the one carrying a CONTROL — the session it logs is today's — so
  // it takes its own seat here. Its training-scope twins do not: they report progress,
  // and progress belongs to the hub (#5198, `isTrainingFrequencyScope` excludes
  // `practice`). Unmet weekly pace never becomes a newly owed action.
  const practice = input.attention
    .filter(isPracticeTarget)
    .map((item) =>
      attentionRow(input, item.key, "practice", { kind: "item", item })
    );

  laterToday.sort((a, b) => a.opensAt - b.opensAt || a.order - b.order);
  commitments.sort((a, b) => compareWithinBand(a, b, today));
  return {
    current: [...doses, ...practice, ...care],
    laterToday: laterToday.map(({ entry }) => entry),
    commitments,
    beyond,
  };
}

function commitmentEntry(
  input: HomeListInput,
  item: UpcomingItem
): HomeLaterEntry {
  return {
    id: dashboardAttentionCandidateId(item.key),
    factKey: dashboardAttentionFactKey(item.key),
    subject: input.subject,
    applicable: true,
    content: { kind: "commitment", name: itemName(item), on: item.dueDate },
  };
}

function composeLater(
  input: HomeListInput,
  actions: PartitionedActions
): HomeLaterFold | null {
  // Beyond the 1–7 day tail Home states ONE thing: the next appointment, chosen by the
  // shared picker every other surface uses (#303), so the horizon cannot grow a second
  // definition of "next".
  const nextAppointment = pickNextAppointment(
    actions.beyond.filter((item) => item.domain === "appointment")
  );
  const entries = [
    ...actions.laterToday,
    ...actions.commitments.map((item) => commitmentEntry(input, item)),
    ...(nextAppointment == null
      ? []
      : [commitmentEntry(input, nextAppointment)]),
  ];
  // Absence is silent (§2.7): nothing later means no row, not an empty one.
  if (entries.length === 0) return null;
  return {
    row: {
      id: "home.later",
      factKey: `home.later:${input.day}`,
      subject: input.subject,
      applicable: true,
    },
    entries,
  };
}

// ── The three state rows, on one lifecycle (#5142) ──────────────────────────────

function stateRow(
  input: HomeListInput,
  name: string,
  seat: HomeNowSeat,
  applicable: boolean,
  content: HomeNowContent
): HomeNowRow {
  return {
    id: `home.${name}`,
    factKey: `home.${name}:${input.day}`,
    subject: input.subject,
    applicable,
    seat,
    content,
  };
}

// A workout draft is a session in progress for exactly as long as the shared reading
// says it is still going. Past that the model has stopped expecting more of it, and
// offering End on a draft nothing will finish is the defect the one lifecycle exists to
// remove — so the row falls through to what the day actually holds.
function trainingState(input: HomeListInput): HomeTrainingState | null {
  const { live, loggedToday, recommended } = input.training;
  if (live != null) {
    const state = episodeState(live, input.now);
    if (episodeIsOpen(state)) return { kind: "in-progress", episode: state };
  }
  if (loggedToday) return { kind: "logged" };
  return recommended ? { kind: "next" } : null;
}

function fastState(input: HomeListInput): OpenEpisodeState | null {
  if (input.fast == null) return null;
  const state = episodeState(input.fast, input.now);
  // Stale is open: a 40-hour fast has outrun its bound and is still a fast only the
  // person may end, so the row and its End keep their seat.
  return episodeIsOpen(state) ? state : null;
}

function periodState(input: HomeListInput): HomePeriodState | null {
  const { episode, canStartToday } = input.period;
  if (episode != null) {
    const state = dayEpisodeState(episode, input.today);
    // The signal day is day 1, so "Period · day N" is the elapsed days plus it. A stale
    // open period still renders: the person is the only one who ends it.
    if (episodeIsOpen(state))
      return { kind: "open", day: state.quietDays + 1, episode: state };
  }
  return canStartToday ? { kind: "start-offer" } : null;
}

function composeNowRows(
  input: HomeListInput,
  actions: PartitionedActions
): HomeNowRow[] {
  const rows = [...actions.current];
  const training = trainingState(input);
  if (training != null)
    rows.push(
      stateRow(input, "training", "training", input.training.applicable, {
        kind: "training",
        state: training,
      })
    );
  const fast = fastState(input);
  if (fast != null)
    rows.push(
      stateRow(input, "fast", "fast", true, { kind: "fast", episode: fast })
    );
  const period = periodState(input);
  if (period != null)
    rows.push(
      stateRow(
        input,
        "period",
        "period",
        // A start offer with no write access is nothing but a refusal; the open
        // period's day count is a fact that stands for a read-only viewer.
        period.kind === "start-offer" ? input.period.writable : true,
        { kind: "period", state: period }
      )
    );
  // Seats, never scores. The sort is stable, so each seat keeps the order its rows
  // arrived in — for the dose and care seats that is the attention model's own.
  return rows
    .filter((row) => row.applicable)
    .sort((a, b) => SEAT_ORDER[a.seat] - SEAT_ORDER[b.seat]);
}

// ── Setup (§3.4) ────────────────────────────────────────────────────────────────
//
// Configuration is not a daily fact (§2.9): these rows say something about the saved
// setup, so they never enter the Later or Now bands and they arrive only through the
// coaching bus's setup tier, already de-dismissed by the caller. The block is absent
// when the bus has nothing — there is no "you're all set" row.
//
// COMPOSED ON ITS OWN, not inside `composeHomeList`, and the reason is the page's
// shape rather than tidiness: Setup is the LAST Suspense boundary (#5435 §6.1), so its
// findings are gathered in a different frame from the Later and Now bands. A composer
// that took them as an input would force the gather back into the shell and leave the
// boundary streaming markup with nothing behind it. The row shape is identical either
// way — the seat rules below are the whole difference, and they do not depend on the
// day.
export function composeHomeSetup(
  subject: HomeSubject,
  findings: readonly Finding[]
): HomeSetupRow[] {
  return findings.map((finding) => ({
    // Dismissal persistence keys on the bus's own dedupe key, so a row dismissed on
    // Home stays dismissed wherever else the bus states it.
    id: `home.setup:${finding.dedupeKey}`,
    factKey: finding.dedupeKey,
    subject,
    applicable: true,
    finding,
  }));
}
