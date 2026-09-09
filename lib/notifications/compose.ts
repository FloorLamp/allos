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

import { today } from "../db";
import type { MessagePointer } from "./message-pointers";
import { prefixForProfile } from "./attribution";
import { withChatOrigin, type ChatOrigin } from "./chat-origin";
import {
  attachUsualRoutine,
  attachmentOnKeyboard,
  type UsualRoutineAttachment,
} from "./usual-routine-attach";
import { dispatchableUsual } from "./usual-routine-plan";
import type { DispatchOptions, NotificationMessage } from "./types";
import { getUnitPrefs } from "../settings";

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

// Hash comparisons and delivery use the same stored subject and live attachment.
// Pointer lookup and callback authorization remain at the request boundary.
export function composeForRebuild(
  profileId: number,
  msg: NotificationMessage,
  pointer: MessagePointer | null
): NotificationMessage {
  const ownerId = pointer?.profileId ?? profileId;
  return composeMessage(
    msg,
    pointer?.chatWide ? "" : prefixForProfile(profileId),
    null,
    pointer
      ? attachmentOnKeyboard(ownerId, pointer.keyboard, today(ownerId))
      : null
  );
}

// Applied after channel recipient/consent gates. Ownerless destinations keep the
// canonical body, and the already-composed envelope is never composed a second time.
export function withRecipientDistanceUnit(
  msg: NotificationMessage,
  loginId: number | undefined,
  opts?: DispatchOptions
): NotificationMessage {
  if (!opts?.bodyForDistanceUnit || loginId == null) return msg;
  return {
    ...msg,
    body: opts.bodyForDistanceUnit(getUnitPrefs(loginId).distanceUnit),
  };
}
