// PURE — "what the chat actually received", derived once (#1945).
//
// `sendMessageRaw` puts `capTelegramKeyboard(messageKeyboard(msg))` on the wire: the
// message's actions, laid out into rows, with any row past Telegram's 100-button cap
// dropped in favour of an explicit "+N more" line. Anything that later reasons about
// the buttons a chat is showing must read THAT keyboard, not `msg.actions` — the
// pre-cap intent. #1779's pointer already re-derived the pair for its stored keyboard;
// the two pointer EXTRACTORS still scanned the uncapped actions, so a nudge whose
// quick-log rows were cap-dropped would record a pointer describing buttons the chat
// never received.
//
// Re-deriving is deliberate rather than threading the delivered keyboard back out of
// the guarded primitive: both halves are total pure functions of `msg`, so calling
// them here reproduces the wire exactly, and every test that stubs the transport stays
// unaware of the derivation.

import type { NotificationMessage } from "./types";
import { messageKeyboard, type InlineKeyboard } from "./telegram-render";
import { capTelegramKeyboard } from "./telegram-limits";

// The post-cap keyboard a send of `msg` puts on the wire. Empty when the message
// carries no actions — a button-less message can never display a stale claim.
export function deliveredKeyboard(msg: NotificationMessage): InlineKeyboard {
  if (!msg.actions?.length) return [];
  return capTelegramKeyboard(messageKeyboard(msg)).keyboard;
}

// The callback tokens actually delivered, in keyboard order. Url-only buttons carry no
// token and are skipped, so a token found here is one a tap can really send back.
export function deliveredCallbackTokens(msg: NotificationMessage): string[] {
  const out: string[] = [];
  for (const row of deliveredKeyboard(msg)) {
    for (const btn of row) {
      if (typeof btn.callback_data === "string" && btn.callback_data.length > 0)
        out.push(btn.callback_data);
    }
  }
  return out;
}
