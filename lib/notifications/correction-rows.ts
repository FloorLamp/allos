// The correction ride-along, rendered (issues #2019, #2020) — pure, DB-free.
//
// Turns the burst model in lib/correction-time.ts into keyboard rows, once, for all
// three domains. Everything about the SHAPE — which chips, in what order, how a burst is
// named, how the drill-down opens and comes back — is decided here so the three chats
// cannot drift apart. Food, doses and practices (#2875) differ in their two token
// prefixes, in the verb the picker asks with ("when did you eat" / "when did you take
// these" / "when was this"), and in one thing more.
//
// ── DOMAIN-BLIND ABOUT SHAPE, NOT ABOUT WHAT MAY BE OFFERED ──────────────────
//
// This renderer was domain-blind about the OFFER SET too, and for a day-keyed store that
// is wrong rather than general. Food and dose store an instant, so THE DAY RULE's
// re-dating (lib/correction-time.ts — "an offered hour LATER than the current local time
// is yesterday's") is an answer they absorb: the serving moves to yesterday, the dose
// keeps its adherence day and says so. A practice stores a profile-local DAY plus an
// "HH:MM" and its write core REFUSES the crossing — so every offer the day rule re-dated
// was a button guaranteed to answer "that would move the session to another day", and in
// the hour after local midnight that was the whole affordance. `dayKeyed` on
// `CorrectionPrefixes` is how a domain says which kind of store is behind its chips, and
// `correctableBursts` is where a burst with nothing left to offer stops being drawn.
//
// ── WHY THE NAME IS ALSO THE PICKER BUTTON ───────────────────────────────────
//
// The row wants three things on it: what it is about, and two chips (#2206 — three
// chips became two once repeat taps started composing). A phone gives a four-button row
// about ninety points each, and a separate button for the picker would shrink all of them
// below legibility. So the LABEL button is the picker: tapping the thing the row names is
// what opens "when was this, exactly", which is also the more discoverable gesture — the
// escape hatch sits on the subject rather than beside it.
//
// Dropping to two chips is also what pays for their absolute labels: "19:11 · −1h" is
// wider than "−1h", and a three-button row gives each button a third of the width instead
// of a quarter.
//
// ── THE PICKER REPLACES THE MESSAGE, AND COMES BACK ──────────────────────────
//
// Exactly the `symp:` → `symsev:` drill-down (#859): the keyboard is swapped in place
// through `rebuildMessage`, and `↩︎ Back` rebuilds the original message unchanged. No
// server-side pending state — the token carries the burst anchor, so an abandoned picker
// is just a keyboard whose buttons the hourly sweep can judge from the ledger like any
// other.

import {
  burstLabel,
  burstSubject,
  chipOffers,
  correctionAtToken,
  correctionChipToken,
  correctionDayDate,
  offeredHours,
  pickerHourLabel,
  PICKER_PREV_DAY_LABEL,
  type CorrectionBurst,
  type CorrectionDay,
} from "../correction-time";
import type { NotificationAction } from "./types";
import { formatMessageLine } from "./message-line";
import { GLYPH } from "./glyphs";

// What one domain's correction affordance needs from the shared renderer: its two
// callback prefixes, and what KIND OF STORE is behind them.
export interface CorrectionPrefixes {
  // The −Nh chips.
  chip: string;
  // The absolute-hour picker: open, back, and each offered hour.
  at: string;
  // Does this domain store a profile-local DAY plus a time, rather than an instant?
  //
  // It changes what may be OFFERED, which is why it rides here beside the prefixes
  // rather than being passed at each call site. An instant store absorbs a correction
  // that crosses local midnight — food re-dates the serving, dose keeps the adherence
  // day and says so — but a day-keyed store's write core REFUSES one, so every offer
  // THE DAY RULE re-dates is a button that cannot work. See the day-keyed block in
  // lib/correction-time.ts; `chipOffers` and `offeredHours` are where the bound lands.
  dayKeyed: boolean;
  // WHERE THE APP'S OWN CORRECTION SURFACE FOR THIS DOMAIN IS (#3010).
  //
  // The chat is a TRAILING EDIT for a fresh burst — one hour, one or two days of hours —
  // and that is deliberate (`CORRECTION_FRESH_MIN`, the hourly sweep's steady state).
  // What was not deliberate is where the chat's edge left the user: an aged-out burst
  // simply stopped being drawn, and an answer past the offered days refused without
  // saying where the answer belongs. The app's own sheet edits a whole week, so the
  // refusals name it — the same phrase every time, per domain, so a dead end always ends
  // somewhere.
  appSurface: string;
}

