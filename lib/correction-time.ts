// TIME CORRECTION OVER A ONE-TAP LEDGER (issues #2019, #2020) — the pure half.
//
// ── THE PREMISE ──────────────────────────────────────────────────────────────
//
// A one-tap button in a chat carries a contract: "I'm eating NOW", "I'm taking this
// NOW". By that contract the TAP INSTANT is a measurement of when the thing happened,
// with a known error — not a guess. Two things were missing: recording it, and a way
// to correct it when the contract is false because the tap was late.
//
// This module is the correction half, and it is deliberately DOMAIN-BLIND: food
// servings (`food_log_events.occurred_at`, #2019) and dose administrations
// (`intake_item_logs.recorded_at`, #2020) are the same shape — an immutable audit stamp
// for WHEN THE TAP LANDED, and a separate, correctable instant for WHEN IT HAPPENED.
// One model, one chip vocabulary, one picker, so the two chats cannot drift.
//
// ── WHY THE BURST IS THE UNIT ────────────────────────────────────────────────
//
// Burst-mates share one error. A dinner logged two hours late is off by two hours for
// all four servings; a bedtime handful confirmed at 07:00 is off by nine hours for
// every pill in it. So taps within BURST_GAP_MIN of each other collapse into one row
// with one set of chips, and one tap re-stamps the whole burst. A lone tap is a burst
// of one and renders with its name.
//
// AND A BURST IS ONE MESSAGE'S ERROR (#3092, superseding #2264's cross-message
// clause). Two reminders are two errors: an Evening dose due at 18:00 and a Bedtime
// dose due at 22:00, both answered the next morning minutes apart, are late by
// different amounts and want different corrections — they were never one logging act.
// So taps partition by the message they answered BEFORE the gap rule groups them, and
// a burst may not span two messages. Null — a web one-tap or an offline replay, which
// has no message — is its own partition.
//
// ── ONE VOCABULARY: EVERY OFFER IS AN ABSOLUTE LOCAL TIME (#2206) ────────────
//
// A chip used to read `−1h` and a picker button `19:00` — two vocabularies for one
// question, and the relative half asked the user to redo arithmetic this module had
// already done. It computes the exact resulting instant to mint the token, so it states
// it: a chip reads `19:11 · −1h`. The absolute value is the answer, the offset is the
// context that says which button you are pressing, and there is exactly ONE function
// (`chipInstant`) behind both the label and the write.
//
// It is also DST-correct by construction, which is the case a relative label gets
// silently wrong: across a fall-back hour, "an hour ago" and "19:11" are different
// claims, and only the second one is checkable against a clock on the wall.
//
// ── WHERE A CHIP COUNTS BACK FROM: THE STORED INSTANT, NOT THE TAP ───────────
//
// A chip is `<the instant the ledger currently holds> − N minutes`. It used to be
// `tapAt − N`, which made a re-tap IDEMPOTENT — deliberately, so two people tapping one
// message could not walk a serving four hours back. That protection turned into the
// opposite failure once the row started SHOWING its result (#2206 item 2): "tap again to
// go further" is the mental model a visibly-moving value creates, and a second `−1h` that
// silently landed on the same instant was the worst possible answer to it.
//
// So repeat taps COMPOSE, and doing so costs no new state: the stored `occurred_at` /
// `recorded_at` IS ledger state, the same ledger the row set is already a query over. Two
// taps of `−1h` mean two hours back; the re-render after each is what makes the step
// visible; a rebuild, a pointer rotation or a restart changes nothing.
//
// What replaces idempotence as the safety property is the FLOOR (`chipFloor`): a chip is
// only offered while its result stays inside the picker's own reach, so repeat taps
// cannot walk a value arbitrarily far into the past. Past the floor the chips drop and
// the picker — which is what an answer that far back is for — is the only path left. The
// handler re-checks the same floor at tap time, so a stale keyboard cannot cross it.
//
// A picker button stays an ABSOLUTE local hour anchored on NOW, so the stamp does not
// drift with the seconds between rendering the keyboard and choosing an answer. A `−5h`
// picker button would compute its offset at TAP time and a user who takes two minutes to
// decide would land two minutes off; "19:00" cannot.
//
// ── GRANULARITY IS DELIBERATE ────────────────────────────────────────────────
//
// Two chips, `−30m` and `−1h` (#2206). The consumers tolerate about half an hour:
// eating-window length and protein distribution want that much; PRN redose intervals and
// the administration proximity dedupe are measured in hours. `−30m` is FINER than
// anything the picker can express — it offers absolute `HH:00` only — so the chips own
// the small end and the picker owns the large one, which is a better division of labour
// than three coarse chips covering the middle. Two also buys back the row width the
// absolute labels spend.
//
// NO DB, NO NETWORK, NO AMBIENT CLOCK — every function takes its `now` — so the whole
// model is fixture-testable (lib/__tests__/correction-time.test.ts).

import { zonedDateParts, zonedWallTimeToUtc, shiftDateStr } from "./date";
import { statedHoursOnDate, statedInstantOnDate } from "./stated-time";

// ---- Vocabulary ------------------------------------------------------------

// How long a burst stays correctable. Past this it is history, and the correction rows
// are stripped by the hourly sweep — one trailing edit per logging burst, then back to
// the zero-call steady state.
export const CORRECTION_FRESH_MIN = 60;

// Taps this close together are one burst. Wide enough to hold a meal being tapped in
// group by group, or a handful of pills confirmed one at a time; narrow enough that
// breakfast and elevenses stay two rows.
export const BURST_GAP_MIN = 15;

// The chips, in keyboard order, as MINUTES back (#2206 — `−30m` is finer than an hour,
// and the wire format already carried minutes). Two of them, because repeat taps compose:
// the middle of the range is reached by tapping twice, not by a third button.
export const CORRECTION_CHIP_MINUTES = [30, 60] as const;

