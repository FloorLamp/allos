// WHAT COMPOSING AN OUTBOUND MESSAGE MEANS — issue #4538.
//
// A built message is not a sent one. Three things are applied to it: the composed
// one-tap it hosts (#2460), the chat origin its tokens carry (#3087), and the "[Name] "
// attribution prefix (#377/#429). The rebuild chokepoint has always applied them
// centrally; the SEND direction had no owner, so `prefixMessage` was hand-applied at
// eight call sites and forgotten at more — and the prefix is the one step here that is
// NOT idempotent, so "at the call site" and "centrally" could not coexist. There is now
// no exported way to prefix a title at all, which is what makes a doubled or a missing
// label unrepresentable rather than documented.
//
// ONE FUNCTION BOTH WAYS. A send passes a literal origin and no attachment (its host
// already carries one); a rebuild passes the attachment re-derived off the delivered
// keyboard and no origin (its callers preserve what that keyboard declares). Every step
// is a total function of its arguments, so a rebuild is keyboard-identical to its send
// while the state it names still stands.

import { prefixForProfile } from "./attribution";
import { withChatOrigin, type ChatOrigin } from "./chat-origin";
import {
  attachUsualRoutine,
  type UsualRoutineAttachment,
} from "./usual-routine-attach";
import { dispatchableUsual } from "./usual-routine-plan";
import type { NotificationMessage } from "./types";

// The composition, given an ALREADY-DERIVED prefix. Pure, so the render tier can pin it
// without a database and the one caller that decides its own prefix — a CHAT_WIDE send,
// which is about the chat and names nobody — says so in one expression. Returns the
// message itself when there is nothing to apply.
export function composeMessage(
  msg: NotificationMessage,
  prefix: string,
  origin: ChatOrigin | null = null,
  usual: UsualRoutineAttachment | null = null
): NotificationMessage {
  const composed = dispatchableUsual(
    withChatOrigin(attachUsualRoutine(msg, usual), origin)
  );
  return prefix
    ? { ...composed, title: `${prefix}${composed.title}` }
    : composed;
}

// The composition for a message about `profileId`, through the one derivation of the
// label (#429) — so a send and its rebuild cannot disagree about it.
export function composeForSend(
  profileId: number,
  msg: NotificationMessage,
  origin: ChatOrigin | null = null,
  usual: UsualRoutineAttachment | null = null
): NotificationMessage {
  return composeMessage(msg, prefixForProfile(profileId), origin, usual);
}
