// PURE shaping/summarizing helpers for the integration sync-event debug log
// (integration_sync_events). Kept free of any `@/lib/db` import so it stays in the
// pure unit tier (lib/__tests__) — the impure event WRITER lives in
// lib/integrations/connections.ts (recordSyncEvent) and the READER in
// lib/queries/integrations.ts. Both call into this module for the count/window math.

export interface SyncCounts {
  received: number;
  written: number;
  skipped: number;
}

// Real insert/update/unchanged accounting for a sync batch. Unlike
// SyncCounts (which only knows how many rows were persisted), this distinguishes
// a brand-new row (inserted) from a value-changing overwrite (updated) from a
// no-op re-send of the rolling window (unchanged). "unchanged" is ONLY detectable
// by reading the pre-image row and comparing it to the resolved post-image —
// better-sqlite3's `info.changes` counts a matched row even when no value differs,
// so a no-op UPDATE would look like a write. Each upsert does that SELECT-compare
// and folds a per-type UpsertCounts up into the sync event.
export interface UpsertCounts {
  inserted: number;
  updated: number;
  unchanged: number;
}

export function emptyCounts(): UpsertCounts {
  return { inserted: 0, updated: 0, unchanged: 0 };
}

// The user-edit lock (issue #133): true when an integration-owned row has been
// hand-edited in the app and MUST NOT be overwritten by a re-ingest of the rolling
// window. Every keyed upsert consults this on the row it found (activities.edited,
// body_metrics.edited, medical_records.edited) and, when locked, deliberately
// persists nothing and counts the row as `unchanged` — we touched no value, so the
// split must not report it as a write. The DB stores 0/1 (nullable historically),
// so this normalizes any falsy/absent value to "not locked". Pure → unit-testable.
export function isEditLocked(edited: number | null | undefined): boolean {
  return !!edited;
}

// Field-wise sum of several per-type UpsertCounts into one batch total. Pure.
export function foldCounts(parts: UpsertCounts[]): UpsertCounts {
  const out = emptyCounts();
  for (const p of parts) {
    out.inserted += p.inserted;
    out.updated += p.updated;
    out.unchanged += p.unchanged;
  }
  return out;
}

// The full received-side split of a batch: the insert/update/unchanged accounting
// plus the parser's `skipped` drops. `received` is everything the source handed us
// (inserted + updated + unchanged + skipped). Pure → unit-testable.
export interface SyncSplit extends UpsertCounts {
  skipped: number;
  received: number;
}

export function summarizeSplit(
  counts: UpsertCounts,
  skipped: number
): SyncSplit {
  const inserted = Math.max(0, Math.round(counts.inserted));
  const updated = Math.max(0, Math.round(counts.updated));
  const unchanged = Math.max(0, Math.round(counts.unchanged));
  const s = Math.max(0, Math.round(skipped));
  return {
    inserted,
    updated,
    unchanged,
    skipped: s,
    received: inserted + updated + unchanged + s,
  };
}

// Compare two rows on a fixed column set, normalizing null/undefined so a missing
// incoming field and a stored NULL are equal. Values are pre-rounded before they
// reach the upserts, so exact === is correct here. Pure → unit-testable; used by
// the upserts to decide unchanged-vs-updated on the pre-image/post-image pair.
export function rowsEqual(
  cols: string[],
  a: Record<string, unknown>,
  b: Record<string, unknown>
): boolean {
  for (const c of cols) {
    const av = a[c] ?? null;
    const bv = b[c] ?? null;
    if (av !== bv) return false;
  }
  return true;
}

// The human label for a sync event's count split, for the Data → Review feed.
// When the split columns are present it reads "N new · N changed · N unchanged"
// (zero segments omitted); when nothing was inserted or updated it collapses to a
// muted "nothing new"; and when the split columns are all null (a legacy event
// recorded before the split columns existed) it falls back to the flat `written` count. Pure.
export function formatSplitLabel(ev: {
  inserted: number | null;
  updated: number | null;
  unchanged: number | null;
  written: number | null;
}): { primary: string; muted: boolean } {
  const { inserted, updated, unchanged } = ev;
  if (inserted === null && updated === null && unchanged === null) {
    const w = ev.written ?? 0;
    return { primary: `${w} ${w === 1 ? "record" : "records"}`, muted: false };
  }
  const ins = inserted ?? 0;
  const upd = updated ?? 0;
  const unch = unchanged ?? 0;
  if (ins + upd === 0) {
    return { primary: "nothing new", muted: true };
  }
  const segs: string[] = [];
  if (ins > 0) segs.push(`${ins} new`);
  if (upd > 0) segs.push(`${upd} changed`);
  if (unch > 0) segs.push(`${unch} unchanged`);
  return { primary: segs.join(" · "), muted: false };
}

// Derive the {received, written, skipped} triple for a sync batch from the two
// numbers the ingest already computes: `written` = normalized rows the idempotent
// upserts persisted (a resend of the rolling window overwrites its row IN PLACE
// rather than duplicating, which is what keeps ingest idempotent), and `skipped` =
// rows received from the source that were NOT persisted — the parser's drops
// (malformed / unmappable / duplicate-in-batch). So `received` = written + skipped.
// NOTE: this is deliberately NOT a natural-key idempotent-dedup count — the upserts
// count an in-place UPDATE as `written`, so distinguishing new-vs-existing rows
// would mean threading an insert/update split through every heterogeneous upsert
// (hr_minutes has no autoincrement id; body_metrics merges) — too invasive for a
// debug panel. `skipped` honestly reflects what is measured. Pure → unit-testable.
export function summarizeSync(written: number, skipped: number): SyncCounts {
  const w = Math.max(0, Math.round(written));
  const s = Math.max(0, Math.round(skipped));
  return { received: w + s, written: w, skipped: s };
}