// The picker starts where the chips stop (one hour past the last chip) and runs to the
// ceiling — the escape hatch for the case the chips cannot express: dinner at 19:00
// tapped at 00:30, a bedtime handful confirmed at 07:00. With the chips now reaching one
// hour rather than three, the picker's first hour moved down with them, so the two offers
// stay contiguous and neither leaves a hole.
export const PICKER_FIRST_HOURS_BACK =
  Math.ceil(Math.max(...CORRECTION_CHIP_MINUTES) / 60) + 1;
export const PICKER_LAST_HOURS_BACK = 12;

// How far back repeat chip taps may walk a value: the picker's own ceiling, measured from
// NOW. Past it the chips are not offered and the handler refuses them — an answer that
// far back is what the picker is for, and a chip that could compose past the point where
// the surface can even state the result is a button that walks a value into the dark.
export const CHIP_FLOOR_HOURS_BACK = PICKER_LAST_HOURS_BACK;

// How far a stored instant must sit from its own tap before the row says "(corrected)".
// A DIFFERENCE test, not a provenance claim: the marker's job is "this row no longer says
// what you tapped", and a second of clock jitter between two stamps written by one request
// is not that. Every real correction is at least the smallest chip, half an hour.
//
// It therefore also marks a serving whose time was STATED on the web rather than corrected
// in the chat (#2053's Earlier…), and that is the right answer rather than a leak: the row
// exists to say where the serving stands, the header would otherwise name a tap instant
// nobody meant, and reading `time_source` here would make the marker a claim about who
// wrote the value instead of about what the header says.
const CORRECTED_MARK_MS = 60_000;

// At most this many correction rows ride a keyboard. The rows are the ride-along, not
// the message: a nudge whose own buttons have been pushed off the screen by corrections
// has stopped being a nudge. Newest burst first, so the row that needs correcting is the
// one on top.
export const MAX_CORRECTION_ROWS = 2;

const MIN_MS = 60_000;

// ---- The model -------------------------------------------------------------

// One already-written ledger row, as a correction offer reads it.
export interface TapEvent {
  // The ledger row id. The correction token anchors on the burst's LOWEST id, and the
  // handler re-derives the burst from the ledger at tap time — so a token stays valid
  // across a rebuild, a rotation, and a restart, and carries no state of its own.
  id: number;
  // The IMMUTABLE audit stamp: when the tap landed — `food_log_events.recorded_at` for a
  // serving or dose. Burst identity always comes from `recorded_at`.
  // identity and FRESHNESS are computed from this and never from the corrected instant —
  // a correction is not a tap, so a multi-tap correction session must not extend its own
  // hour (#2206).
  tapAt: string;
  // The instant the ledger CURRENTLY holds for this row — `food_log_events.occurred_at`
  // for a serving, `intake_item_logs.recorded_at` for a dose — or
  // null when it holds none. This is what a chip counts back from and what the row's
  // header states, so both the label and the write read one value (#2206). Ledger state,
  // not a memory of some earlier message — the row set was already a query over exactly
  // this ledger.
  statedAt?: string | null;
  // WHICH MESSAGE'S TAP wrote this row (#2264): the `notify_messages` row id stored on
  // the ledger row, or null for a tap no chat message produced — a web one-tap, an
  // offline replay, or a chat tap whose message row has since been pruned or closed
  // (`ON DELETE SET NULL`). Attribution, not time: it decides WHERE a correction row
  // may render and WHICH taps may share a burst (#3092), never what a correction says.
  messageRef?: number | null;
  // THE PROFILE-LOCAL DAY THE ROW IS FILED UNDER, for a DAY-KEYED store (#2875) —
  // `practice_logs.date`, read straight off the column. Omitted by the instant-keyed
  // domains, which have no such column: a serving or a dose IS its instant.
  //
  // It rides here rather than being re-derived from `statedAt`, because the write core
  // compares against THIS COLUMN (`local.date !== row.date` in `restampPracticeLogsCore`)
  // and the two are not the same string everywhere. `zonedWallTimeToUtc` does not
  // round-trip the day in a zone whose DST starts at local midnight: in America/Havana a
  // row filed under 2026-03-08 at "00:30" composes to an instant that reads back as
  // 2026-03-07 23:30, because 00:00–00:59 never happens that day. Bounding the offers by
  // the COMPOSED day there offers chips the core is guaranteed to refuse — the exact
  // defect the day bound exists to prevent, one derivation over.
  localDay?: string | null;
  // What the row is, for a lone-tap row's label ("Salmon 20:11", "Ibuprofen 22:01").
  label: string;
}

// The instant a row stands at right now: its stated/corrected value if it has a usable
// one, its tap otherwise. The ONE spelling of "where is this row", used by the labels, the
// chip arithmetic and the write core alike.
export function rowInstant(row: {
  tapAt: string;
  statedAt?: string | null;
}): string {
  const at = row.statedAt;
  return at && Number.isFinite(ms(at)) ? at : row.tapAt;
}

