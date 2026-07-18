// The per-profile "last food nudge sent" pointer (issue #947). Each food-nudge slot
// sends a FRESH Telegram message with live one-tap serving buttons, and every
// previous nudge's keyboard stays live forever — so tapping yesterday's still-live
// evening nudge at breakfast would silently log a serving to YESTERDAY (the token
// carries its send date). The fix closes the PREVIOUS nudge's keyboard when a new one
// sends, which needs one thing the send path never kept: the last sent message's id.
//
// This module is the PURE shape half — the serialize/parse round-trip stored in
// profile_settings (`food_nudge_last_message`) and the extraction of the pointer from
// an outbound nudge message. The DB read/write lives in lib/settings (getter/setter);
// the strip-previous orchestration lives in the Telegram chokepoint (telegram.ts),
// the only place with the sent message id + the guarded keyboard-edit primitive.
//
// It is ONE pointer per profile, overwritten on every send — id-keyed, no cleanup
// class (#203): profile deletion already wipes the profile_settings row, and an id
// never recycles, so a stale pointer is at worst a dead best-effort strip that fails
// harmlessly.

import { FOOD_NUDGE_WINDOWS, type FoodNudgeWindow } from "./food-format";
import type { NotificationMessage } from "./types";

export interface FoodNudgePointer {
  // The chat the nudge was delivered to (string or numeric chat id, as Telegram
  // reports it). Kept so the strip targets the exact chat the message lives in.
  chatId: string | number;
  // The Telegram message_id of the sent nudge (the message carrying the keyboard).
  messageId: number;
  // The nudge's send date (YYYY-MM-DD, profile tz) and window — informational, so a
  // future reader / debugger can see which slot the live keyboard belongs to.
  date: string;
  window: FoodNudgeWindow;
}

// Serialize a pointer for the `food_nudge_last_message` KV value.
export function serializeFoodNudgePointer(p: FoodNudgePointer): string {
  return JSON.stringify({
    chatId: p.chatId,
    messageId: p.messageId,
    date: p.date,
    window: p.window,
  });
}

// Parse a stored pointer back. Robust to absent / malformed / partial values (a
// corrupt blob degrades to null — the send simply skips the previous-strip that
// tick), so a bad value can never throw on the delivery path.
export function parseFoodNudgePointer(
  raw: string | null | undefined
): FoodNudgePointer | null {
  if (!raw) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  const chatId = o.chatId;
  const messageId = o.messageId;
  const date = o.date;
  const window = o.window;
  if (typeof chatId !== "string" && typeof chatId !== "number") return null;
  if (typeof messageId !== "number" || !Number.isFinite(messageId)) return null;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return null;
  if (
    typeof window !== "string" ||
    !FOOD_NUDGE_WINDOWS.includes(window as FoodNudgeWindow)
  )
    return null;
  return {
    chatId,
    messageId,
    date,
    window: window as FoodNudgeWindow,
  };
}

// Build the pointer from an outbound food-nudge message + its delivered ids. The
// window + date are read off the nudge's first quick-log button token
// (`food:<profileId>:<window>:<date>:<slug>`) — every button in one nudge carries the
// same window/date, so the first is representative. Returns null when the message has
// no food quick-log button (not a food nudge, or a button-less variant), so a
// non-nudge food-kind message never writes a bogus pointer.
export function foodNudgePointerFromMessage(
  msg: NotificationMessage,
  chatId: string | number,
  messageId: number
): FoodNudgePointer | null {
  for (const a of msg.actions ?? []) {
    if (typeof a.data !== "string") continue;
    const m = /^food:\d+:([A-Za-z]+):(\d{4}-\d{2}-\d{2}):.+$/.exec(a.data);
    if (!m) continue;
    const window = m[1];
    if (!FOOD_NUDGE_WINDOWS.includes(window as FoodNudgeWindow)) continue;
    return { chatId, messageId, date: m[2], window: window as FoodNudgeWindow };
  }
  return null;
}
