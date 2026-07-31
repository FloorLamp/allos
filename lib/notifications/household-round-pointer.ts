// The per-profile "last household round sent" pointer (issue #1719) — the #947
// food-nudge pointer applied to the highest-stakes multi-person message in the app.
//
// WHY. Each round sends a FRESH Telegram message whose confirm buttons carry each
// member's SEND-TIME date (`hh:<receiver>:<member>:<dose>:<item>:<date>`), and every
// previous round's keyboard stays live in the chat forever. Tapping yesterday's
// surviving round at breakfast therefore logs a dose confirmation TO YESTERDAY — for
// someone else's medication, in the surface built for caregivers. The food nudge has
// guarded exactly this since #947; the round had neither half of the guard.
//
// This is the PURE shape half: the serialize/parse round-trip stored in
// profile_settings (`household_round_last_message`) and the extraction of a pointer
// from an outbound round. The DB read/write lives in lib/settings; the strip-previous
// orchestration lives in the Telegram chokepoint (telegram.ts), the only place holding
// both the sent message id and the guarded keyboard-edit primitive.
//
// ONE pointer per RECEIVER profile (the subscriber whose chat the round lands in),
// overwritten on every send — id-keyed, no cleanup class (#203).

import type { NotificationMessage } from "./types";

export interface HouseholdRoundPointer {
  // The chat the round was delivered to (string or numeric id, as Telegram reports it).
  chatId: string | number;
  // The Telegram message_id of the sent round (the message carrying the keyboard).
  messageId: number;
  // The RECEIVER's profile-local send date. Informational: a round's SECTIONS can
  // legitimately span two calendar dates in a mixed-timezone household, so the
  // authoritative per-tap date is the one baked into each member's own token.
  date: string;
}

export function serializeHouseholdRoundPointer(
  p: HouseholdRoundPointer
): string {
  return JSON.stringify({
    chatId: p.chatId,
    messageId: p.messageId,
    date: p.date,
  });
}

// Parse a stored pointer back. Robust to absent / malformed / partial values (a
// corrupt blob degrades to null — the send simply skips the previous-strip that tick),
// so a bad value can never throw on the delivery path.
export function parseHouseholdRoundPointer(
  raw: string | null | undefined
): HouseholdRoundPointer | null {
  if (!raw) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.chatId !== "string" && typeof o.chatId !== "number") return null;
  if (typeof o.messageId !== "number" || !Number.isFinite(o.messageId))
    return null;
  if (typeof o.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(o.date))
    return null;
  return { chatId: o.chatId, messageId: o.messageId, date: o.date };
}

// True when this outbound message is a household ROUND — i.e. it carries at least one
// `hh:` confirm token. The round shares `kind: "dose"` with the ordinary slot reminder
// (deliberately, #1459 — it IS a dose reminder and inherits that kind's safety-tier
// routing), so the kind alone cannot tell them apart; the token can, and only a round
// mints one.
export function isHouseholdRoundMessage(msg: NotificationMessage): boolean {
  return (msg.actions ?? []).some(
    (a) => typeof a.data === "string" && a.data.startsWith("hh:")
  );
}

// Build the pointer for a just-sent round, or null when the message isn't a round (so
// an ordinary dose reminder in the same chat never overwrites the round pointer and
// gets its keyboard stripped by the next round).
export function householdRoundPointerFromMessage(
  msg: NotificationMessage,
  chatId: string | number,
  messageId: number,
  date: string
): HouseholdRoundPointer | null {
  if (!isHouseholdRoundMessage(msg)) return null;
  return { chatId, messageId, date };
}
