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
  // Rows the source re-sent that a re-import TOMBSTONE held out (issues #507/#508):
  // a merged-away or user-deleted source-owned row the upsert would otherwise have
  // re-inserted. Counted (never silently dropped) so the Review feed can show
  // "N suppressed" and `received` stays honest.
  suppressed: number;
  // Rows the source re-sent that the user-edit LOCK held out (#133/#659): a
  // hand-corrected imported row the upsert deliberately left untouched. Its own
  // segment (parallel to `suppressed`) rather than folded into `unchanged`, so a user
  // who wonders why the scale "stopped updating" a weight can SEE the lock in Review
  // instead of it hiding behind an ordinary no-op re-send.
  edited: number;
}

export function emptyCounts(): UpsertCounts {
  return { inserted: 0, updated: 0, unchanged: 0, suppressed: 0, edited: 0 };
}

// The ONE source-dedup disposition (#14/#674): the shared classification every keyed
// upsert makes after a pre-image lookup on its source-inclusive natural key. A
// natural key that finds no live row is a brand-new `inserted`; a key that finds a
// row whose resolved post-image equals the pre-image is a no-op re-send of the
// rolling window (`unchanged`); anything else is a value-changing `updated`. This is
// the accounting counterpart of the SELECT-before-compare each upsert does — the
// `valuesEqual` boolean is the caller's own compare (rowsEqual over its compare-cols
// for the 3 that overwrite-or-skip, or a bespoke field compare for metric_samples /
// hr_minutes whose activity_external_id COALESCE / multi-field equality can't be a
// plain rowsEqual). Extracting the branch — not the compare — keeps every importer's
// insert/update/unchanged split IDENTICAL by construction (#221: one computation for
// the dedup question) while leaving each table's own equality and write/skip shape
// intact. Pure → unit-testable.
export type UpsertDisposition = "inserted" | "updated" | "unchanged";

export function classifyUpsert(
  hadRow: boolean,
  valuesEqual: boolean
): UpsertDisposition {
  if (!hadRow) return "inserted";
  return valuesEqual ? "unchanged" : "updated";
}

// Bump the matching UpsertCounts segment for a dedup disposition. The SOLE place the
// three dedup segments (inserted/updated/unchanged) are incremented — every upsert
// routes here so the split can't drift, enforced by the observation-substrate
// boundary test (a raw `counts.inserted++` outside this module fails CI). The
// tombstone `suppressed` and edit-lock `edited` skips stay their own counters at the
// call site: they are HELD-OUT rows, not a dedup classification of a persisted one.
export function tallyUpsert(
  counts: UpsertCounts,
  disposition: UpsertDisposition
): void {
  if (disposition === "inserted") counts.inserted++;
  else if (disposition === "updated") counts.updated++;
  else counts.unchanged++;
}

// The user-edit lock (issue #133): true when an integration-owned row has been
// hand-edited in the app and MUST NOT be overwritten by a re-ingest of the rolling
// window. Every keyed upsert consults this on the row it found (activities.edited,
// body_metrics.edited, medical_records.edited) and, when locked, deliberately
// persists nothing and counts the row in the `edited` split (#659) — parallel to
// `suppressed`, so a lock is visible in Review instead of hiding as an ordinary
// `unchanged` no-op. The DB stores 0/1 (nullable historically), so this normalizes
// any falsy/absent value to "not locked". Pure → unit-testable.
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
    out.suppressed += p.suppressed;
    out.edited += p.edited;
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
  const suppressed = Math.max(0, Math.round(counts.suppressed));
  const edited = Math.max(0, Math.round(counts.edited));
  const s = Math.max(0, Math.round(skipped));
  return {
    inserted,
    updated,
    unchanged,
    suppressed,
    edited,
    skipped: s,
    // A tombstone-suppressed OR edit-locked row WAS handed to us by the source, so it
    // belongs in `received` (no silent cap) even though it was deliberately not
    // persisted.
    received: inserted + updated + unchanged + suppressed + edited + s,
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
  // Tombstone-suppressed re-inserts (#507/#508). Absent on rows recorded before the
  // column existed → treated as 0.
  suppressed?: number | null;
  // Edit-locked skips (#133/#659): imported rows a re-sync left untouched because the
  // user hand-edited them. Absent on rows recorded before the column existed → 0.
  edited?: number | null;
}): { primary: string; muted: boolean } {
  const { inserted, updated, unchanged } = ev;
  if (inserted === null && updated === null && unchanged === null) {
    const w = ev.written ?? 0;
    return { primary: `${w} ${w === 1 ? "record" : "records"}`, muted: false };
  }
  const ins = inserted ?? 0;
  const upd = updated ?? 0;
  const unch = unchanged ?? 0;
  const supp = ev.suppressed ?? 0;
  const edited = ev.edited ?? 0;
  const segs: string[] = [];
  if (ins > 0) segs.push(`${ins} new`);
  if (upd > 0) segs.push(`${upd} changed`);
  if (unch > 0) segs.push(`${unch} unchanged`);
  // A suppressed re-import is meaningful signal — the sync tried to bring back a row
  // the user merged/deleted and the tombstone blocked it — so it shows even when
  // nothing new landed, and keeps the row from reading as a muted "nothing new".
  if (supp > 0) segs.push(`${supp} suppressed`);
  // An edit-locked skip is likewise meaningful — the sync tried to overwrite a
  // hand-corrected row and the lock kept it — so it shows (and un-mutes) too, which
  // is what lets a user find why the provider "stopped updating" that row.
  if (edited > 0) segs.push(`${edited} edited`);
  if (ins + upd + supp + edited === 0) {
    return { primary: "nothing new", muted: true };
  }
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
  // A suppressed re-import is NOT a no-op — the sync actively blocked a resurrection,
  // which the user should see, so it must not collapse into the quiet-sync summary.
  suppressed?: number | null;
  // An edit-locked skip is likewise NOT a no-op — the sync actively held off an
  // overwrite of a hand-edited row, which the user should be able to find.
  edited?: number | null;
}): boolean {
  if (!ev.ok) return false;
  if (ev.inserted === null && ev.updated === null && ev.unchanged === null) {
    return false;
  }
  return (
    (ev.inserted ?? 0) +
      (ev.updated ?? 0) +
      (ev.suppressed ?? 0) +
      (ev.edited ?? 0) ===
    0
  );
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
