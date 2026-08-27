// Column select-all for the kind × channel routing matrix (#1868 §2, owner-requested).
// PURE: no DB, no clock, no network.
//
// The matrix is 13 kinds × 3 channels, and turning a whole channel off was 13 taps.
// This is a BULK EDIT over the per-channel disabled-kinds keys that already exist
// (`telegram_notify_disabled_kinds`, `push_notify_disabled_kinds`,
// `ha_notify_disabled_kinds`) — it adds no setting, no storage, and no delivery
// semantics. The one new decision is which kinds a sweep may touch, and that decision
// is the #928 safety rule:
//
//   SAFETY KINDS ARE NEVER SWEPT. Dose reminders, missed-dose escalation and the PRN
//   redose notice keep their INDIVIDUAL checkboxes (and the existing warn-never-block
//   all-off notice), so a safety signal can never be silenced by one undifferentiated
//   tap. The header control's copy states that plainly rather than leaving it implied.
//
// Row-level select-all is deliberately absent (#1868): a row spans three cells and
// overlaps the per-kind enable, which is complexity without relief.

import type { NotificationKind } from "./types";
import { isSafetyKind } from "./kinds";

// What a column header shows: every sweepable cell on, every one off, or a mix.
export type ColumnBulkState = "all" | "none" | "mixed";

// The kinds a column sweep may write, out of the kinds that actually HAVE a cell in
// that column (the caller drops un-rendered rows and inherently undeliverable cells,
// e.g. push × food). The safety exclusion happens HERE, once, for every caller — a
// second filter somewhere else is how this rule would rot.
export function sweepableKinds(
  cellKinds: readonly NotificationKind[]
): NotificationKind[] {
  return cellKinds.filter((k) => !isSafetyKind(k));
}

// The tri-state a column header renders. "On" is ABSENCE from the disabled set, the
// same enabled-unless-disabled convention `isKindEnabled` uses. A column with nothing
// sweepable reads "none": there is nothing the control could turn on.
export function columnBulkState(
  sweepable: readonly NotificationKind[],
  disabled: ReadonlySet<NotificationKind>
): ColumnBulkState {
  if (sweepable.length === 0) return "none";
  const on = sweepable.filter((k) => !disabled.has(k)).length;
  if (on === sweepable.length) return "all";
  if (on === 0) return "none";
  return "mixed";
}

// What a header tap does: a fully-on column turns off, anything else turns on — the
// conventional tri-state, and the reason the control's copy leads with the off case.
export function nextColumnBulkTarget(state: ColumnBulkState): boolean {
  return state !== "all";
}

// The next DISABLED set after a sweep. Kinds OUTSIDE `sweepable` — the safety kinds,
// plus anything with no cell in this column — are carried through exactly as stored,
// so a sweep can neither silence nor un-silence them.
export function applyColumnBulk(
  disabled: readonly NotificationKind[],
  sweepable: readonly NotificationKind[],
  on: boolean
): NotificationKind[] {
  const sweep = new Set(sweepable);
  const kept = disabled.filter((k) => !sweep.has(k));
  return on ? kept : [...kept, ...new Set(sweepable)];
}

// The header control's accessible name, which is also its hover tooltip. It says what
// the tap will do AND states the safety carve-out, because "turn off this column" that
// quietly spares three rows would otherwise be a lie of omission.
//
// IT LEADS WITH THE TEXT THE COLUMN SHOWS (#3556, WCAG 2.5.3 Label in Name, Level A).
// The header prints a SHORT form because the desktop column is 40px wide — "HA", not
// "Home Assistant" (#3495) — and that short form is a visible label on this checkbox.
// A name that said only "Home Assistant" contains no "HA", so a speech-input user
// saying what they can see cannot reach the control. Both forms are kept rather than
// one traded for the other: shortening the name would degrade what a screen-reader
// user hears, and widening the column is the layout defect #3495 fixed. The visible
// form goes FIRST because speech input matches from the start of the name.
//
// A channel whose short form is already inside its full name says the full name once:
// "Push" is inside "Web Push", and Telegram and Email spell both forms the same. The
// criterion is containment, so "Push (Web Push)" would be noise. Home Assistant is
// today's only column where the two forms share no substring.
export function columnBulkLabel(
  visibleLabel: string,
  channelLabel: string,
  state: ColumnBulkState
): string {
  const name = channelLabel.toLowerCase().includes(visibleLabel.toLowerCase())
    ? channelLabel
    : `${visibleLabel} (${channelLabel})`;
  return state === "all"
    ? `${name}: turn off everything except safety reminders`
    : `${name}: turn on every kind`;
}
