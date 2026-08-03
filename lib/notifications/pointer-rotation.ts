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
