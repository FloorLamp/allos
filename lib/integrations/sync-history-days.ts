import { dateStrInTz, parseUtcSql } from "../date";
import { isTruncatedSyncEvent } from "./sync-details";
import { pluralRunNoun } from "./provider-state";
import type {
  StatusTone,
  SyncEventFacts,
  SyncRunNoun,
  SyncVocabulary,
} from "./provider-state";

// Sync history, GROUPED BY DAY (#1991).
//
// The history was an append-only event log rendered one row per run. For a source
// that fires ~70×/day — the Health Connect exporter re-sends its rolling window every
// ~20 minutes — that reads "Synced · N new · 4 changed · 73 unchanged" over and over,
// and the repeating "73 unchanged" is the tell: it is not news. A real anomaly is
// invisible in that stream.
//
// So a day is ONE line, and expanding it itemizes only what earns it:
//
//   - anything that FAILED, was cut short, or SKIPPED rows — with its reason;
//   - the one NEWEST run in the whole ledger, because that is what you came to check;
//   - everything else collapsed to a RANGE ("7 syncs · 128 new"), openable.
//
// This is #137's no-op collapsing generalized from *nothing happened* to *nothing
// notable happened*, and it is frequency-agnostic: Health Connect collapses
// dramatically, an hourly source turns 24 rows into a line plus its anomalies, and a
// once-a-week import renders one line per import either way. No per-provider variants.
//
// PURE — no DB, no React. The caller supplies the profile's time zone, because a
// "day" is the reader's day, not UTC's.

// Why a run is itemized rather than folded into a range.
export type SyncRunReason =
  // The run failed outright.
  | "failed"
  // It succeeded as far as it got, but a page cap / rate limit left data upstream.
  | "partial"
  // It dropped rows it could not map.
  | "skipped"
  // The newest run in the whole ledger.
  | "newest"
  // Nothing notable, and nothing adjacent to fold it into.
  | "routine";

export type SyncDayEntry<T extends SyncEventFacts> =
  | { kind: "run"; ev: T; reason: SyncRunReason }
  | {
      // A maximal run of CONSECUTIVE IDENTICAL failures (#1880 item 3), kept as its
      // own shape so an upstream outage retried hourly reads as one pattern rather
      // than a stripe per attempt. Still itemized — a failure is always notable.
      kind: "failure-run";
      runs: T[];
      error: string | null;
    }
  | {
      // Consecutive unremarkable runs. Collapsed by default, openable ("Show runs").
      kind: "range";
      runs: T[];
    };

export interface SyncDaySummary<T extends SyncEventFacts> {
  // The profile-local day, YYYY-MM-DD.
  day: string;
  runs: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
  failed: number;
  partial: number;
  newestAt: string;
  oldestAt: string;
  entries: SyncDayEntry<T>[];
}

// The profile-local day a stored sync instant falls on. Events are stamped in UTC
// ("YYYY-MM-DD HH:MM:SS"); a reader in UTC+13 and a reader in UTC−10 do not share a
// day boundary, and the grouping must follow the reader's.
export function syncEventDay(at: string, timeZone: string): string {
  const parsed = parseUtcSql(at);
  return parsed ? dateStrInTz(timeZone, parsed) : at.slice(0, 10);
}

// Does this run earn its own line? A failure, a truncated run, or one that skipped
// rows always does — those are the anomalies the stream was burying.
export function notableReason(ev: SyncEventFacts): SyncRunReason | null {
  if (!ev.ok) return "failed";
  if (isTruncatedSyncEvent(ev)) return "partial";
  if ((ev.skipped ?? 0) > 0) return "skipped";
  return null;
}

function num(v: number | null | undefined): number {
  return v ?? 0;
}

// Fold a provider's events (NEWEST-FIRST, as the queries return them) into per-day
// summaries with their itemized entries.
export function groupSyncDays<T extends SyncEventFacts>(
  eventsNewestFirst: readonly T[],
  timeZone: string,
  options: { markLatest?: boolean } = {}
): SyncDaySummary<T>[] {
  const days: SyncDaySummary<T>[] = [];
  let current: { day: string; events: T[] } | null = null;
  const flush = () => {
    if (current)
      days.push(
        summarizeDay(current.day, current.events, {
          markNewest: options.markLatest !== false && days.length === 0,
        })
      );
    current = null;
  };
  for (const ev of eventsNewestFirst) {
    const day = syncEventDay(ev.at, timeZone);
    if (!current || current.day !== day) {
      flush();
      current = { day, events: [] };
    }
    current.events.push(ev);
  }
  flush();
  return days;
}

function summarizeDay<T extends SyncEventFacts>(
  day: string,
  events: T[],
  options: { markNewest: boolean }
): SyncDaySummary<T> {
  const entries: SyncDayEntry<T>[] = [];
  let i = 0;
  while (i < events.length) {
    const ev = events[i];
    if (!ev.ok) {
      // Consecutive failures WITH THE SAME REASON collapse; two different causes
      // never become one row.
      let j = i;
      while (
        j < events.length &&
        !events[j].ok &&
        (events[j].error ?? null) === (ev.error ?? null)
      )
        j++;
      const runs = events.slice(i, j);
      if (runs.length === 1)
        entries.push({ kind: "run", ev, reason: "failed" });
      else entries.push({ kind: "failure-run", runs, error: ev.error ?? null });
      i = j;
      continue;
    }
    // "Latest" is global history state, not something every day can claim. Only
    // the first run in the newest day earns it; older routine runs fold normally.
    const reason = options.markNewest && i === 0 ? "newest" : notableReason(ev);
    if (reason) {
      entries.push({ kind: "run", ev, reason });
      i++;
      continue;
    }
    let j = i;
    while (j < events.length && events[j].ok && !notableReason(events[j])) j++;
    const runs = events.slice(i, j);
    // A lone unremarkable run is not a range — collapsing it would hide a line and
    // gain nothing, so it renders as itself.
    if (runs.length === 1)
      entries.push({ kind: "run", ev: runs[0], reason: "routine" });
    else entries.push({ kind: "range", runs });
    i = j;
  }

  return {
    day,
    runs: events.length,
    inserted: events.reduce((n, e) => n + num(e.inserted), 0),
    updated: events.reduce((n, e) => n + num(e.updated), 0),
    unchanged: events.reduce((n, e) => n + num(e.unchanged), 0),
    skipped: events.reduce((n, e) => n + num(e.skipped), 0),
    failed: events.filter((e) => !e.ok).length,
    partial: events.filter((e) => e.ok && isTruncatedSyncEvent(e)).length,
    newestAt: events[0].at,
    oldestAt: events[events.length - 1].at,
    entries,
  };
}