// A run of taps that shares one error, and therefore one correction.
export interface CorrectionBurst {
  // The burst's lowest row id — the token anchor.
  fromId: number;
  ids: number[];
  count: number;
  // The burst's tap span. FRESHNESS ONLY — the label states the stored span below.
  startAt: string;
  endAt: string;
  // The span the LEDGER currently holds for the burst: the earliest and latest
  // `rowInstant` across its members. This is what the row's header names and what the
  // chips count back from (#2206), so a corrected burst stops asserting its tap time.
  atStartAt: string;
  atEndAt: string;
  // Does any member stand somewhere other than where it was tapped? The "(corrected)"
  // marker, and nothing more — see CORRECTED_MARK_MS.
  corrected: boolean;
  // The message this burst belongs to (#2264): shared by EVERY member, because
  // `collapseBursts` partitions by it before the gap rule runs (#3092) — two reminders
  // are two errors, so a burst may not span two messages. (#2264's original clause
  // attributed a cross-message burst to its first tap; #3092 overturned it on the case
  // it did not anticipate — two live dose reminders answered minutes apart.)
  // Null is an UNATTRIBUTED burst (web, offline replay, pruned message row), which may
  // ride only the newest live message of its domain — see `burstsForMessage`.
  messageRef: number | null;
  // The one stored local day every member is filed under (#2875), or null when they are
  // not all filed under one — which includes a domain that files under none. Read from
  // `TapEvent.localDay`, so it is the day the write core enforces and not a second
  // derivation of it; `burstLocalDay` is how the offer bound asks for it.
  localDay: string | null;
  // The lone member's label; empty for a multi-row burst, which is named by its count.
  label: string;
}

function ms(iso: string): number {
  return new Date(iso).getTime();
}

// Group taps into bursts: PARTITION BY MESSAGE, then split on time (#3092). Within
// each `messageRef` partition — null (web one-tap, offline replay, pruned message row)
// its own — taps sort by tap instant (id breaks a tie, which is what an identical
// stamp on two rows written in one transaction produces), and a gap wider than
// BURST_GAP_MIN starts a new burst.
//
// Partition-then-gap rather than a flush-on-change in one pass: two messages answered
// alternately (A, B, A) inside one window must give A's two taps ONE row, and a
// flush-on-change rule would give three bursts. The result is re-sorted ascending by
// tap start — the pre-partition contract — so `correctionBursts`' newest-first cap
// still picks the newest whichever partition it came from.
export function collapseBursts(events: readonly TapEvent[]): CorrectionBurst[] {
  const sorted = [...events]
    .filter((e) => Number.isFinite(ms(e.tapAt)))
    .sort((a, b) => ms(a.tapAt) - ms(b.tapAt) || a.id - b.id);
  const partitions = new Map<number | null, TapEvent[]>();
  for (const e of sorted) {
    const key = e.messageRef ?? null;
    const part = partitions.get(key);
    if (part) part.push(e);
    else partitions.set(key, [e]);
  }
  const out: CorrectionBurst[] = [];
  for (const part of partitions.values()) {
    let current: TapEvent[] = [];
    const flush = () => {
      if (current.length === 0) return;
      const first = current[0];
      const last = current[current.length - 1];
      // The stored span is computed rather than read off the ends: a chip moves every
      // row back from its OWN instant so the order usually survives, but a per-row
      // correction (or a row that carries a stated time it was never tapped with, which
      // the web food bar writes) can reorder them, and the header must state the real
      // extremes.
      const at = current.map((e) => ms(rowInstant(e)));
      const atStart = current[at.indexOf(Math.min(...at))];
      const atEnd = current[at.indexOf(Math.max(...at))];
      out.push({
        fromId: Math.min(...current.map((e) => e.id)),
        ids: current.map((e) => e.id),
        count: current.length,
        startAt: first.tapAt,
        endAt: last.tapAt,
        atStartAt: rowInstant(atStart),
        atEndAt: rowInstant(atEnd),
        corrected: current.some(
          (e) => Math.abs(ms(rowInstant(e)) - ms(e.tapAt)) >= CORRECTED_MARK_MS
        ),
        // The partition key: every member carries it, by construction (#3092).
        messageRef: first.messageRef ?? null,
        // ONE day or none. A burst is one error, and a correction writes one answer
        // onto every member — so members filed under different days (or any member
        // filed under none) leave the burst with no day a day-keyed offer could be
        // bounded by.
        localDay: current.every((e) => e.localDay && e.localDay === first.localDay)
          ? (first.localDay ?? null)
          : null,
        label: current.length === 1 ? first.label : "",
      });
      current = [];
    };
    for (const e of part) {
      const prev = current[current.length - 1];
      if (prev && ms(e.tapAt) - ms(prev.tapAt) > BURST_GAP_MIN * MIN_MS) flush();
      current.push(e);
    }
    flush();
  }
  // Ascending by tap start again — concatenating partitions loses it. `fromId` breaks
  // an identical-stamp tie across partitions; within one it is already unique.
  return out.sort((a, b) => ms(a.startAt) - ms(b.startAt) || a.fromId - b.fromId);
}

// Is this burst still correctable? Keyed on the NEWEST TAP in it, so a burst that is
// still being added to stays live for the full hour after its last member. This is the
// one predicate both the renderer (offer the row) and the reconciler (strip the row)
// consult, so a chat can never show a chip whose tap the handler would refuse AS LAPSED.
// Freshness is one of two bounds; a day-keyed domain has a second one, and it is applied
// by the same shared computation on both sides — see "DAY-KEYED STORES" below.
//
// A CORRECTION IS NOT A TAP (#2206), and this is the decision made explicitly. Repeat
// chip taps compose, so a correction session could in principle keep renewing its own
// window — the row would then outlive the logging burst it belongs to purely because
// somebody kept pressing it, which is the "one trailing edit per logging burst" property
// the hourly sweep is built on. So `statedAt` is deliberately absent from this predicate.
//
// Nothing is stranded when the window closes mid-session: every chip tap is a complete,
// committed write, so there is no half-corrected state to lose, and the handler's refusal
// names where the rest of the correction belongs (the app) rather than failing silently.
export function isBurstFresh(burst: CorrectionBurst, now: Date): boolean {
  const age = now.getTime() - ms(burst.endAt);
  return age >= 0 ? age <= CORRECTION_FRESH_MIN * MIN_MS : true;
}

