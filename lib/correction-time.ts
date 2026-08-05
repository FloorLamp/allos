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
// servings (`food_log_events.eaten_at`, #2019) and dose administrations
// (`intake_item_logs.given_at`, #2020) are the same shape — an immutable audit stamp
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
// ── WHY EVERY OFFER IS ANCHORED TO THE TAP, NOT TO NOW ───────────────────────
//
// Both correction shapes resolve against the burst's own IMMUTABLE tap stamp:
//
//   • a chip is `tapAt − N hours`, so tapping −2h twice lands on the same instant
//     rather than walking the row four hours back — the correction is IDEMPOTENT,
//     which matters because a chat message can be tapped twice by two people;
//   • a picker button is an ABSOLUTE local hour, so the stamp does not drift with the
//     seconds between rendering the keyboard and choosing an answer. A `−5h` picker
//     button would compute its offset at TAP time and a user who takes two minutes to
//     decide would land two minutes off; "19:00" cannot.
//
// ── HOUR GRANULARITY IS DELIBERATE ───────────────────────────────────────────
//
// The consumers tolerate it. Eating-window length and protein distribution want about
// half an hour; PRN redose intervals and the administration proximity dedupe are
// measured in hours. Finer buttons buy nothing and cost keyboard height, and ±30 min
// beats an uncorrected multi-hour error by a margin that makes the trade not close.
//
// NO DB, NO NETWORK, NO AMBIENT CLOCK — every function takes its `now` — so the whole
// model is fixture-testable (lib/__tests__/correction-time.test.ts).

import { zonedDateParts, zonedWallTimeToUtc, shiftDateStr } from "./date";

// ---- Vocabulary ------------------------------------------------------------

// How long a burst stays correctable. Past this it is history, and the correction rows
// are stripped by the hourly sweep — one trailing edit per logging burst, then back to
// the zero-call steady state.
export const CORRECTION_FRESH_MIN = 60;

// Taps this close together are one burst. Wide enough to hold a meal being tapped in
// group by group, or a handful of pills confirmed one at a time; narrow enough that
// breakfast and elevenses stay two rows.
export const BURST_GAP_MIN = 15;

// The chips, in keyboard order. Settled vocabulary (#2019): the common case is "I was
// slow to tap", which is an hour or three, and half-hour error is accepted.
export const CORRECTION_CHIP_HOURS = [1, 2, 3] as const;

// The picker starts where the chips stop (one hour past the last chip) and runs to the
// ceiling. Nine options, three per row — the escape hatch for the case the chips cannot
// express: dinner at 19:00 tapped at 00:30, a bedtime handful confirmed at 07:00.
export const PICKER_FIRST_HOURS_BACK =
  CORRECTION_CHIP_HOURS[CORRECTION_CHIP_HOURS.length - 1] + 1;
export const PICKER_LAST_HOURS_BACK = 12;

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
  // The IMMUTABLE audit stamp: when the tap landed (`logged_at` / `taken_at`). Burst
  // identity, freshness, and every chip offset are computed from this and never from
  // the corrected instant, which is exactly what makes a re-tap idempotent.
  tapAt: string;
  // What the row is, for a lone-tap row's label ("Salmon 20:11", "Ibuprofen 22:01").
  label: string;
}

// A run of taps that shares one error, and therefore one correction.
export interface CorrectionBurst {
  // The burst's lowest row id — the token anchor.
  fromId: number;
  ids: number[];
  count: number;
  // The burst's tap span, for the row's label.
  startAt: string;
  endAt: string;
  // The lone member's label; empty for a multi-row burst, which is named by its count.
  label: string;
}

function ms(iso: string): number {
  return new Date(iso).getTime();
}

// Group taps into bursts. Sorted by tap instant (id breaks a tie, which is what an
// identical stamp on two rows written in one transaction produces), and a gap wider
// than BURST_GAP_MIN starts a new burst.
export function collapseBursts(events: readonly TapEvent[]): CorrectionBurst[] {
  const sorted = [...events]
    .filter((e) => Number.isFinite(ms(e.tapAt)))
    .sort((a, b) => ms(a.tapAt) - ms(b.tapAt) || a.id - b.id);
  const out: CorrectionBurst[] = [];
  let current: TapEvent[] = [];
  const flush = () => {
    if (current.length === 0) return;
    const first = current[0];
    const last = current[current.length - 1];
    out.push({
      fromId: Math.min(...current.map((e) => e.id)),
      ids: current.map((e) => e.id),
      count: current.length,
      startAt: first.tapAt,
      endAt: last.tapAt,
      label: current.length === 1 ? first.label : "",
    });
    current = [];
  };
  for (const e of sorted) {
    const prev = current[current.length - 1];
    if (prev && ms(e.tapAt) - ms(prev.tapAt) > BURST_GAP_MIN * MIN_MS) flush();
    current.push(e);
  }
  flush();
  return out;
}

// Is this burst still correctable? Keyed on the NEWEST tap in it, so a burst that is
// still being added to stays live for the full hour after its last member. This is the
// one predicate both the renderer (offer the row) and the reconciler (strip the row)
// consult, so a chat can never show a chip whose tap the handler would refuse.
export function isBurstFresh(burst: CorrectionBurst, now: Date): boolean {
  const age = now.getTime() - ms(burst.endAt);
  return age >= 0 ? age <= CORRECTION_FRESH_MIN * MIN_MS : true;
}

