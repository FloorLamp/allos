// The live-message pointer STORE (issue #1779) — one row per delivered
// keyboard-bearing Telegram message (migration 135's `notify_messages`).
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

import { db, writeTx } from "../db";
import { sqlNow } from "../clock";
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
  // The message's TITLE LINE as delivered — attribution prefix included (#1822 item 7).
  // The sweep edits by pointer and never holds the text it is replacing, so this is what
  // lets a close name its own subject. Null for a pointer recorded before migration 139,
  // which closes with the subjectless line rather than a guessed one.
  title: string | null;
  sentAt: string;
  // The stored keyboard blob VERBATIM — the optimistic-concurrency witness (#1788).
  //
  // It is the raw column text and never a re-serialization of `keyboard`, because the
  // compare-and-swap below matches on bytes: a round-trip through parseStoredKeyboard
  // that reordered a key or dropped an unknown one would produce a witness that never
  // matches, and the sweep would silently stop editing anything. Carrying the original
  // string makes the CAS correct by construction rather than by the two serializers
  // agreeing forever.
  version: string;
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
  // The delivered title line, attribution prefix included (#1822 item 7). Optional so a
  // caller with nothing to record stores NULL rather than an empty subject.
  title?: string | null;
}): void {
  try {
    db.prepare(
      `INSERT INTO notify_messages
         (profile_id, chat_id, message_id, kind, date, keyboard, title, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chat_id, message_id) DO UPDATE SET
         profile_id = excluded.profile_id,
         kind       = excluded.kind,
         date       = excluded.date,
         keyboard   = excluded.keyboard,
         title      = excluded.title,
         sent_at    = excluded.sent_at`
    ).run(
      p.profileId,
      String(p.chatId),
      p.messageId,
      p.kind,
      p.date,
      JSON.stringify(p.keyboard),
      p.title?.trim() || null,
      sqlNow()
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
  title: string | null;
  sent_at: string;
}

// Every live pointer for one profile, oldest first. A row whose keyboard blob no longer
// parses is dropped from the result (and left for the pruner) rather than failing the
// sweep.
export function liveMessagePointers(profileId: number): MessagePointer[] {
  const rows = db
    .prepare(
      `SELECT id, profile_id, chat_id, message_id, kind, date, keyboard, title, sent_at
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
      title: r.title,
      sentAt: r.sent_at,
      version: r.keyboard,
    });
  }
  return out;
}

// ---- Claiming an edit (issue #1788) ---------------------------------------
//
// THE RACE. The sweep reads a pointer, `await`s a Telegram edit, and only then writes
// the new keyboard back. Two overlapping ticks for one profile — the compose poll
// sidecar plus a host crontab, two app instances on one volume, a manual `notify` run
// during the hourly one — both read the same pre-edit keyboard, both compute the same
// edit, and both call the Bot API. The end state converges (the edits are identical),
// so nothing is corrupted; what is spent is the rate-limit budget that reconcile.ts's
// zero-call steady state exists to protect.
//
// THE FIX. The pointer's keyboard is a LIFECYCLE field, so it gets the atomic
// transition the house convention requires (AGENTS.md; the `demoteIntakeObligation`
// shape): a tick CLAIMS the transition — old blob → new blob — BEFORE it touches the
// network, and only the winner makes the call. Claiming after the edit would still
// leave both processes calling Telegram, which is the whole cost being avoided.
//
// Both claims run in ONE immediate transaction so the compare and the write cannot be
// interleaved by the other writer, and so the loser waits for the lock instead of
// reading a half-applied state.

// Claim the right to replace this pointer's keyboard. True only for the tick that
// still saw `version`; a loser gets false and skips its edit entirely.
export function claimMessagePointerKeyboard(
  profileId: number,
  id: number,
  version: string,
  next: InlineKeyboard
): boolean {
  return writeTx(() => {
    const res = db
      .prepare(
        `UPDATE notify_messages SET keyboard = ?
          WHERE profile_id = ? AND id = ? AND keyboard = ?`
      )
      .run(JSON.stringify(next), profileId, id, version);
    return res.changes === 1;
  });
}

// Claim the right to CLOSE this message. The row is the claim: deleting it under the
// same witness both wins the race and forgets the pointer, so a closed message can
// never be closed twice.
export function claimMessagePointerClose(
  profileId: number,
  id: number,
  version: string
): boolean {
  return writeTx(() => {
    const res = db
      .prepare(
        `DELETE FROM notify_messages
          WHERE profile_id = ? AND id = ? AND keyboard = ?`
      )
      .run(profileId, id, version);
    return res.changes === 1;
  });
}

// ---- Releasing a claim the edit did not earn (issue #1885) -----------------
//
// The claim is made BEFORE the network call, so an edit that fails has already mutated
// (or deleted) the row. That is correct for a PERMANENTLY dead message — there is
// nothing left to reconcile — but wrong for a transient failure: the chat still shows
// the pre-edit keyboard, and the pointer is the only record of it. Releasing the claim
// puts the row back exactly as the sweep found it, so the next tick recomputes the same
// plan, re-claims, and retries. Without this, "we didn't drop it" would still leave no
// state a retry could run from.

// Undo a keyboard claim: swap the stored blob back from `claimed` to `version`. A
// compare-and-swap in the same direction as the claim, so a pass that lost the row to
// another writer in the meantime restores nothing rather than clobbering it. `claimed`
// is serialized by the SAME call the claim used, so the witness matches by construction.
export function releaseMessagePointerKeyboard(
  profileId: number,
  id: number,
  claimed: InlineKeyboard,
  version: string
): boolean {
  return writeTx(() => {
    const res = db
      .prepare(
        `UPDATE notify_messages SET keyboard = ?
          WHERE profile_id = ? AND id = ? AND keyboard = ?`
      )
      .run(version, profileId, id, JSON.stringify(claimed));
    return res.changes === 1;
  });
}

// Undo a CLOSE claim, which deleted the row: re-insert it verbatim, original id and
// `sent_at` included. Keeping `sent_at` is what keeps retries bounded — the restored
// pointer ages exactly as it would have, so `pruneMessagePointers` still removes it at
// the retention horizon instead of a failing message being renewed forever. A conflict
// (a fresh send already recorded a pointer for this chat/message) leaves the newer row
// alone: it describes what the chat is showing now, which this one no longer does.
export function restoreMessagePointer(p: MessagePointer): boolean {
  return writeTx(() => {
    const res = db
      .prepare(
        `INSERT INTO notify_messages
           (id, profile_id, chat_id, message_id, kind, date, keyboard, title, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`
      )
      .run(
        p.id,
        p.profileId,
        p.chatId,
        p.messageId,
        p.kind,
        p.date,
        // The blob VERBATIM, so the restored row is byte-identical to the witness the
        // next pass will read and claim against.
        p.version,
        p.title,
        p.sentAt
      );
    return res.changes === 1;
  });
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
          AND sent_at < datetime(?, ?)`
    )
    .run(profileId, sqlNow(), `-${MESSAGE_POINTER_RETENTION_DAYS} days`);
  return res.changes;
}
