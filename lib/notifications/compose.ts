// WHAT COMPOSING AN OUTBOUND MESSAGE MEANS — issue #4538.
//
// A built message is not yet a sent one. Three things have to be applied to it, and
// until this module they were applied by hand at every call site that sent anything:
//
//   1. THE COMPOSED ONE-TAP (#2460) — the "Your usual …" button a host message
//      carries, already decided by whoever owns the host (the tick's slot plan, or a
//      `/food` reply) and re-derived from the live keyboard on a rebuild;
//   2. THE CHAT ORIGIN (#3087) — which surface minted this keyboard, written into the
//      callback tokens because nothing else about the delivered message says;
//   3. THE ATTRIBUTION PREFIX (#377/#429) — the "[Name] " title label a shared chat
//      needs, derived once through `prefixForProfile`.
//
// ── WHY ONE FUNCTION, AND WHY IT IS THE SAME ONE BOTH WAYS ───────────────────
//
// The rebuild chokepoint has always composed centrally: a callback handler hands over
// a raw rebuilt message and CANNOT re-render without the label, because it does not do
// it. The SEND direction had no such owner, so `prefixMessage` was hand-applied at
// eight sites and forgotten at more — and `prefixMessage` is the one step here that is
// NOT idempotent, so "apply it at the call site" and "apply it centrally" could not
// coexist. `telegram-quick-log.ts` carried a comment warning that a forgotten prefix
// "would silently appear or vanish the first time this nudge is rebuilt"; that hazard
// is now unrepresentable rather than documented, because there is no exported way to
// prefix a title at all and both directions run through this one composition.
//
// Sends pass no attachment (the host already carries it) and a literal origin; the
// rebuild passes the attachment it re-derived from the delivered keyboard and no
// origin, because its callers preserve the origin the live keyboard declares. Every
// step is a total function of its arguments, so a rebuild of a message is
// keyboard-identical to its send whenever the state it names still stands.

import { prefixForProfile } from "./attribution";
import { withChatOrigin, type ChatOrigin } from "./chat-origin";
import {
  attachUsualRoutine,
  type UsualRoutineAttachment,
} from "./usual-routine-attach";
import { dispatchableUsual } from "./usual-routine-plan";
import type { NotificationMessage } from "./types";

// The composition, given an ALREADY-DERIVED prefix. Pure — no DB — so the render and
// attribution tiers can pin it without a database, and so the one caller that has to
// decide the prefix itself (a CHAT_WIDE send, which is about the chat and names
// nobody) can say so in one expression.
//
// Returns the message UNCHANGED, by identity, when there is nothing to apply: every
// step passes its input straight through on its empty argument.
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

// The composition for a message about `profileId`. The one derivation of the label
// (#429), so a send and its rebuild cannot disagree about it.
export function composeForSend(
  profileId: number,
  msg: NotificationMessage,
  origin: ChatOrigin | null = null,
  usual: UsualRoutineAttachment | null = null
): NotificationMessage {
  return composeMessage(msg, prefixForProfile(profileId), origin, usual);
}