export const FOOD_TIME_PREFIXES: CorrectionPrefixes = {
  chip: "foodtime",
  at: "foodtimeat",
  dayKeyed: false,
  // The food bar's correction sheet (#2227) edits any serving in the log's seven-day
  // recent range, day + hour.
  appSurface: "the food log on the Nutrition page",
};

export const DOSE_TIME_PREFIXES: CorrectionPrefixes = {
  chip: "dosetime",
  at: "dosetimeat",
  dayKeyed: false,
  appSurface: "the dose history in the app",
};

// The third domain (#2875). Practices were the third to gain one-tap logging and never
// got the correction substrate, which is why a sauna at 19:00 acknowledged at 21:30 was
// stored — and could only be stored — as a 21:30 session. That is worse than a wrong
// display: `modalHour()` reads this column to pick each practice's typical hour and
// #2188's retimed pace nudge fires at it, so a late acknowledgement teaches the
// inference a later hour, which fires the next nudge later, which is acknowledged later
// still. Two more prefixes is MOST of the extension — the chips, the picker, the burst
// collapse and the statement of record above are domain-blind about everything except
// the one thing this domain does differently: it is DAY-KEYED, so what may be offered is
// bounded by the burst's own local day as well as by the clock.
export const PRACTICE_TIME_PREFIXES: CorrectionPrefixes = {
  chip: "practime",
  at: "practimeat",
  dayKeyed: true,
  appSurface: "the practice log in the app",
};

// Which bursts a day-keyed domain can still correct FROM THE CHAT, and which it cannot
// (#2875).
//
// A burst is OFF SCOPE when nothing is left to offer it: no chip stays on its day and no
// picker hour lands on it. That is not a corner — in the hour after local midnight it is
// EVERY burst, because both chips and every offered hour resolve to yesterday, and a
// burst whose own rows straddle midnight is off scope at any hour because one instant
// cannot be written onto two days. An off-scope burst gets NO row: drawing a keyboard
// whose every button answers "that would move the session to another day" is worse than
// saying so once, in the body, where `correctionOffScopeStatement` says it.
//
// An instant-keyed domain never has one — food and dose absorb the crossing — so this
// splits nothing for them and they keep exactly the rows they had.
export function correctableBursts(
  prefixes: CorrectionPrefixes,
  bursts: readonly CorrectionBurst[],
  now: Date,
  tz: string
): { shown: CorrectionBurst[]; offScope: CorrectionBurst[] } {
  if (!prefixes.dayKeyed) return { shown: [...bursts], offScope: [] };
  const shown: CorrectionBurst[] = [];
  const offScope: CorrectionBurst[] = [];
  for (const burst of bursts) {
    const hasOffer =
      chipOffers(burst, now, tz, true).length > 0 ||
      offeredHours(burst, now, tz, true).length > 0 ||
      // Level two counts as an offer (#3010): a session tapped at 23:50 and corrected at
      // 00:30 is filed under YESTERDAY, so every level-one hour is off its day while
      // yesterday's own hours are exactly what it needs.
      offeredHours(burst, now, tz, true, "prev").length > 0;
    (hasOffer ? shown : offScope).push(burst);
  }
  return { shown, offScope };
}