// WHERE a burst may render (#2264). A correction row is a claim about the MESSAGE it
// rides — its chips restamp the burst its tokens anchor on — so a message may only ever
// carry its OWN bursts. `messageRef` is the rendering message's `notify_messages` row id
// (null for a message that has none: a fresh send not yet delivered, or a message whose
// pointer was never recorded); `isNewest` says whether the rendering message is the
// newest live message of its domain in its chat, which is the ONE place an unattributed
// burst (a web one-tap, an offline replay, a pruned message row) may ride — never an
// older message, whose subject it is not.
export interface CorrectionMessageBinding {
  messageRef: number | null;
  isNewest: boolean;
}

// A message that has not been delivered yet has no pointer row and is, by construction,
// about to be the newest live message of its domain in every chat it lands in.
export const FRESH_SEND_BINDING: CorrectionMessageBinding = {
  messageRef: null,
  isNewest: true,
};

// The bursts one message may show (#2264): its own, plus — only while it is the newest
// live message of its domain — the unattributed ones. A burst whose taps came from a
// DIFFERENT message is never shown: the wrong-subject case fails closed, because the
// chips would restamp servings the message never mentioned.
export function burstsForMessage(
  bursts: readonly CorrectionBurst[],
  binding: CorrectionMessageBinding
): CorrectionBurst[] {
  return bursts.filter((b) =>
    b.messageRef != null
      ? binding.messageRef != null && b.messageRef === binding.messageRef
      : binding.isNewest
  );
}

// The correction rows a keyboard should carry right now: the profile's fresh taps,
// collapsed into bursts, bound to the rendering message (#2264), newest first, capped.
// The ROW SET IS A QUERY over ledger state — never a memory of what some earlier message
// rendered — which is why the rows survive a rebuild, a pointer rotation and a restart.
// The binding filters BEFORE the cap, so a foreign burst can never push a message's own
// burst off its keyboard. No binding means no message filter — the pre-#2264 profile-wide
// set, which only a caller that is not rendering a message may ask for.
export function correctionBursts(
  events: readonly TapEvent[],
  now: Date,
  binding?: CorrectionMessageBinding
): CorrectionBurst[] {
  const fresh = collapseBursts(events).filter((b) => isBurstFresh(b, now));
  return (binding ? burstsForMessage(fresh, binding) : fresh)
    .reverse()
    .slice(0, MAX_CORRECTION_ROWS);
}

// Re-derive ONE burst from the ledger, given the id its token was anchored on. The tap
// handler's half of the same computation the renderer ran: the token carries an id only
// (the ids-never-names rule), so the set of rows a chip re-stamps is decided at TAP time
// from current state. Null when the anchor row is gone or no longer starts a burst here.
export function burstFrom(
  events: readonly TapEvent[],
  fromId: number
): CorrectionBurst | null {
  return collapseBursts(events).find((b) => b.fromId === fromId) ?? null;
}

// ---- Resolving an offer to an instant --------------------------------------

// A chip: an instant, N minutes earlier. THE one computation behind both the button's
// label and the value the write stores (#2206) — the label is not a re-derivation, it is
// this result formatted.
//
// Applied PER ROW at write time (each row moves back from its OWN current instant), so a
// burst spanning six minutes keeps that spread instead of collapsing onto one instant.
export function chipInstant(fromAt: string, minutesBack: number): Date {
  return new Date(ms(fromAt) - minutesBack * MIN_MS);
}

// The earliest instant a chip may land on: the picker's own ceiling, measured from now.
export function chipFloor(now: Date): Date {
  return new Date(now.getTime() - CHIP_FLOOR_HOURS_BACK * 60 * MIN_MS);
}

// Where one chip would put one row, or null when that would cross the floor. The
// handler's own guard, run against the row it is about to write rather than against the
// burst the keyboard was rendered from — a stale keyboard, or a second tap racing a first,
// must not be able to walk a value past the point the chips stop being offered at.
export function chipTarget(
  row: { tapAt: string; statedAt?: string | null },
  minutesBack: number,
  now: Date
): Date | null {
  const at = chipInstant(rowInstant(row), minutesBack);
  return at.getTime() >= chipFloor(now).getTime() ? at : null;
}

// One offered chip: how far back it steps, where that lands, and the label saying so.
export interface ChipOffer {
  minutesBack: number;
  at: Date;
  label: string;
}

// The chips a burst can still offer. Computed from the burst's EARLIEST stored instant —
// the one the header names and the first to reach the floor — so the label states the
// time the row will read after the tap, and a chip that would walk past the floor is
// simply not on the keyboard. A burst with no offers left keeps its 🕐 label button: the
// picker is exactly the path an answer that far back belongs on.
//
// `dayKeyed` is the second bound, and it belongs to the DOMAIN rather than to the clock —
// see "DAY-KEYED STORES" below.
export function chipOffers(
  burst: CorrectionBurst,
  now: Date,
  tz: string,
  dayKeyed = false
): ChipOffer[] {
  const floor = chipFloor(now).getTime();
  const out: ChipOffer[] = [];
  for (const minutesBack of CORRECTION_CHIP_MINUTES) {
    const at = chipInstant(burst.atStartAt, minutesBack);
    if (at.getTime() < floor) continue;
    if (dayKeyed && !chipStaysOnDay(burst, minutesBack, tz)) continue;
    out.push({ minutesBack, at, label: chipLabel(at, tz, minutesBack) });
  }
  return out;
}

