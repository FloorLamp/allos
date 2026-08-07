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
// So repeat taps COMPOSE, and doing so costs no new state: the stored `eaten_at` /
// `given_at` IS ledger state, the same ledger the row set is already a query over. Two
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
  // The IMMUTABLE audit stamp: when the tap landed (`logged_at` / `taken_at`). Burst
  // identity and FRESHNESS are computed from this and never from the corrected instant —
  // a correction is not a tap, so a multi-tap correction session must not extend its own
  // hour (#2206).
  tapAt: string;
  // The instant the ledger CURRENTLY holds for this row (`eaten_at` / `given_at`), or
  // null when it holds none. This is what a chip counts back from and what the row's
  // header states, so both the label and the write read one value (#2206). Ledger state,
  // not a memory of some earlier message — the row set was already a query over exactly
  // this ledger.
  statedAt?: string | null;
  // WHICH MESSAGE'S TAP wrote this row (#2264): the `notify_messages` row id stored on
  // the ledger row, or null for a tap no chat message produced — a web one-tap, an
  // offline replay, or a chat tap whose message row has since been pruned or closed
  // (`ON DELETE SET NULL`). Attribution, not time: it decides WHERE a correction row may
  // render, never what it says.
  messageRef?: number | null;
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
  // The message this burst belongs to (#2264): its FIRST tap's `messageRef`. The first
  // tap, matching `fromId` already being the burst's anchor — burst-mates share one
  // error, and the message that error was made on is the one the first tap landed from.
  // Null is an UNATTRIBUTED burst (web, offline replay, pruned message row), which may
  // ride only the newest live message of its domain — see `burstsForMessage`.
  messageRef: number | null;
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
    // The stored span is computed rather than read off the ends: a chip moves every row
    // back from its OWN instant so the order usually survives, but a per-row correction
    // (or a row that carries a stated time it was never tapped with, which the web food
    // bar writes) can reorder them, and the header must state the real extremes.
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
      messageRef: first.messageRef ?? null,
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

// Is this burst still correctable? Keyed on the NEWEST TAP in it, so a burst that is
// still being added to stays live for the full hour after its last member. This is the
// one predicate both the renderer (offer the row) and the reconciler (strip the row)
// consult, so a chat can never show a chip whose tap the handler would refuse.
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
export function chipOffers(
  burst: CorrectionBurst,
  now: Date,
  tz: string
): ChipOffer[] {
  const floor = chipFloor(now).getTime();
  const out: ChipOffer[] = [];
  for (const minutesBack of CORRECTION_CHIP_MINUTES) {
    const at = chipInstant(burst.atStartAt, minutesBack);
    if (at.getTime() < floor) continue;
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
//
// THE TIME IS THE STORED ONE (#2206). It used to be the tap time, which is precisely the
// value a correction replaces — so a corrected row went on asserting the wrong time
// forever, and the user had nowhere to read what had actually been written. That is the
// #1779 rule ("a chat must not claim what is no longer true") applied to a displayed
// value rather than to a button, and it needs no new machinery: the row set is a QUERY
// over the ledger, so every rebuild — a tap, the hourly sweep — re-reads the corrected
// instant and re-renders it. The marker only ever REDUCES what the row claims; it adds no
// button and no new assertion.
export function burstLabel(burst: CorrectionBurst, tz: string): string {
  const mark = burst.corrected ? " (corrected)" : "";
  if (burst.count === 1 && burst.label)
    return `${burst.label} ${hhmmOf(burst.atStartAt, tz)}${mark}`;
  const start = hhmmOf(burst.atStartAt, tz);
  const end = hhmmOf(burst.atEndAt, tz);
  const span =
    start === end
      ? `×${burst.count} ${start}`
      : `×${burst.count} ${start}–${end}`;
  return `${span}${mark}`;
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
