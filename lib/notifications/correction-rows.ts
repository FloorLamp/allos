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
// The row wants four things on it: what it is about, and three chips. A phone gives a
// four-button row about ninety points each, and a fifth button for the picker would
// shrink all of them below legibility. So the LABEL button is the picker: tapping the
// thing the row names is what opens "when was this, exactly", which is also the more
// discoverable gesture — the escape hatch sits on the subject rather than beside it.
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
  chipLabel,
  correctionAtToken,
  correctionChipToken,
  CORRECTION_CHIP_HOURS,
  pickerHourOptions,
  type CorrectionBurst,
} from "../correction-time";
import type { NotificationAction } from "./types";

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
export function correctionActions(
  prefixes: CorrectionPrefixes,
  profileId: number,
  bursts: readonly CorrectionBurst[],
  tz: string
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
    for (const hours of CORRECTION_CHIP_HOURS) {
      out.push({
        label: chipLabel(hours),
        data: correctionChipToken(
          prefixes.chip,
          profileId,
          burst.fromId,
          hours * 60
        ),
        row,
      });
    }
  }
  return out;
}

// The drill-down keyboard: the offered absolute hours three per row, then `↩︎ Back`.
// Three per row because an "HH:MM" label is short and a nine-option grid then costs
// three rows instead of nine.
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

// The picker's question. The subject is the burst as the user knows it; the verb is the
// domain's, because "when did you eat" and "when did you take these" are the two things
// a chat can honestly ask about a ledger row whose instant is wrong.
export function correctionPickerTitle(
  verb: string,
  burst: CorrectionBurst,
  tz: string
): string {
  return `🕐 ${burstSubject(burst, tz)} — ${verb}?`;
}