// The local "HH:00" hours between `firstBack` and `lastBack` hours ago, newest first and
// de-duplicated (a DST fall-back repeats an hour). The shared spelling of "the recent
// hours, as absolute local wall times" — the correction picker below takes a slice that
// starts past its chips, and the web food bar's own eating-time statement
// (lib/food-eating-time.ts, #2053) starts at one hour back because it has no chips beside
// it. One computation, so the two vocabularies cannot drift.
export function hourOptionsBack(
  now: Date,
  tz: string,
  firstBack: number,
  lastBack: number
): string[] {
  const out: string[] = [];
  for (let k = firstBack; k <= lastBack; k++) {
    const { hhmm } = zonedDateParts(
      tz,
      new Date(now.getTime() - k * 60 * MIN_MS)
    );
    const hour = `${hhmm.slice(0, 2)}:00`;
    if (!out.includes(hour)) out.push(hour);
  }
  return out;
}

// The absolute hours the picker offers, newest first, as local "HH:00" strings. Bounded
// by construction: it starts one hour past the last chip and stops at the ceiling, so it
// can never offer the future and never offers what a chip already covers.
export function pickerHourOptions(now: Date, tz: string): string[] {
  return hourOptionsBack(
    now,
    tz,
    PICKER_FIRST_HOURS_BACK,
    PICKER_LAST_HOURS_BACK
  );
}

// Resolve a picked absolute local hour to an instant.
//
// THE DAY RULE, and it is the chips' rule stated in absolute form: an offered hour LATER
// than the current local time is yesterday's. At 00:30, "20:00" means yesterday 20:00 —
// which is exactly how someone answers "when did you eat" after midnight, and it is what
// makes the cross-midnight re-date fall out of the same computation rather than needing a
// second one.
//
// Independent of the delay between render and tap: the answer is an absolute wall time,
// so two minutes of hesitation move nothing. That is the property the relative form fails
// and the reason the picker is absolute at all.
//
// Null when `hhmm` is not a wall clock at all. Every caller reaches this through the
// picker's own vocabulary, so that is a shape nobody can currently produce — but the
// alternative is the helper inventing an hour from a string it could not read, and
// what this function stamps is a corrected administration or eating instant (#2245).
export function statedHourInstant(
  hhmm: string,
  now: Date,
  tz: string
): Date | null {
  const local = zonedDateParts(tz, now);
  const sameDay = zonedWallTimeToUtc(tz, local.date, hhmm);
  if (!sameDay) return null;
  if (sameDay.getTime() <= now.getTime()) return sameDay;
  return zonedWallTimeToUtc(tz, shiftDateStr(local.date, -1), hhmm);
}

// ---- THE DAY LEVEL (issue #3010) -------------------------------------------
//
// The picker was ELEVEN HOURS MEASURED FROM NOW, at every hour of the day. At 08:00 its
// floor is 20:00 yesterday, so an 18:00 dinner — fourteen hours back — could not be
// corrected the next morning at all. The picker's own comment names the case it was
// built for ("dinner at 19:00 tapped at 00:30"); the next-morning version of that same
// case fell off the end.
//
// So the picker gains a DAY level and speaks the day + hour PAIR the rest of the app
// speaks (#2236): level one is the recent hours exactly as before, plus one step down to
// level two, which is YESTERDAY enumerated by `statedHoursOnDate` — the SAME function
// the web correction sheet's hour select renders (lib/stated-time.ts), so the two
// surfaces cannot drift and no second enumeration of "the hours of a day" is born.
//
// Widening the ceiling to 24 hours was the alternative and it is worse on every axis:
// 23 near-identical buttons, eight rows of them, and still unable to reach the day
// before. Reaching FURTHER back than yesterday is deliberately not here either — the
// app's seven-day sheet is the historical editor.
export type CorrectionDay =
  /** The level-one offer: the recent hours, resolved by THE DAY RULE above. */
  | "today"
  /** The level-two offer: the whole of the profile-local previous day. */
  | "prev";

// The profile-local day a level names, as a YYYY-MM-DD string.
export function correctionDayDate(day: CorrectionDay, now: Date, tz: string) {
  const local = zonedDateParts(tz, now).date;
  return day === "prev" ? shiftDateStr(local, -1) : local;
}

// Level two's hours: every wall hour of the profile-local previous day, newest first.
//
// `statedHoursOnDate` is the app's ONE enumeration of "the hours of a day" — the web
// sheet's select reads it, and reading it here is what keeps the chat and the app from
// drifting. A complete past day offers its whole 24; a spring-forward day simply lacks
// its nonexistent hour, DST-safe by construction rather than by a check.
//
// Newest first because that is the picker's order everywhere else: `statedHoursOnDate`
// enumerates ascending, and the drill-down reads down from the most recent.
export function pickerPrevDayHourOptions(now: Date, tz: string): string[] {
  return statedHoursOnDate(correctionDayDate("prev", now, tz), tz, now)
    .map((o) => o.hhmm)
    .reverse();
}

// Resolve an offered hour ON ITS LEVEL to an instant — the one place the two levels
// differ, and the reason the day rides the token rather than being guessed at tap time.
//
//   • `today` — THE DAY RULE, unchanged: an hour later than the current local time is
//     yesterday's. This is what makes the level-one offer at 00:30 mean last evening.
//   • `prev`  — anchored on the named day through `statedInstantOnDate`, which enforces
//     the (date, hhmm) pair BY CONSTRUCTION: a wall time that does not exist on that day
//     is refused rather than silently settled onto a different clock reading.
//
// Both can only ever return a PAST instant for an hour this module offered, which is the
// property `judgeStatedAt` and the dose side's redose-window safety both rest on.
export function offeredHourInstant(
  hhmm: string,
  day: CorrectionDay,
  now: Date,
  tz: string
): Date | null {
  return day === "prev"
    ? statedInstantOnDate(correctionDayDate("prev", now, tz), hhmm, tz)
    : statedHourInstant(hhmm, now, tz);
}