// One row per burst: the named picker button, then the chips. Rows are keyed by the
// burst's anchor id so two bursts never collapse onto one keyboard row.
//
// `now` is what bounds the chips: `chipOffers` drops any step that would walk the burst
// past the floor, so a burst already corrected to the edge of the picker's reach renders
// its label button alone and the drill-down is the only path left (#2206). For a
// day-keyed domain the burst's own local day bounds them too, and a burst with nothing
// left at all is dropped here rather than drawn — the filter lives INSIDE the renderer so
// no caller can render the unfiltered set by forgetting to ask.
export function correctionActions(
  prefixes: CorrectionPrefixes,
  profileId: number,
  bursts: readonly CorrectionBurst[],
  tz: string,
  now: Date
): NotificationAction[] {
  const out: NotificationAction[] = [];
  for (const burst of correctableBursts(prefixes, bursts, now, tz).shown) {
    const row = `${prefixes.chip}-${burst.fromId}`;
    out.push({
      label: `${GLYPH.eventTime} ${burstLabel(burst, tz, now)}`,
      data: correctionAtToken(prefixes.at, profileId, burst.fromId, {
        kind: "open",
      }),
      row,
    });
    for (const offer of chipOffers(burst, now, tz, prefixes.dayKeyed)) {
      out.push({
        label: offer.label,
        data: correctionChipToken(
          prefixes.chip,
          profileId,
          burst.fromId,
          offer.minutesBack
        ),
        row,
      });
    }
  }
  return out;
}

// The drill-down keyboard: the offered absolute hours three per row, then `↩︎ Back`.
// Three per row because a bare "HH:MM" label is short and the grid then costs a handful
// of rows instead of one per hour. (The chips beside the label button carry an offset
// suffix too and so ride three-to-a-row at most, which is what the correction row is.)
//
// The hours are the burst's, not merely the clock's — a day-keyed domain drops the ones
// THE DAY RULE would re-date, so the picker offers only what its write core accepts. It
// can be left with none while the chips still stand (roughly 01:00–02:00 local, when a
// −30m step is legal and the picker's own reach starts two hours back); the title says
// so — see `correctionPickerTitle`.
export function correctionPickerActions(
  prefixes: CorrectionPrefixes,
  profileId: number,
  burst: CorrectionBurst,
  now: Date,
  tz: string,
  level: CorrectionDay = "today"
): NotificationAction[] {
  const hours = offeredHours(burst, now, tz, prefixes.dayKeyed, level);
  // The day level two is showing, STAMPED INTO EVERY TOKEN IT MINTS (#3010). Level two
  // means "the day before now", so a token that only said `p:` would re-resolve against
  // a rolled clock and land 24 hours on; the handler compares this against the day it
  // re-derives at tap time and refuses anything else.
  const levelDate = correctionDayDate(level, now, tz);
  const out: NotificationAction[] = hours.map((hhmm, i) => ({
    // Each button states the DAY half of its result too (#3010/#2206) — the grid has
    // always crossed midnight and never said so.
    label: pickerHourLabel(hhmm, level, now, tz),
    data: correctionAtToken(
      prefixes.at,
      profileId,
      burst.fromId,
      level === "prev"
        ? { kind: "at", hhmm, day: "prev", date: levelDate }
        : { kind: "at", hhmm, day: "today" }
    ),
    row: `pick${Math.floor(i / 3)}`,
  }));
  // THE DAY LEVEL (#3010). Level one carries the step down to yesterday, and it is drawn
  // only when yesterday actually has something to offer THIS burst — which is how a
  // day-keyed domain gets the change for free: a practice filed under today can accept no
  // instant on another day, so its level-two set is empty and the row simply does not
  // appear. No `dayKeyed` special case here; the domain bound already answered.
  if (
    level === "today" &&
    offeredHours(burst, now, tz, prefixes.dayKeyed, "prev").length > 0
  ) {
    out.push({
      label: PICKER_PREV_DAY_LABEL,
      data: correctionAtToken(prefixes.at, profileId, burst.fromId, {
        kind: "prev",
      }),
      row: "pickday",
    });
  }
  // `↩︎ Back` returns to the MESSAGE from either level, and it is also the tell
  // `openPickerAnchor` reads to know a picker is open — so it must exist on both.
  out.push({
    label: `${GLYPH.back} Back`,
    data: correctionAtToken(prefixes.at, profileId, burst.fromId, {
      kind: "back",
    }),
    row: "pickback",
  });
  return out;
}

