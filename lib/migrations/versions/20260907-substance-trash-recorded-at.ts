import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issue #5406: the 20260815 column rename missed `substance-history` snapshots.
// Restore builds its INSERT from each captured row's keys, so move the obsolete key
// inside those holding rows only; live totals and events are already canonical.
//
// Two later migrations also saw the snapshot in that stale shape. The event backfill
// could not derive uses without `recorded_at`, but still stored `events: []`; the notes
// migration visited only live ledgers. Re-running either shipped migration cannot fix
// the capture. For this one legacy shape, derive the same timeless use rows here and
// apply the same one-note rule before Restore sees it. Existing event rows always win.
const KIND = "substance-history";
const ENTITY = "entry";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type LegacyEntry = Record<string, unknown> & {
  profile_id: number;
  substance: string;
  date: string;
  units: number;
  logged_at: string;
};

function isLegacyEntry(entry: Record<string, unknown>): entry is LegacyEntry {
  return (
    Object.hasOwn(entry, "logged_at") &&
    typeof entry.logged_at === "string" &&
    (!Object.hasOwn(entry, "recorded_at") ||
      typeof entry.recorded_at === "string") &&
    typeof entry.profile_id === "number" &&
    typeof entry.substance === "string" &&
    typeof entry.date === "string" &&
    typeof entry.units === "number" &&
    Number.isFinite(entry.units) &&
    entry.units >= 0 &&
    (entry.notes == null || typeof entry.notes === "string")
  );
}

function derivedEvents(entries: LegacyEntry[]): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const entry of entries) {
    const event = {
      profile_id: entry.profile_id,
      substance: entry.substance,
      date: entry.date,
      recorded_at:
        typeof entry.recorded_at === "string"
          ? entry.recorded_at
          : entry.logged_at,
      occurred_at: null,
      time_source: null,
      logged_via: null,
    };
    const count = Math.floor(entry.units);
    for (let i = 0; i < count; i++)
      events.push(
        i === 0 && entry.notes != null
          ? { ...event, notes: entry.notes }
          : { ...event }
      );

    // 20260905-event-notes minted one timeless event when a noted day had no use.
    // Its live-table pass could not see the captured counter, so complete that same
    // historical conversion here.
    if (count === 0 && entry.notes != null)
      events.push({ ...event, notes: entry.notes });
  }
  return events;
}

function rewritePayload(json: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.v !== 1 || parsed.kind !== KIND) return null;
  if (!isRecord(parsed.rows)) return null;
  const entries = parsed.rows[ENTITY];
  if (!Array.isArray(entries) || !entries.every(isRecord)) return null;

  const legacy = entries.filter((entry) => Object.hasOwn(entry, "logged_at"));
  if (legacy.length === 0) return null;
  const events = parsed.rows.events;
  if (events !== undefined && !Array.isArray(events)) return null;
  const needsEvents = events === undefined || events.length === 0;
  let eventsToAdd: Record<string, unknown>[] | null = null;
  if (needsEvents) {
    if (!entries.every(isLegacyEntry)) return null;
    eventsToAdd = derivedEvents(entries);
  }

  for (const entry of entries) {
    if (!Object.hasOwn(entry, "logged_at")) continue;
    if (
      typeof entry.logged_at !== "string" ||
      (Object.hasOwn(entry, "recorded_at") &&
        typeof entry.recorded_at !== "string")
    )
      return null;
    // A partially repaired payload may carry both keys. Keep its canonical value and
    // only remove the obsolete key; otherwise move the original value byte-for-byte.
    if (!Object.hasOwn(entry, "recorded_at")) {
      entry.recorded_at = entry.logged_at;
    }
    delete entry.logged_at;
  }
  if (eventsToAdd !== null) parsed.rows.events = eventsToAdd;
  return JSON.stringify(parsed);
}

export function up(db: Database.Database): void {
  const hasTrash = db
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'deleted_rows'`
    )
    .get();
  if (!hasTrash) return;

  const update = db.prepare(`UPDATE deleted_rows SET payload = ? WHERE id = ?`);
  const rows = db
    .prepare(`SELECT id, payload FROM deleted_rows WHERE kind = ?`)
    .all(KIND) as { id: number; payload: unknown }[];
  for (const row of rows) {
    if (typeof row.payload !== "string") continue;
    const next = rewritePayload(row.payload);
    if (next !== null) update.run(next, row.id);
  }
}

export const migration: Migration = {
  name: "20260907-substance-trash-recorded-at",
  up,
};
