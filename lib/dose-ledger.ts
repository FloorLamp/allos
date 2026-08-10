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

import type { SupplementKind } from "./types";
import { DOSE_LEDGER_ALL_KINDS } from "./hrefs";
import { shiftDateStr } from "./date";
import { ALL_TIME_RANGE_VALUE, type DateRange } from "./timeline-format";
import { DOSE_HISTORY_DAYS } from "./supplement-adherence";

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
  surface: SupplementKind
): DoseLedgerKindFilter {
  return DOSE_LEDGER_KIND_FILTERS.includes(raw as DoseLedgerKindFilter)
    ? (raw as DoseLedgerKindFilter)
    : surface;
}

// The kind actually handed to the reader: `all` asks for no kind narrowing at all.
export function doseLedgerQueryKind(
  filter: DoseLedgerKindFilter
): SupplementKind | undefined {
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

// What the list is bounded to, said out loud rather than left implicit: a ledger that
// stops at its window's edge must never read as "you took nothing before this". An
// all-time window states no bound because it has none.
export function doseLedgerWindowNote(range: DateRange): string | undefined {
  if (!range.from && !range.to) return undefined;
  if (range.from && range.to)
    return `Showing confirmed doses from ${range.from} to ${range.to}. Older doses are still on record.`;
  if (range.from)
    return `Showing confirmed doses from ${range.from} onward. Older doses are still on record.`;
  return `Showing confirmed doses up to ${range.to}.`;
}