// The BODY'S statement of record for a corrected burst (#2264 bug 1), for both domains.
//
// The row's label button carries the whole corrected value ("×4 12:42 (corrected)"),
// and on a phone that button clips — `🕐 ×4 12:42 (cor…` — so after a correction the
// message never states, anywhere readable, what time the ledger now holds. The body is
// where a value is STATED (the row stays the control), so a corrected burst gets one
// explicit sentence naming the resulting instant; an uncorrected burst adds nothing and
// the message keeps today's copy.
//
// Built from the SAME `burstLabel` computation as the button — never a second phrasing —
// and covering the multi-burst case (MAX_CORRECTION_ROWS = 2, joined on one line). The
// "(corrected)" marker rides here by design: it belongs on the statement of a value, not
// on a button (see burstSubject's note in lib/correction-time.ts).
//
// `now` reaches it for the DAY half of that value (#3010): "Recorded: Leafy greens 18:00"
// about yesterday evening reads as this evening, and the day level makes a day-crossing
// correction the normal case rather than a post-midnight edge. `burstLabel` owns the
// marker, so the button and the sentence still cannot disagree.
export function correctionBodyStatement(
  bursts: readonly CorrectionBurst[],
  tz: string,
  now: Date
): string | null {
  const corrected = bursts.filter((b) => b.corrected);
  if (corrected.length === 0) return null;
  return formatMessageLine({
    glyph: GLYPH.eventTime,
    head: `Recorded: ${corrected.map((b) => burstLabel(b, tz, now)).join(" · ")}`,
  });
}

// What the body says about a burst this chat can no longer correct (#2875).
//
// The row is gone, so the message has to say why — silence would read as "there was
// nothing to correct", and the chips are the only place this app offers the correction
// at all. Named with the same `burstSubject` the picker asks with, and it names the ONE
// place the answer belongs: a day-keyed session's date is the expanded form's job, which
// is the same sentence the write core's refusal speaks.
//
// ONE LINE PER BURST rather than one line naming several: the statement of record above
// joins its subjects because it states a single value, and this states a REASON, which
// reads as a claim about each burst separately. (MAX_CORRECTION_ROWS caps it at two.)
export function correctionOffScopeStatement(
  bursts: readonly CorrectionBurst[],
  tz: string
): string | null {
  if (bursts.length === 0) return null;
  return bursts
    .map((b) =>
      formatMessageLine({
        glyph: GLYPH.eventTime,
        head: burstSubject(b, tz),
        notes: ["moving this would change its day — correct it in the app"],
      })
    )
    .join("\n");
}

// The picker's question. The subject is the burst as the user knows it; the verb is the
// domain's, because "when did you eat", "when did you take these" and "when was this"
// are the three things a chat can honestly ask about a ledger row whose instant is wrong.
//
// `hours` is what the picker is about to offer, and passing it is how a domain whose
// offer set can be EMPTY asks the question honestly: with no hour left on the burst's own
// day there is nothing to answer, so the title states that instead of inviting a choice
// the keyboard cannot present. A domain that always has hours passes nothing and the
// title is unchanged.
export function correctionPickerTitle(
  verb: string,
  burst: CorrectionBurst,
  tz: string,
  hours?: readonly string[]
): string {
  return formatMessageLine({
    glyph: GLYPH.eventTime,
    head: burstSubject(burst, tz),
    notes: [
      hours && hours.length === 0
        ? "no earlier hour left on this day — correct it in the app"
        : `${verb}?`,
    ],
  });
}

// Is a picker currently OPEN on this keyboard, and on which burst?
//
// The `↩︎ Back` button is the tell: it exists only while the drill-down is showing, so
// its token's anchor names the burst being asked about. Read back off the live keyboard
// exactly as `countVisibleFoodButtons` reads back the expansion — for the same reason
// (#1807): the hourly sweep re-renders from the builder, and without this it would edit
// an open picker away under the user mid-choice. What the user asked to see is theirs;
// reconciliation may only ever REDUCE what a chat claims, never change what it shows.
export function openPickerAnchor(
  tokens: readonly string[],
  prefixes: CorrectionPrefixes
): number | null {
  for (const t of tokens) {
    const f = t.split(":");
    if (f[0] === prefixes.at && f[3] === "back") {
      const id = Number(f[2]);
      if (Number.isInteger(id) && id > 0) return id;
    }
  }
  return null;
}
