// The correction ride-along, rendered (issues #2019, #2020) — pure, DB-free.
//
// Turns the burst model in lib/correction-time.ts into keyboard rows, once, for both
// domains. Food and doses differ ONLY in their two token prefixes and in the verb the
// picker asks with ("when did you eat" / "when did you take these"); everything about
// the shape — which chips, in what order, how a burst is named, how the drill-down
// opens and comes back — is decided here so the two chats cannot drift apart.
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
  pickerHourOptions,
  type CorrectionBurst,
} from "../correction-time";
import type { NotificationAction } from "./types";
import { formatMessageLine } from "./message-line";

// The two callback prefixes one domain's correction affordance uses.
export interface CorrectionPrefixes {
  // The −Nh chips.
  chip: string;
  // The absolute-hour picker: open, back, and each offered hour.
  at: string;
}

export const FOOD_TIME_PREFIXES: CorrectionPrefixes = {
  chip: "foodtime",
  at: "foodtimeat",
};

export const DOSE_TIME_PREFIXES: CorrectionPrefixes = {
  chip: "dosetime",
  at: "dosetimeat",
};

// One row per burst: the named picker button, then the chips. Rows are keyed by the
// burst's anchor id so two bursts never collapse onto one keyboard row.
//
// `now` is what bounds the chips: `chipOffers` drops any step that would walk the burst
// past the floor, so a burst already corrected to the edge of the picker's reach renders
// its label button alone and the drill-down is the only path left (#2206).
export function correctionActions(
  prefixes: CorrectionPrefixes,
  profileId: number,
  bursts: readonly CorrectionBurst[],
  tz: string,
  now: Date
): NotificationAction[] {
  const out: NotificationAction[] = [];
  for (const burst of bursts) {
    const row = `${prefixes.chip}-${burst.fromId}`;
    out.push({
      label: `🕐 ${burstLabel(burst, tz)}`,
      data: correctionAtToken(prefixes.at, profileId, burst.fromId, {
        kind: "open",
      }),
      row,
    });
    for (const offer of chipOffers(burst, now, tz)) {
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
export function correctionPickerActions(
  prefixes: CorrectionPrefixes,
  profileId: number,
  burst: CorrectionBurst,
  now: Date,
  tz: string
): NotificationAction[] {
  const hours = pickerHourOptions(now, tz);
  const out: NotificationAction[] = hours.map((hhmm, i) => ({
    label: hhmm,
    data: correctionAtToken(prefixes.at, profileId, burst.fromId, {
      kind: "at",
      hhmm,
    }),
    row: `pick${Math.floor(i / 3)}`,
  }));
  out.push({
    label: "↩︎ Back",
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
export function correctionBodyStatement(
  bursts: readonly CorrectionBurst[],
  tz: string
): string | null {
  const corrected = bursts.filter((b) => b.corrected);
  if (corrected.length === 0) return null;
  return formatMessageLine({
    glyph: "🕐",
    head: `Recorded: ${corrected.map((b) => burstLabel(b, tz)).join(" · ")}`,
  });
}

// The picker's question. The subject is the burst as the user knows it; the verb is the
// domain's, because "when did you eat" and "when did you take these" are the two things
// a chat can honestly ask about a ledger row whose instant is wrong.
export function correctionPickerTitle(
  verb: string,
  burst: CorrectionBurst,
  tz: string
): string {
  return formatMessageLine({
    glyph: "🕐",
    head: burstSubject(burst, tz),
    notes: [`${verb}?`],
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
