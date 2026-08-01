import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 139 (issue #1822 item 7): remember WHAT a live message was about, so the
// reconcile close can name its own subject.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// When every claim a message made is resolved, the tick-time reconciler (#1779) replaces
// the ENTIRE message text with a closing line: "Handled in the app — nothing left here."
// That sentence has no subject. At 08:00 the reader sees an orphan bubble with no
// indication of what was handled — and in a shared family chat the "[Name] " attribution
// prefix goes with the rest of the text, so you cannot even tell WHOSE message was
// resolved. The tap path never had this problem: `replacementWithTitle` (#377) keeps the
// original attributed title line above its closing line, because the tap handler holds
// the message it is editing.
//
// ── WHY A COLUMN AND NOT A RE-DERIVATION ─────────────────────────────────────
//
// The sweep edits BY POINTER. Telegram has no "read my message" API — the same reason
// migration 135 stores the delivered keyboard — so at close time the tick does not hold
// the text it is replacing. The alternative was rebuilding the message from its kind to
// recover a title, which would run a whole builder (DB reads, current state) purely to
// recover a string that was already known at send time, and would produce TODAY's title
// for YESTERDAY's message on the rollover close — the one close where being wrong about
// the subject is most confusing.
//
// So the pointer records the title AS SENT, in the same chokepoint write that records
// the delivered keyboard, and for the same reason: that is the only moment anyone knows
// it. It is the attributed, already-prefixed title, so the close reproduces exactly what
// the chat has been showing since the send.
//
// ── NULLABLE, BY CONSTRUCTION ────────────────────────────────────────────────
//
// Pointers written before this migration have no title, and Telegram's ~48h edit horizon
// means they all age out within days. A NULL title closes with the bare, subjectless line
// — the pre-#1822 behaviour — rather than inventing a subject. No backfill: there is
// nothing to backfill FROM, and the rows are self-pruning (#203).
//
// House rules (CLAUDE.md): a new column on an existing table gets a new migration, no
// rebuild, so nothing to null beforehand. `notify_messages` is already profile-owned and
// already in lib/owned-tables.ts. Self-contained (imports nothing from lib/), so a replay
// is decided purely by the DB catalog. Determinism (spec): reads only the DB catalog.

export function up(db: Database.Database): void {
  const run = db.transaction(() => {
    const cols = db.prepare(`PRAGMA table_info(notify_messages)`).all() as {
      name: string;
    }[];
    if (cols.length === 0) return; // table absent (never happens after 135; belt)
    if (cols.some((c) => c.name === "title")) return;
    db.exec(
      `ALTER TABLE notify_messages ADD COLUMN title TEXT`
      // The message's title line AS DELIVERED — attribution prefix included. NULL for a
      // pointer recorded before this column existed; the close then falls back to the
      // subjectless line rather than guessing.
    );
  });
  run.immediate();
}

export const migration: Migration = {
  id: 139,
  name: "139-notify-message-title",
  up,
};
