import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 152 (issue #2003): index `notify_messages` on
// (profile_id, chat_id, kind, sent_at).
//
// `liveMessagePointersForKind` (lib/notifications/message-pointers.ts) is the
// supersede lookup every re-issuable send makes — #1898's "one live keyboard per
// (chat, kind)". It reads
//   WHERE profile_id = ? AND chat_id = ? AND kind = ? ORDER BY sent_at, id
// and its own doc comment promised "one indexed lookup, not a full read of the
// profile's pointer table". That promise was not true: migration 135 ships only
// idx_notify_messages_profile (profile_id, sent_at), so SQLite could use the
// `profile_id` prefix and then test `chat_id` and `kind` in memory over EVERY
// pointer row the profile holds — the same asymptotic cost as the whole-table read
// the narrow query exists to avoid.
//
// It is not a sweep-only cost. The lookup runs on the DELIVERY PATH of every
// `/dose`, `/symptom` and `/mood` send, so per-send latency grew with a household's
// total pointer volume inside the 3-day retention window rather than with the
// handful of rows actually being superseded.
//
// The composite serves the whole statement: the three equality columns are the
// index prefix, `sent_at` orders the survivors, and SQLite appends the rowid — which
// `id` aliases — so `ORDER BY sent_at, id` needs no temp b-tree either.
//
// 135's index STAYS: `liveMessagePointers` and `pruneMessagePointers` both read
// (profile_id, sent_at) with no chat or kind filter, and this index cannot serve
// them. The write cost is one extra b-tree insert per delivered keyboard on a table
// that retention already keeps small.
//
// Pure additive DDL — a CREATE INDEX IF NOT EXISTS, so a fresh DB and an already
// converged one end identical and a replay is a no-op. No rebuild, so nothing to
// null beforehand. Determinism rule (spec): reads only the DB catalog.

export function up(db: Database.Database): void {
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_notify_messages_profile_chat_kind
       ON notify_messages(profile_id, chat_id, kind, sent_at);`
  );
}

export const migration: Migration = {
  id: 152,
  name: "152-notify-message-kind-index",
  up,
};