// ---- DAY-KEYED STORES: the render half of a refusal (#2875) ----------------
//
// THE DAY RULE above is a re-dating rule, and for two of the three domains that is the
// whole answer: food stores an instant and reports the crossing (`movedDays`), dose
// stores an instant and reports it too (`crossedMidnight`). Both ABSORB a correction that
// walks past local midnight.
//
// A practice does not. It stores a profile-local DAY plus an "HH:MM", and its write core
// (`restampPracticeLogsCore`) REFUSES an answer landing on another day — correcting a
// session's date is the expanded form's job. So for that domain the day rule turns every
// offer it re-dates into a button the core is guaranteed to refuse: at 00:20 local BOTH
// chips resolve to yesterday and so does every picker hour, which is 100% of the
// affordance dead in exactly the hour the stored time is most wrong.
//
// The offer set is therefore bounded by the domain as well as by the clock. `dayKeyed`
// says which kind of store is being corrected, and these three predicates are the ONE
// place the bound is computed — the renderer filters with them and the handler admits
// with them, so "a chat can never show a chip the handler would refuse, and never refuse
// one it is showing" is true for a day-keyed domain too.

// The one local day a burst's rows are all FILED UNDER, or null when they are not.
//
// THE DAY THE WRITE CORE ENFORCES, not a second derivation of it. The core's refusal is
// `zonedDateParts(tz, resolved).date !== row.date` — the STORED COLUMN — so the offer
// bound has to read the same string, and `collapseBursts` carries it up from
// `TapEvent.localDay` for exactly that. Re-deriving it from `atStartAt` instead looks
// equivalent and is not: `zonedWallTimeToUtc` does not round-trip the day in the five
// zones whose DST starts at local midnight, and there the derived day is yesterday's
// while the core still enforces the column.
//
// Null when the members are not all on one day. That is not hypothetical — BURST_GAP_MIN
// collapses a 23:58 tap and a 00:03 tap into one burst, and `logPracticeSession` accepts
// a backdated write that can land a burst-mate on another day entirely. Neither can be
// corrected as ONE error, which is what a burst is, so a day-keyed domain offers such a
// burst nothing. It is also null for an instant-keyed domain, which files under no day at
// all — the bound is only ever consulted under `dayKeyed`, and a missing day FAILS CLOSED.
export function burstLocalDay(burst: CorrectionBurst): string | null {
  return burst.localDay ?? null;
}

// Would this chip keep EVERY row of the burst on the local day it is FILED UNDER?
//
// A chip moves each row back from its OWN instant by the same amount, so the EARLIEST row
// is the first to leave the day — and the earliest is `atStartAt` by construction. One
// test against it therefore answers for the whole burst, and it stays exact now that the
// day is the FILED one rather than the composed one:
//
//   • where the composition round-trips, every member of a burst filed under D composes
//     to an instant inside D, so the earliest is the first to cross out of it;
//   • where it does not — a zone whose DST starts at local midnight — the rows it affects
//     are the ones filed at 00:00–00:59, which compose to D−1 23:00–23:59 and are
//     therefore EARLIER than every unaffected member. So the row the core refuses is
//     again the one this test is taken against.
export function chipStaysOnDay(
  burst: CorrectionBurst,
  minutesBack: number,
  tz: string
): boolean {
  const day = burstLocalDay(burst);
  if (!day) return false;
  return (
    zonedDateParts(tz, chipInstant(burst.atStartAt, minutesBack)).date === day
  );
}

// Would this absolute hour, resolved by THE DAY RULE, land on the day the burst is FILED
// UNDER? The picker writes ONE instant onto every row of the burst, so a burst with no
// single filed day has no answer at all and a burst that has one needs the resolved
// instant to fall on it.
export function hourStaysOnDay(
  hhmm: string,
  burst: CorrectionBurst,
  now: Date,
  tz: string,
  level: CorrectionDay = "today"
): boolean {
  const day = burstLocalDay(burst);
  if (!day) return false;
  const at = offeredHourInstant(hhmm, level, now, tz);
  return at != null && zonedDateParts(tz, at).date === day;
}

// The picker hours this burst may actually be offered ON ONE LEVEL: the clock's set for
// that level, then the domain's bound. THE function behind both the keyboard and the
// handler's guard, on both levels — which is what makes "what the handler accepts is what
// the keyboard offered, RECOMPUTED, never what the token asserts" true of the day
// dimension too (#3010).
export function offeredHours(
  burst: CorrectionBurst,
  now: Date,
  tz: string,
  dayKeyed = false,
  level: CorrectionDay = "today"
): string[] {
  const hours =
    level === "prev"
      ? pickerPrevDayHourOptions(now, tz)
      : pickerHourOptions(now, tz);
  return dayKeyed
    ? hours.filter((h) => hourStaysOnDay(h, burst, now, tz, level))
    : hours;
}

// True when `hhmm` is one of the hours this picker would offer for THIS burst on THIS
// level right now. The handler's own guard: a forged or stale token naming an unoffered
// hour — or an hour naming a DAY that is no longer level two's — writes nothing rather
// than stamping an arbitrary instant. It takes the burst because what is on offer is a
// question about the burst as well as about the clock, and since #3010 it takes the day
// too, because that is a third thing the token can be wrong about.
//
// `levelDate` is the day a `p:` token NAMES, and it is compared, never obeyed: level two
// is always "the day before now", so a token minted before local midnight names a day
// that is no longer on offer, and accepting it would stamp an instant a full 24 hours
// later than the button said. Refusing it is the same rule the hour set already obeys —
// what the handler accepts is what the keyboard offered, RECOMPUTED.
export function isOfferedHour(
  hhmm: string,
  burst: CorrectionBurst,
  now: Date,
  tz: string,
  dayKeyed = false,
  level: CorrectionDay = "today",
  levelDate: string | null = null
): boolean {
  if (level === "prev" && levelDate !== correctionDayDate("prev", now, tz))
    return false;
  return offeredHours(burst, now, tz, dayKeyed, level).includes(hhmm);
}