// ---- Labels ----------------------------------------------------------------

export function countLabel(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

function runCount(n: number, noun: SyncRunNoun): string {
  return `${n} ${n === 1 ? noun : pluralRunNoun(noun)}`;
}

// A day's one line: "26 pushes · 340 new · 12 changed". Zero terms are dropped —
// a day that wrote nothing says so once instead of printing two zeros — and a cache
// provider speaks the forecast dialect, where the only interesting figure is how much
// of the republished window this day REVISED.
export function syncDayLabel(
  day: { runs: number; inserted: number; updated: number },
  noun: SyncRunNoun,
  vocabulary: SyncVocabulary = "records"
): string {
  const runs = runCount(day.runs, noun);
  if (vocabulary === "forecast") {
    const revised = day.inserted + day.updated;
    return revised === 0
      ? `${runs} · no change`
      : `${runs} · ${countLabel(revised, "reading")} revised`;
  }
  const parts: string[] = [];
  if (day.inserted > 0) parts.push(`${day.inserted} new`);
  if (day.updated > 0) parts.push(`${day.updated} changed`);
  return parts.length
    ? `${runs} · ${parts.join(" · ")}`
    : `${runs} · no new data`;
}

// The chip a day carries when it contains something worth opening it for. One chip,
// worst-first: a failure outranks a cut-short run, which outranks dropped rows.
export function syncDayAttention(day: {
  failed: number;
  partial: number;
  skipped: number;
}): { label: string; tone: StatusTone } | null {
  if (day.failed > 0) return { label: `${day.failed} failed`, tone: "bad" };
  if (day.partial > 0) return { label: "partial", tone: "caution" };
  if (day.skipped > 0)
    return { label: `${day.skipped} skipped`, tone: "caution" };
  return null;
}

// A collapsed failure run's shared reason, count-qualified so the line still says the
// reason held for EVERY run it collapsed (#1880 item 3). Null when the runs carried no
// recorded reason.
export function failureRunReason(
  count: number,
  error: string | null
): string | null {
  if (!error) return null;
  return count === 2 ? `${error} — both runs` : `${error} — all ${count} runs`;
}

// A collapsed range's accounting label: "7 syncs · 128 new". The ledger renders
// "Routine" in its aligned result column, while the time span beside it comes from
// the runs' own timestamps in the reader's clock.
export function syncRangeLabel(
  runs: readonly SyncEventFacts[],
  noun: SyncRunNoun,
  vocabulary: SyncVocabulary = "records"
): string {
  const inserted = runs.reduce((n, e) => n + num(e.inserted), 0);
  const updated = runs.reduce((n, e) => n + num(e.updated), 0);
  const head = runCount(runs.length, noun);
  if (vocabulary === "forecast") {
    const revised = inserted + updated;
    return revised === 0
      ? head
      : `${head} · ${countLabel(revised, "reading")} revised`;
  }
  const parts: string[] = [];
  if (inserted > 0) parts.push(`${inserted} new`);
  if (updated > 0) parts.push(`${updated} changed`);
  return parts.length ? `${head} · ${parts.join(" · ")}` : head;
}

// ---- The drill-in's honest count (#1991 defect 1) --------------------------

// "What this wrote (30)" used to label the SPLIT total while listing only
// `integration_sync_rows` — and `recordSyncRows` deliberately skips minute-grain
// tables with no row id (hr_minutes) and other non-user-meaningful targets. On a
// Health Connect push the count overstated by 10× and said nothing about the gap, so
// a partial list looked complete. The drill-in now counts what it can SHOW, and the
// remainder is named rather than hidden.
export interface DrilldownCoverage {
  // Rows the drill-in will actually list.
  itemizable: number;
  // Rows this run wrote that carry no openable identity.
  remainder: number;
  // Whether to offer the drill-in at all.
  offer: boolean;
}

export function drilldownCoverage(
  written: number,
  itemizable: number
): DrilldownCoverage {
  const capped = Math.min(Math.max(itemizable, 0), Math.max(written, 0));
  return {
    itemizable: capped,
    remainder: Math.max(written - capped, 0),
    // Nothing to open is NOT an apologetic empty expander (#1771): a provider that
    // writes cells of a global forecast cache names no user record, and gets no
    // drill-in at all.
    offer: capped > 0,
  };
}

// The remainder, named honestly beside the list: "+27 more this run wrote — no
// per-record link". Deliberately NOT a guess at WHICH rows: the provenance table is
// what knows, and it does not record them; asserting "heart-rate samples" from a
// subtraction would be the system claiming knowledge it does not have.
export function drilldownRemainderLabel(remainder: number): string | null {
  if (remainder <= 0) return null;
  return `+${remainder} more this run wrote — not itemizable (no per-record link)`;
}
