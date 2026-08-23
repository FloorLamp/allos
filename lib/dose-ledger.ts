// The cross-item dose ledger's pure vocabulary (#2417).
//
// Dose history is ONE question asked at two scopes — "what did this item's record say"
// (the per-item panel) and "what did I actually take, across items" (the ledger). The
// scopes share a reader (getIntakeDoseHistoryAll) and a renderer (EntryHistoryTable);
// what lives here is only what the ledger surface itself decides: which kind is being
// asked about, and which window.
//
// Both intake surfaces render the same ledger, so these decisions cannot live in either
// page — a /medications copy and a /nutrition copy of "what does no ?kind mean" is the
// split the shared-machinery rule exists to prevent.

import type { IntakeItemKind } from "./types";
import { DOSE_LEDGER_ALL_KINDS } from "./hrefs";
import { shiftDateStr } from "./date";
import { formatMonthDay, type DisplayFormatPrefs } from "./format-date";
import { ALL_TIME_RANGE_VALUE, type DateRange } from "./timeline-format";
import { DOSE_HISTORY_DAYS } from "./intake-adherence";

// The kind filter's three states. `all` is the widening state — the ledger opens
// pre-filtered to the surface's own kind (a supplement's ledger under Nutrition, a
// medication's under Medications), and this is how a reader asks the cross-kind
// question that the per-item panels could never answer.
export const DOSE_LEDGER_KIND_FILTERS = [
  DOSE_LEDGER_ALL_KINDS,
  "supplement",
  "medication",
] as const;

export type DoseLedgerKindFilter = (typeof DOSE_LEDGER_KIND_FILTERS)[number];

export const DOSE_LEDGER_KIND_LABELS: Record<DoseLedgerKindFilter, string> = {
  all: "All",
  supplement: "Supplements",
  medication: "Medications",
};

// Resolve `?kind=` against the surface's own kind. An absent or unrecognised value
// means "this surface's kind" — the pre-filtered default; only an explicit value
// widens or switches.
export function resolveDoseLedgerKind(
  raw: string | undefined,
  surface: IntakeItemKind
): DoseLedgerKindFilter {
  return DOSE_LEDGER_KIND_FILTERS.includes(raw as DoseLedgerKindFilter)
    ? (raw as DoseLedgerKindFilter)
    : surface;
}

// The kind actually handed to the reader: `all` asks for no kind narrowing at all.
export function doseLedgerQueryKind(
  filter: DoseLedgerKindFilter
): IntakeItemKind | undefined {
  return filter === "all" ? undefined : filter;
}

// The ledger's default window: the same DOSE_HISTORY_DAYS the per-item panels bound
// themselves to, so the two scopes of one question show the same span of record unless
// the reader says otherwise.
export function defaultDoseLedgerRange(todayStr: string): DateRange {
  return {
    from: shiftDateStr(todayStr, -(DOSE_HISTORY_DAYS - 1)),
    to: todayStr,
  };
}

// Resolve the ledger's window from its already-parsed params, in precedence order —
// the same three cases the Trends hub resolves, with this surface's own default:
//
//   1. `?range=all` — the explicit all-time window. A URL that says something is
//      never reinterpreted, and the "All time" pill has to be able to SAY itself
//      now that "no params" means a real window.
//   2. Either bound set — used verbatim (a shared link, a quick-range pill, the
//      Trends day panel's single-day drill-in).
//   3. Neither — the DOSE_HISTORY_DAYS default.
export function resolveDoseLedgerRange(
  parsed: DateRange,
  todayStr: string,
  rangeParam?: string
): DateRange {
  if (rangeParam === ALL_TIME_RANGE_VALUE) return {};
  if (parsed.from || parsed.to) return parsed;
  return defaultDoseLedgerRange(todayStr);
}

// The window's bounds as a person reads them (#3478 item 2).
//
// These sentences used to interpolate `range.from`/`range.to` verbatim, so a reader
// was told "Showing confirmed doses from 2026-05-24 to 2026-08-21" — storage format
// in prose, on a page whose every other date already crosses the display boundary.
// The bounds are profile-local DAYS, so they format through `formatMonthDay` with
// the login's prefs and the profile's today: the auto-year rule then has to answer
// "is this the current year" in the PROFILE's clock rather than the process wall
// clock (#2579-B), which is why `todayStr` is threaded rather than defaulted.
//
// `prefs` is REQUIRED, with no default. lib/__tests__/date-locale-guard.test.ts
// forbids pref-less calls of the pref-taking formatters precisely because a default
// silently pins every viewer to one shape; a required parameter says the same thing
// one level earlier, at the sentence rather than at the formatter.
function doseLedgerBound(
  iso: string,
  prefs: DisplayFormatPrefs,
  todayStr: string
): string {
  return formatMonthDay(iso, prefs, { today: todayStr });
}

// What the list is bounded to, said out loud rather than left implicit: a ledger that
// stops at its window's edge must never read as "you took nothing before this". An
// all-time window states no bound because it has none.
export function doseLedgerWindowNote(
  range: DateRange,
  prefs: DisplayFormatPrefs,
  todayStr: string
): string | undefined {
  if (!range.from && !range.to) return undefined;
  const from = range.from && doseLedgerBound(range.from, prefs, todayStr);
  const to = range.to && doseLedgerBound(range.to, prefs, todayStr);
  if (from && to)
    return `Showing confirmed doses from ${from} to ${to}. Older doses are still on record.`;
  if (from)
    return `Showing confirmed doses from ${from} onward. Older doses are still on record.`;
  return `Showing confirmed doses up to ${to}.`;
}

// The noun an EMPTY ledger uses for what it did not find, and the surfaces it sends
// the reader to. A ledger pre-filtered to one kind that then says "confirm a dose on
// Supplements or Medications" is describing a page the reader is not on (#3478
// item 3) — the filter is right there above the sentence saying `Medications`.
const DOSE_LEDGER_EMPTY_NOUNS: Record<DoseLedgerKindFilter, string> = {
  all: "doses",
  supplement: "supplement doses",
  medication: "medication doses",
};

const DOSE_LEDGER_EMPTY_SURFACES: Record<DoseLedgerKindFilter, string> = {
  all: "Supplements or Medications",
  supplement: "Supplements",
  medication: "Medications",
};

// The EMPTY ledger's whole sentence: the state first, its window folded in, and the
// way out (#3478 item 3).
//
// Two sentences used to be stacked in the other order — the window note ("Showing
// confirmed doses from … to …") above a state that then said "in this window",
// pointing back at prose the reader had just been given. Empty, there is nothing to
// "show", so the bound belongs INSIDE the state rather than above it. The populated
// case keeps `doseLedgerWindowNote` unchanged: there the note describes rows that
// are actually on screen.
export function doseLedgerEmptyNote(
  range: DateRange,
  kind: DoseLedgerKindFilter,
  prefs: DisplayFormatPrefs,
  todayStr: string
): string {
  const noun = DOSE_LEDGER_EMPTY_NOUNS[kind];
  const surfaces = DOSE_LEDGER_EMPTY_SURFACES[kind];
  const from = range.from && doseLedgerBound(range.from, prefs, todayStr);
  const to = range.to && doseLedgerBound(range.to, prefs, todayStr);
  // An all-time window has no bound to widen, so it must not offer to widen one.
  if (!from && !to)
    return `No ${noun} confirmed yet. Confirm a dose on ${surfaces}.`;
  const window =
    from && to
      ? `between ${from} and ${to}`
      : from
        ? `since ${from}`
        : `up to ${to}`;
  return `No ${noun} confirmed ${window}. Widen the date range, or confirm a dose on ${surfaces}.`;
}