// The data window a batch covered, as [min, max] of the supplied date/time strings
// (nulls when the batch carried none). Blanks are ignored; comparison is
// lexicographic, which is correct for the zero-padded ISO/`YYYY-MM-DD` forms the
// normalizers emit. Pure.
export function dateWindow(dates: (string | null | undefined)[]): {
  start: string | null;
  end: string | null;
} {
  let start: string | null = null;
  let end: string | null = null;
  for (const d of dates) {
    if (!d) continue;
    if (start === null || d < start) start = d;
    if (end === null || d > end) end = d;
  }
  return { start, end };
}

// A tidy human label for a batch's data window ("no data", one date, or a range).
// Pure; used by the debug panel table.
export function formatWindow(start: string | null, end: string | null): string {
  if (!start && !end) return "—";
  if (start && end && start !== end) return `${start} → ${end}`;
  return (start ?? end) as string;
}

// A "no-op" sync (issue #137): a SUCCESSFUL sync that brought nothing meaningful in
// — 0 inserted AND 0 updated (an all-unchanged re-scan of the rolling window, or an
// empty incremental pull). A push-based integration that checks in hourly emits one
// of these every hour, which floods the Review feed; the feed collapses consecutive
// no-ops per provider into a single summary line. A FAILURE is never a no-op (it's
// always signal that stays visible), and a LEGACY event whose split columns are all
// null predates the accounting — we keep it visible with its flat `written` count
// rather than guessing. Pure → unit-testable.
export function isNoOpSyncEvent(ev: {
  ok: number;
  inserted: number | null;
  updated: number | null;
  unchanged: number | null;
}): boolean {
  if (!ev.ok) return false;
  if (ev.inserted === null && ev.updated === null && ev.unchanged === null) {
    return false;
  }
  return (ev.inserted ?? 0) + (ev.updated ?? 0) === 0;
}

// The ids to prune from integration_sync_events on the retention sweep (issue #388):
// every event STRICTLY older than `cutoffIso` EXCEPT the newest event per (profile,
// provider), which is kept regardless of age. Keeping the newest-per-provider row is
// what lets a dormant integration's last-known state (a failure that stopped
// syncing, say) survive the 90-day window so currentlyFailingProviders can still see
// it. `cutoffIso` is the retention boundary (`< cutoff` is expired, matching the SQL
// `at < datetime('now', ?)`). Newest is by id (AUTOINCREMENT, monotonic with `at`),
// mirroring the SQL's `MAX(id) … GROUP BY profile_id, provider`. Pure →
// unit-testable, and pinned byte-for-byte against the DB sweep in the db tier.
export function planSyncEventPrune<
  T extends { id: number; profile_id: number; provider: string; at: string },
>(events: readonly T[], cutoffIso: string): number[] {
  const newestId = new Map<string, number>();
  for (const e of events) {
    const key = `${e.profile_id} ${e.provider}`;
    const cur = newestId.get(key);
    if (cur === undefined || e.id > cur) newestId.set(key, e.id);
  }
  const keep = new Set(newestId.values());
  return events
    .filter((e) => e.at < cutoffIso && !keep.has(e.id))
    .map((e) => e.id)
    .sort((a, b) => a - b);
}

// Which recurring providers belong in the Data → Review "Connected sources" section
// (issue #294). A provider is shown when it is CURRENTLY connected OR it has any
// historical sync events — a source that was connected and later removed keeps
// showing its logs (with a "Not connected" status + a Reconnect link). A provider
// that was never set up and has no sync history is hidden entirely, rather than
// listing every available integration whether configured or not. Pure → unit-testable.
export function shouldShowConnectedSource(s: {
  connected: boolean;
  hasHistory: boolean;
}): boolean {
  return s.connected || s.hasHistory;
}

// Given sync events ordered NEWEST-FIRST (as the queries return them), collapse to
// the single most recent event per provider — each integration's CURRENT state. This
// is the pure counterpart to the SQL `getLatestSyncEventPerProvider` read: what keeps
// failure-detection honest is feeding this the TRUE latest row per provider rather
// than a global-N window that a chatty provider can push a stale failure out of
// (issue #304). Pure → unit-testable; structurally typed so it doesn't drag @/lib/db
// or the full row type into the pure tier.
export function latestEventPerProvider<T extends { provider: string }>(
  eventsNewestFirst: T[]
): T[] {
  const seen = new Set<string>();
  const latest: T[] = [];
  for (const e of eventsNewestFirst) {
    if (seen.has(e.provider)) continue; // a newer event already represents this provider
    seen.add(e.provider);
    latest.push(e);
  }
  return latest;
}

// The integrations that are *currently* broken: providers whose most recent event is
// a failure (ok = 0). A later successful sync drops a provider off automatically, so
// this is self-clearing and safe to drive a "needs attention" badge/count from. A
// provider flipped to `needs_reauth` (issue #326) records an ok:0 sync event the
// moment its token dies, so it surfaces here too — as long as the caller feeds the
// provider's TRUE latest event (getLatestSyncEventPerProvider), not a windowed slice
// that could have aged that failure out (issue #304). Pure → unit-testable.
export function currentlyFailingProviders<
  T extends { provider: string; ok: number },
>(eventsNewestFirst: T[]): T[] {
  return latestEventPerProvider(eventsNewestFirst).filter((e) => !e.ok);
}