// ---- Labels ----------------------------------------------------------------

function hhmmOf(iso: string, tz: string): string {
  return zonedDateParts(tz, new Date(iso)).hhmm;
}

// The row's name. A lone tap is named by WHAT it was ("Salmon 20:11"); a burst by how
// many and when ("×4 21:02–21:08"), because naming four groups would not fit a button
// and the span is what identifies the burst to the person who made it.
//
// THE TIME IS THE STORED ONE (#2206). It used to be the tap time, which is precisely the
// value a correction replaces — so a corrected row went on asserting the wrong time
// forever, and the user had nowhere to read what had actually been written. That is the
// #1779 rule ("a chat must not claim what is no longer true") applied to a displayed
// value rather than to a button, and it needs no new machinery: the row set is a QUERY
// over the ledger, so every rebuild — a tap, the hourly sweep — re-reads the corrected
// instant and re-renders it. The marker only ever REDUCES what the row claims; it adds no
// button and no new assertion.
// AND IT STATES THE DAY WHEN THE DAY IS NOT TODAY'S (#3010). A burst corrected to 18:00
// yesterday rendered `Leafy greens 18:00 (corrected)`, which reads as this evening — the
// half of the result that was left unstated. It was already possible in the hour after
// local midnight; the day level makes it the NORMAL case, so the marker is not optional
// any more. Same vocabulary as the picker's own buttons, from the same helper.
export function burstLabel(
  burst: CorrectionBurst,
  tz: string,
  now: Date
): string {
  const mark = burst.corrected ? " (corrected)" : "";
  const todayLocal = zonedDateParts(tz, now).date;
  // Taken against the burst's LAST instant, which is the one both spellings below end
  // with — so the marker always qualifies the time immediately to its left.
  const day = localDayMarker(
    zonedDateParts(tz, new Date(burst.atEndAt)).date,
    todayLocal
  );
  if (burst.count === 1 && burst.label)
    return `${burst.label} ${hhmmOf(burst.atStartAt, tz)}${day}${mark}`;
  const start = hhmmOf(burst.atStartAt, tz);
  const end = hhmmOf(burst.atEndAt, tz);
  const span =
    start === end
      ? `×${burst.count} ${start}`
      : `×${burst.count} ${start}–${end}`;
  return `${span}${day}${mark}`;
}

// The day half of a stated local time, when it is not today's (#3010/#2206 — a rendered
// value states its whole result). Empty for today, ` yest` for the day before, and the
// bare month-day for anything further back, so the marker can never be WRONG about which
// day it means even where a domain's correction reach exceeds one day.
export function localDayMarker(day: string, todayLocal: string): string {
  if (day === todayLocal) return "";
  return day === shiftDateStr(todayLocal, -1) ? " yest" : ` ${day.slice(5)}`;
}

// The picker's own title subject — the same naming, spelled for a sentence. No marker:
// this is the question, and "(corrected)" belongs on the statement of a value, not on an
// invitation to state one.
export function burstSubject(burst: CorrectionBurst, tz: string): string {
  if (burst.count === 1 && burst.label) return burst.label;
  return `these ${burst.count} (${hhmmOf(burst.atStartAt, tz)}–${hhmmOf(burst.atEndAt, tz)})`;
}

// The offset, as context rather than as the answer: "−30m", "−1h".
export function offsetLabel(minutesBack: number): string {
  return minutesBack % 60 === 0 ? `−${minutesBack / 60}h` : `−${minutesBack}m`;
}

// The chip's label: the local wall time it lands on, then the step that gets there.
// ABSOLUTE FIRST because the absolute value is the answer to "when was this" — the offset
// is only there so a row of two chips says which is which. One vocabulary with the picker
// directly above it, and both come from an instant this module computed.
export function chipLabel(at: Date, tz: string, minutesBack: number): string {
  return `${zonedDateParts(tz, at).hhmm} · ${offsetLabel(minutesBack)}`;
}

// The day marker an offered hour wears when it does not land on today (#3010).
//
// The picker has ALWAYS crossed midnight — at 08:00 its grid reads 06:00…02:00 then
// 23:00…20:00, and the second half is yesterday's, formatted identically to the first.
// Nothing on it said so. That is #2206's principle ("a chip states its RESULT") applied
// to the half of the result that was unstated, and it is what makes a day-crossing picker
// legible rather than ambiguous now that a whole second day is reachable.
//
// Computed from the RESOLVED INSTANT rather than from which level drew the button, so the
// label cannot disagree with what the tap will write.
export function pickerHourLabel(
  hhmm: string,
  level: CorrectionDay,
  now: Date,
  tz: string
): string {
  const at = offeredHourInstant(hhmm, level, now, tz);
  if (!at) return hhmm;
  return `${hhmm}${localDayMarker(zonedDateParts(tz, at).date, zonedDateParts(tz, now).date)}`;
}

// The label on the step down to level two.
export const PICKER_PREV_DAY_LABEL = "Yesterday →";

// ---- The token ------------------------------------------------------------

