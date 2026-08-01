import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 134 (issue #1779): the LIVE MESSAGE POINTER — one row per delivered
// keyboard-bearing Telegram message, so the tick can reconcile what a chat still
// DISPLAYS against what the ledger actually says.
//
// ── WHY A TABLE AND NOT ANOTHER SETTINGS KEY ─────────────────────────────────
//
// Two pointers already exist as `profile_settings` values: the food nudge (#947) and
// the household round (#1719). Both are ONE-per-profile, last-write-wins, and exist
// for exactly one job — close the PREVIOUS message's keyboard when the NEXT one
// sends. Neither shape can carry what reconciliation needs:
//
//   MANY LIVE MESSAGES AT ONCE. A morning is a dose reminder, a refill nudge, a
//   preventive nudge and a digest — four live keyboards, all of which can go stale
//   independently. A single-value key can only remember the newest.
//
//   MANY CHATS PER SEND. Delivery fans out to every managing login's chat (#1072),
//   deduped by chat id, so ONE send is N delivered messages. A dose confirmed from a
//   family group's copy must correct the copies in the other subscribers' chats too,
//   which means a pointer PER DELIVERY, not per send.
//
//   THE KEYBOARD ITSELF. Telegram has no "read my message" API, so a reconciler
//   cannot ask what buttons a message is showing; it has to know. The delivered
//   keyboard (post-cap, exactly what went on the wire) is stored so a partially
//   resolved message can have precisely the dead buttons removed, and so a reconciler
//   never has to re-derive a keyboard it did not build.
//
// ── BOUNDED BY CONSTRUCTION, WITH A NAMED CLEANUP CLASS (#203) ───────────────
//
// This table grows with SENDS, not with people, so unlike the portal tables it needs
// a retention rule — and it has a natural one. Telegram refuses `editMessageText` /
// `editMessageReplyMarkup` on messages older than roughly 48 hours, so a pointer past
// that age can no longer be acted on by anything. The reconcile sweep deletes pointers
// older than its own retention window on every pass, which is also what keeps a
// household that never opens Telegram from accumulating rows forever.
//
// `sent_at` is written through the same `datetime('now')` SQL clock every other
// delivery-side stamp uses, so the retention comparison is against the one clock.
//
// ── PROFILE-OWNED ────────────────────────────────────────────────────────────
//
// A delivered message is ABOUT a profile (the fan-out's subject), so the row carries
// `profile_id` and joins lib/owned-tables.ts: deleting a person removes the pointers
// to the messages about them, which is both correct and the thing that stops a
// reconciler from later trying to rebuild a message for a subject that no longer
// exists. The reconcile sweep runs per profile inside the tick, so every statement
// against this table filters on `profile_id` with no scoping exemption needed.
//
// ── (chat_id, message_id) IS THE IDENTITY ────────────────────────────────────
//
// Telegram message ids are unique per chat, so that pair is the row's natural key. It
// is UNIQUE rather than the primary key because a redelivery (a retried send that
// somehow lands on the same message) must overwrite the pointer rather than duplicate
// it — the ON CONFLICT upsert in the recorder depends on this constraint existing.
//
// House rules (CLAUDE.md): one new table, no rebuild, so nothing to null beforehand.
// Self-contained (imports nothing from lib/), so a replay is decided purely by the DB
// catalog. Determinism (spec): reads only the DB catalog.

export function up(db: Database.Database): void {
  const run = db.transaction(() => {
    db.exec(
      `CREATE TABLE IF NOT EXISTS notify_messages (
         id         INTEGER PRIMARY KEY,
         -- The subject the message is ABOUT (the fan-out's profile), not the chat's
         -- owner. Profile-owned; cascades on profile delete.
         profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
         -- TEXT because Telegram chat ids are stored as text everywhere else in the
         -- app (login_settings.telegram_chat_id) and group ids are large negatives.
         chat_id    TEXT NOT NULL,
         message_id INTEGER NOT NULL,
         -- The NotificationKind the message was sent as. Informational for the sweep's
         -- logging and for a future per-kind policy; the RECONCILER is chosen from the
         -- keyboard's own callback tokens, which is what actually says what the message
         -- claims (a kind can carry several button families, and does).
         kind       TEXT NOT NULL,
         -- The SUBJECT's local calendar date at send time. Day rollover is the one
         -- reconcile rule that needs no per-kind knowledge: yesterday's keyboard must
         -- never stay live, because its tokens carry yesterday's date.
         date       TEXT NOT NULL,
         -- The delivered inline keyboard as JSON — post-cap, exactly what went on the
         -- wire. Telegram cannot be asked what a message is showing, so this is the
         -- only record of it.
         keyboard   TEXT NOT NULL,
         sent_at    TEXT NOT NULL,
         UNIQUE (chat_id, message_id)
       )`
    );
    // The sweep's access pattern: "every live pointer for this profile, oldest first".
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_notify_messages_profile
         ON notify_messages(profile_id, sent_at)`
    );
  });
  run.immediate();
}

export const migration: Migration = {
  id: 134,
  name: "134-notify-message-pointers",
  up,
};
