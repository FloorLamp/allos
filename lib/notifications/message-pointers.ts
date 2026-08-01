// The live-message pointer STORE (issue #1779) — one row per delivered
// keyboard-bearing Telegram message (migration 134's `notify_messages`).
//
// Auth-blind and profileId-first, like every other lib/ write core. Every statement
// filters on `profile_id`, so the new owned table needs no scoping exemption.
//
// WHY THE KEYBOARD IS STORED. Telegram has no "read my message" API. A reconciler that
// wants to remove exactly the resolved buttons therefore has to know what the message
// is showing, and the only moment anyone knows that is the moment it was sent. The blob
// is the POST-CAP keyboard — what actually went on the wire — so a message whose
// keyboard was truncated by the 100-button guard reconciles against what the user can
// really see, not against what the builder wished for.
//
// RETENTION (#203 cleanup class). This table grows with SENDS, so it owns a rule rather
// than relying on profile deletion: Telegram refuses edits on messages older than
// roughly 48 hours, so a pointer past that horizon can never be acted on again. The
// sweep drops them on every pass — see `pruneMessagePointers`.

import { db } from "../db";
import { createLogger } from "../log";
import type { InlineKeyboard } from "./telegram-render";

const log = createLogger("notify");

// Telegram's documented edit horizon is ~48h. The extra day costs nothing (a handful
// of rows) and keeps a pointer alive across a clock skew or a paused tick.
export const MESSAGE_POINTER_RETENTION_DAYS = 3;

export interface MessagePointer {
  id: number;
  profileId: number;
  chatId: string;
  messageId: number;
  kind: string;
  // The SUBJECT's local calendar date at send time — the rollover comparison.
  date: string;
  keyboard: InlineKeyboard;
  sentAt: string;
}

// Parse a stored keyboard blob. Robust to a corrupt or partial value: a bad row
// degrades to null and is skipped by the sweep rather than throwing on the tick's
// delivery path (the #947 parse posture).
export function parseStoredKeyboard(raw: string): InlineKeyboard | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(obj)) return null;
  const rows: InlineKeyboard = [];
  for (const row of obj) {
    if (!Array.isArray(row)) return null;
    const cells: InlineKeyboard[number] = [];
    for (const cell of row) {
      if (typeof cell !== "object" || cell === null) return null;
      const c = cell as Record<string, unknown>;
      if (typeof c.text !== "string") return null;
      cells.push({
        text: c.text,
        ...(typeof c.callback_data === "string"
          ? { callback_data: c.callback_data }
          : {}),
        ...(typeof c.url === "string" ? { url: c.url } : {}),
      });
    }
    rows.push(cells);
  }
  return rows;
}

// Record (or overwrite) the pointer for one DELIVERED message. Called from the Telegram
// chokepoint, once per recipient chat — one send fans out to N deduped chats (#1072),
// so this is a pointer PER DELIVERY, which is what lets a dose confirmed from a family
// group's copy correct the copies in every other subscriber's chat.
//
// STRICTLY BEST-EFFORT, like the #947/#1719 pointer writes it generalizes: the message
// has already been delivered, so a bookkeeping failure must never turn a successful send
// into a failed one.
export function recordMessagePointer(p: {
  profileId: number;
  chatId: string | number;
  messageId: number;
  kind: string;
  date: string;
  keyboard: InlineKeyboard;
}): void {
  try {
    db.prepare(
      `INSERT INTO notify_messages
         (profile_id, chat_id, message_id, kind, date, keyboard, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(chat_id, message_id) DO UPDATE SET
         profile_id = excluded.profile_id,
         kind       = excluded.kind,
         date       = excluded.date,
         keyboard   = excluded.keyboard,
         sent_at    = excluded.sent_at`
    ).run(
      p.profileId,
      String(p.chatId),
      p.messageId,
      p.kind,
      p.date,
      JSON.stringify(p.keyboard)
    );
  } catch (e) {
    log.info("message pointer store failed (ignored)", {
      profile: p.profileId,
      err: e instanceof Error ? e.message : String(e),
    });
  }
}

interface PointerRow {
  id: number;
  profile_id: number;
  chat_id: string;
  message_id: number;
  kind: string;
  date: string;
  keyboard: string;
  sent_at: string;
}

// Every live pointer for one profile, oldest first. A row whose keyboard blob no longer
// parses is dropped from the result (and left for the pruner) rather than failing the
// sweep.
export function liveMessagePointers(profileId: number): MessagePointer[] {
  const rows = db
    .prepare(
      `SELECT id, profile_id, chat_id, message_id, kind, date, keyboard, sent_at
         FROM notify_messages
        WHERE profile_id = ?
        ORDER BY sent_at, id`
    )
    .all(profileId) as PointerRow[];
  const out: MessagePointer[] = [];
  for (const r of rows) {
    const keyboard = parseStoredKeyboard(r.keyboard);
    if (!keyboard) continue;
    out.push({
      id: r.id,
      profileId: r.profile_id,
      chatId: r.chat_id,
      messageId: r.message_id,
      kind: r.kind,
      date: r.date,
      keyboard,
      sentAt: r.sent_at,
    });
  }
  return out;
}

// Replace a pointer's stored keyboard after a successful edit, so the next tick
// reconciles against what the chat now shows rather than re-deciding the same change
// forever (the idempotence the "unchanged ⇒ no edit" rule depends on).
export function updateMessagePointerKeyboard(
  profileId: number,
  id: number,
  keyboard: InlineKeyboard
): void {
  db.prepare(
    `UPDATE notify_messages SET keyboard = ?
      WHERE profile_id = ? AND id = ?`
  ).run(JSON.stringify(keyboard), profileId, id);
}

// Forget a pointer: the message is closed, its keyboard is gone, or the edit failed
// because the message no longer exists (deleted, chat gone). All three mean there is
// nothing left to reconcile, so the row is dropped rather than retried forever.
export function dropMessagePointer(profileId: number, id: number): void {
  db.prepare(`DELETE FROM notify_messages WHERE profile_id = ? AND id = ?`).run(
    profileId,
    id
  );
}

// The retention sweep. Runs on every reconcile pass, which is what keeps the table
// bounded for a household that never opens Telegram.
export function pruneMessagePointers(profileId: number): number {
  const res = db
    .prepare(
      `DELETE FROM notify_messages
        WHERE profile_id = ?
          AND sent_at < datetime('now', ?)`
    )
    .run(profileId, `-${MESSAGE_POINTER_RETENTION_DAYS} days`);
  return res.changes;
}
