// PURE — the ordering decision shared by every "one live keyboard per pointer"
// rotation (#947 food nudge, #1719 household round), extracted here after #1945.
//
// THE DEFECT THIS SHAPE EXISTS TO MAKE UNREPRESENTABLE. A rotation performs TWO
// writes that must agree about the world: it STRIPS the keyboard of the message the
// pointer currently names, and it RECORDS the just-sent message as the new pointer.
// The food rotation performed them under DIFFERENT conditions — strip whenever a
// previous pointer existed, record only when the new message yielded a pointer — so a
// send whose extraction returned null stripped its predecessor and then failed to name
// itself. The pointer went on naming the message just stripped; the new message kept a
// live keyboard NOTHING would ever strip (the next send strips the stale pointer again,
// a swallowed no-op); and a surviving food keyboard's tokens carry their SEND-TIME
// date, so a later tap logs to the wrong day — the exact harm #947 exists to prevent.
//
// The fix is not a patched branch. `planPointerRotation` decides ONCE and answers with
// a type in which a strip cannot exist without the record that justifies it: the strip
// target lives only inside the `rotate` arm, which always carries `record`. There is no
// value of this type meaning "strip, record nothing".
//
// A rotation is a network edit plus a settings write, so it can never be one
// transaction (writeTx callbacks are synchronous, and the edit is an await against
// Telegram). Atomicity is bought at the DECISION instead: the plan captures the strip
// target BEFORE anything is written, so the executor can record first and strip second
// — a write that throws takes the strip down with it (neither happens), and a strip
// that fails is best-effort over a pointer that is already correct.

// The minimum a pointer must carry to be stripped: which chat, which message.
export interface PointerTarget {
  chatId: string | number;
  messageId: number;
}

export type PointerRotation<P extends PointerTarget> =
  // The just-sent message yields no pointer of this family, so nothing has superseded
  // the message the pointer names: leave that keyboard alone. `skip` carries no strip
  // target, which is the whole point.
  | { action: "skip" }
  // Record `record` as the new pointer; `strip` is the message it supersedes, or null
  // when there is nothing live to close (first send, or the same message again).
  | { action: "rotate"; record: P; strip: PointerTarget | null };

// Same delivered message? Chat ids arrive as string or number depending on the call
// path, so compare them as strings.
export function samePointerTarget(a: PointerTarget, b: PointerTarget): boolean {
  return String(a.chatId) === String(b.chatId) && a.messageId === b.messageId;
}

// Decide a rotation from the currently-stored pointer and the pointer extracted from
// the just-sent message. `next === null` means the send is not a member of this pointer
// family (or its identifying buttons were not delivered) — never a reason to strip
// somebody else's still-current keyboard.
export function planPointerRotation<P extends PointerTarget>(
  prev: PointerTarget | null | undefined,
  next: P | null | undefined
): PointerRotation<P> {
  if (!next) return { action: "skip" };
  const strip = prev && !samePointerTarget(prev, next) ? prev : null;
  return { action: "rotate", record: next, strip };
}

// ── ONE LIVE KEYBOARD PER (chat, kind) — issue #1898 ─────────────────────────
//
// The rotation above is the SINGLE-POINTER shape: one stored id per profile, rotated on
// every send. It fits a family whose "is this a re-issue?" test lives in the outgoing
// message's own tokens (the food nudge's `food:` quick-log button).
//
// Most kinds have no such token and, until now, no supersede at all: `/dose` and
// `/symptom` stack a fresh live keyboard in the chat on every call, and #1895's
// on-demand commands multiply the opportunities. Each duplicate is safe to tap and
// stays fresh — which is the cost: the #1779 sweep pays an hourly Telegram edit per
// stale duplicate, forever, to keep clutter honest.
//
// The generalization reads its strip targets from the #1779 POINTER TABLE instead of
// from the outgoing message. That is what makes the #1945 stranding class
// unrepresentable here rather than merely guarded against: a target is a delivery that
// was actually recorded, so a send can never strip a message that no later send could
// name. The trigger is symmetrical — the just-sent message must itself have been
// recordable (it carries a delivered keyboard), or it has superseded nothing.
//
// A kind must DECLARE re-issuability (KIND_REISSUE in ./reconcile-registry). Passing
// the predicate in keeps this module pure and keeps the declaration in the registry the
// completeness scan reads.

// The minimum a supersede candidate must carry: where it lives, and what it is.
export interface KindedPointer extends PointerTarget {
  kind: string;
}

// Which of `live` a send of `sent` supersedes.
//
// Empty — never a partial answer — when the kind is not re-issuable, or when the send
// recorded no pointer of its own (`sent === null`). Both are the same rule as `skip`
// above: nothing has superseded anything, so nobody's keyboard is closed.
//
// The CHAT is compared here rather than assumed of the caller's query: a fan-out
// delivers one message per recipient chat and the pointer store is per profile, so a
// list scoped only by kind would let a send into the family group close the copy sitting
// in a caregiver's private chat. Chat ids arrive as string or number, so compare as
// strings. Same-message is excluded so a delivery that resolved to an id the chat
// already holds cannot close itself.
export function planKindSupersede<C extends KindedPointer>(
  live: readonly C[],
  sent: KindedPointer | null | undefined,
  isReissuable: (kind: string) => boolean
): C[] {
  if (!sent) return [];
  if (!isReissuable(sent.kind)) return [];
  return live.filter(
    (p) =>
      p.kind === sent.kind &&
      String(p.chatId) === String(sent.chatId) &&
      !samePointerTarget(p, sent)
  );
}