// Both domains mint the same two shapes, differing only in prefix:
//
//   <chip>:<profileId>:<fromRowId>:<minutesBack>
//   <at>:<profileId>:<fromRowId>:<open|prev|back|HH:MM|p:YYYY-MM-DD:HH:MM>
//
// Ids only, never names (#233), and well under Telegram's 64-byte callback cap. The
// `open`/`back` sentinels ride the absolute-time prefix rather than earning two more
// button families: opening the picker and closing it again are the same conversation
// about the same burst, and one prefix means one registry declaration and one dead
// predicate covers the whole drill-down — the `symp:`→`symsev:` shape with the second
// step folded in, because unlike a severity the picker has no state of its own.
//
// THE DAY RIDES THE TAIL (#3010). The tail is REJOINED rather than read positionally
// (an `at` tail is itself "HH:MM"), so the day marker is more colon-separated pieces in
// front of it: `p:2026-07-14:20:00` is 20:00 on that day, a bare `20:00` is level one.
// `prev` is the step down to level two, the day dimension's own `open`.
//
// THE DAY IS SPELLED OUT, and a first draft's bare `p:` is the reason. Level two means
// "the day before NOW", so a bare marker is re-resolved against the clock at tap time —
// and a token minted at 23:55 for 20:00 yesterday resolved, when tapped ten minutes
// later, to 20:00 a FULL 24 HOURS ON. `judgeStatedAt` cannot catch it either: the drift
// moves TOWARD the present, so the instant it produces is still in the past. Level one
// does not have the bug, because THE DAY RULE re-dates relative to the same `now` the
// label was drawn against.
//
// What the token asserts is still NOT what the handler trusts. The stamped day is not
// obeyed — it is COMPARED: `isOfferedHour` re-derives which day level two is showing
// right now and refuses a token naming any other, exactly as it re-derives which hours.
// A forged day is refused by the same call and for the same reason as a forged hour.
export type CorrectionPickerStep =
  | { kind: "open" }
  | { kind: "back" }
  | { kind: "prev" }
  // Level one carries no day: THE DAY RULE resolves it from `now`, which is also what
  // the button was labelled against.
  | { kind: "at"; hhmm: string; day: "today"; date?: undefined }
  // Level two names the day it was drawn for, as a profile-local YYYY-MM-DD.
  | { kind: "at"; hhmm: string; day: "prev"; date: string };

export interface CorrectionChipToken {
  profileId: number;
  fromId: number;
  minutesBack: number;
}

export interface CorrectionAtToken {
  profileId: number;
  fromId: number;
  step: CorrectionPickerStep;
}

export function correctionChipToken(
  prefix: string,
  profileId: number,
  fromId: number,
  minutesBack: number
): string {
  return `${prefix}:${profileId}:${fromId}:${minutesBack}`;
}

export function correctionAtToken(
  prefix: string,
  profileId: number,
  fromId: number,
  step: CorrectionPickerStep
): string {
  const tail =
    step.kind === "at"
      ? step.day === "prev"
        ? `${PREV_DAY_TAG}:${step.date}:${step.hhmm}`
        : step.hhmm
      : step.kind;
  return `${prefix}:${profileId}:${fromId}:${tail}`;
}

// The day marker in the wire tail. One character in front of a spelled-out date, which
// together with the ids and the hour is ~40 bytes — well inside Telegram's 64-byte
// callback budget, and the clarity is worth the ten characters.
const PREV_DAY_TAG = "p";

function parseIds(
  data: unknown,
  prefix: string
): { profileId: number; fromId: number; tail: string } | null {
  if (typeof data !== "string" || !data.startsWith(`${prefix}:`)) return null;
  const f = data.split(":");
  // An "at" token's tail is "HH:MM", which splits into two more fields — so the tail is
  // rejoined rather than read positionally.
  if (f.length < 4) return null;
  const profileId = Number(f[1]);
  const fromId = Number(f[2]);
  const tail = f.slice(3).join(":");
  if (!Number.isInteger(profileId) || profileId <= 0) return null;
  if (!Number.isInteger(fromId) || fromId <= 0) return null;
  if (!tail) return null;
  return { profileId, fromId, tail };
}

// Parse a chip token. The minutes must be one of the offered chips — a forged offset
// (−400h) is refused here rather than being clamped into something plausible.
export function parseCorrectionChipToken(
  data: unknown,
  prefix: string
): CorrectionChipToken | null {
  const base = parseIds(data, prefix);
  if (!base) return null;
  const minutesBack = Number(base.tail);
  if (!Number.isInteger(minutesBack)) return null;
  if (!CORRECTION_CHIP_MINUTES.some((m) => m === minutesBack)) return null;
  return {
    profileId: base.profileId,
    fromId: base.fromId,
    minutesBack,
  };
}

// Parse an absolute-time token. Shape only: WHICH hours are legal is a function of the
// current time, so `isOfferedHour` decides that at tap time against the same computation
// that rendered the keyboard.
export function parseCorrectionAtToken(
  data: unknown,
  prefix: string
): CorrectionAtToken | null {
  const base = parseIds(data, prefix);
  if (!base) return null;
  const step = parseStep(base.tail);
  if (!step) return null;
  return { profileId: base.profileId, fromId: base.fromId, step };
}

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const PREV_TAIL_RE = new RegExp(
  `^${PREV_DAY_TAG}:(\\d{4}-\\d{2}-\\d{2}):(([01]\\d|2[0-3]):[0-5]\\d)$`
);

// The tail's own grammar. Shape only — WHICH (day, hour) pairs are legal is re-derived
// from the clock and the burst by `isOfferedHour`, never read off the token.
function parseStep(tail: string): CorrectionPickerStep | null {
  if (tail === "open") return { kind: "open" };
  if (tail === "back") return { kind: "back" };
  if (tail === "prev") return { kind: "prev" };
  if (HHMM_RE.test(tail)) return { kind: "at", hhmm: tail, day: "today" };
  const prev = PREV_TAIL_RE.exec(tail);
  if (prev) return { kind: "at", hhmm: prev[2], day: "prev", date: prev[1] };
  return null;
}

// The row-id a correction token anchors on, for any of the four prefixes — the reconciler
// reads it back off a live keyboard to ask whether that burst is still fresh.
export function correctionTokenAnchor(
  data: string,
  prefixes: readonly string[]
): number | null {
  for (const p of prefixes) {
    const base = parseIds(data, p);
    if (base) return base.fromId;
  }
  return null;
}