// The correction rows a keyboard should carry right now: the profile's fresh taps,
// collapsed into bursts, newest first, capped. The ROW SET IS A QUERY over ledger state
// — never a memory of what some earlier message rendered — which is why the rows survive
// a rebuild, a pointer rotation and a restart, and why they simply appear on whichever
// keyboard is currently live.
export function correctionBursts(
  events: readonly TapEvent[],
  now: Date
): CorrectionBurst[] {
  return collapseBursts(events)
    .filter((b) => isBurstFresh(b, now))
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

// A chip: the burst's own tap instant, N hours earlier. Applied PER ROW (each row is
// moved back from its OWN tap), so a burst spanning six minutes keeps that spread
// instead of collapsing to a single instant.
export function chipInstant(tapAt: string, hoursBack: number): Date {
  return new Date(ms(tapAt) - hoursBack * 60 * MIN_MS);
}

// The absolute hours the picker offers, newest first, as local "HH:00" strings. Bounded
// by construction: it starts one hour past the last chip and stops at the ceiling, so it
// can never offer the future and never offers what a chip already covers.
export function pickerHourOptions(now: Date, tz: string): string[] {
  const out: string[] = [];
  for (let k = PICKER_FIRST_HOURS_BACK; k <= PICKER_LAST_HOURS_BACK; k++) {
    const { hhmm } = zonedDateParts(
      tz,
      new Date(now.getTime() - k * 60 * MIN_MS)
    );
    const hour = `${hhmm.slice(0, 2)}:00`;
    if (!out.includes(hour)) out.push(hour);
  }
  return out;
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
export function statedHourInstant(hhmm: string, now: Date, tz: string): Date {
  const local = zonedDateParts(tz, now);
  const sameDay = zonedWallTimeToUtc(tz, local.date, hhmm);
  if (sameDay.getTime() <= now.getTime()) return sameDay;
  return zonedWallTimeToUtc(tz, shiftDateStr(local.date, -1), hhmm);
}

// True when `hhmm` is one of the hours this picker would offer right now. The handler's
// own guard: a forged or stale token naming an unoffered hour writes nothing rather than
// stamping an arbitrary instant.
export function isOfferedHour(hhmm: string, now: Date, tz: string): boolean {
  return pickerHourOptions(now, tz).includes(hhmm);
}

// ---- Labels ----------------------------------------------------------------

function hhmmOf(iso: string, tz: string): string {
  return zonedDateParts(tz, new Date(iso)).hhmm;
}

// The row's name. A lone tap is named by WHAT it was ("Salmon 20:11"); a burst by how
// many and when ("×4 21:02–21:08"), because naming four groups would not fit a button
// and the span is what identifies the burst to the person who made it.
export function burstLabel(burst: CorrectionBurst, tz: string): string {
  if (burst.count === 1 && burst.label)
    return `${burst.label} ${hhmmOf(burst.startAt, tz)}`;
  const start = hhmmOf(burst.startAt, tz);
  const end = hhmmOf(burst.endAt, tz);
  return start === end
    ? `×${burst.count} ${start}`
    : `×${burst.count} ${start}–${end}`;
}

// The picker's own title subject — the same naming, spelled for a sentence.
export function burstSubject(burst: CorrectionBurst, tz: string): string {
  if (burst.count === 1 && burst.label) return burst.label;
  return `these ${burst.count} (${hhmmOf(burst.startAt, tz)}–${hhmmOf(burst.endAt, tz)})`;
}

export function chipLabel(hoursBack: number): string {
  return `−${hoursBack}h`;
}

// ---- The token ------------------------------------------------------------

// Both domains mint the same two shapes, differing only in prefix:
//
//   <chip>:<profileId>:<fromRowId>:<minutesBack>
//   <at>:<profileId>:<fromRowId>:<open|back|HH:MM>
//
// Ids only, never names (#233), and well under Telegram's 64-byte callback cap. The
// `open`/`back` sentinels ride the absolute-time prefix rather than earning two more
// button families: opening the picker and closing it again are the same conversation
// about the same burst, and one prefix means one registry declaration and one dead
// predicate covers the whole drill-down — the `symp:`→`symsev:` shape with the second
// step folded in, because unlike a severity the picker has no state of its own.
export type CorrectionPickerStep =
  { kind: "open" } | { kind: "back" } | { kind: "at"; hhmm: string };

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
    step.kind === "at" ? step.hhmm : step.kind === "open" ? "open" : "back";
  return `${prefix}:${profileId}:${fromId}:${tail}`;
}

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
  if (!CORRECTION_CHIP_HOURS.some((h) => h * 60 === minutesBack)) return null;
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
  const step: CorrectionPickerStep | null =
    base.tail === "open"
      ? { kind: "open" }
      : base.tail === "back"
        ? { kind: "back" }
        : /^([01]\d|2[0-3]):[0-5]\d$/.test(base.tail)
          ? { kind: "at", hhmm: base.tail }
          : null;
  if (!step) return null;
  return { profileId: base.profileId, fromId: base.fromId, step };
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
