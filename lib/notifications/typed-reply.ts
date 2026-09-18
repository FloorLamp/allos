// THE PROMPT-AND-REPLY CONTRACT (issue #5650) — one registry, one rule for deciding
// which prompt a typed answer belongs to, and NO READING OF MESSAGE TEXT to decide it.
//
// Three Telegram flows ask a question and take a TYPED answer: `/temp`, `/weight` and
// the refill receipt (#5580). Each used to be its own implementation of the same
// interaction — three marker grammars across two modules, three dispatch arms chained
// by hand in `handleIncomingMessage`, and three acknowledgements that each sent a NEW
// message. #5124 would have been a fourth copy. This module is the one contract they
// share, and the one place a fifth family registers.
//
// POINTER-ONLY, AND WHY THERE IS NO MARKER HERE AT ALL (owner ruling, 2026-09-16).
// A typed reply resolves ONLY against a message the bot itself recorded: the open-prompt
// registry, keyed by the quoted message's id. The family, the profile and the operation
// all come from that record — bot-written columns, never rendered and never typed. No
// code path in this contract reads the quoted message's TEXT to decide whether a reply
// is admissible or which family it belongs to.
//
// That is not a style preference; it is the whole safety property, and two earlier
// designs failed on it. Both put a MARKER — `(#temp:<pid>)`, `(refill:<pid>:<offerId>)` —
// in the prompt's body and read it back off the reply target. A marker is text, the
// rendered text of a prompt contains names a person types in-app (the `[Name]`
// attribution prefix, and a supply item's own name as the receipt prompt's title), and
// so a profile or item literally named `(#weight:<other>)` steered a `/temp` reply into
// a weight write on another profile. Anchoring the marker was tried and refused, because
// "this message has no marker of its own" is a property of the STORE (a pointer row that
// was never written, or has been pruned), not of the message — so any text path reaches
// every unrecorded bot message, including ones that end in a person's typed text.
//
// Pointer-only makes that class UNREACHABLE by construction rather than by exclusion:
// a message the store never recorded resolves to nothing, whatever it says. It also
// closes the same defect on `main`, where `parseRefillReplyMarker` is unanchored and the
// refill arm runs first, so a profile named `(refill:N:M)` already discards a `/temp`
// reading today.
//
// THE COST IS ACCEPTED AND IT IS REAL. A prompt sent before this build started recording
// pointers, and any prompt whose pointer has passed `MESSAGE_POINTER_RETENTION_DAYS`,
// STOPS TAKING A TYPED REPLY. The person is told to reply to a live prompt and taps a
// fresh one instead. That is the ruled behaviour, not a regression: old prompts sitting
// in chats trade a typed answer for a steering class that cannot exist.
//
// NOTHING IS IMPORTED HERE, and that is the property to keep rather than an accident of
// what moved first — the same rule `callback-tokens.ts` and the retired
// `reply-markers.ts` held. "Which of these open prompts does this number name?" is a
// decision over values; it needs no database, clock or wire, so the DB reads stay with
// the dispatcher, which passes what it found in. A file in the token layer that grows an
// import is a file that can be in an import cycle again (#2961 AC 3) — and that is
// MACHINE-ENFORCED, not left to whoever reads this next: `import/no-cycle` covers every
// file under lib/notifications with no exemption (eslint.config.mjs), which is where the
// retired `notification-import-cycles.test.ts` walk went at #5720.

// The typed-reply families. A family is a question the bot asks and a number-shaped
// answer it takes back; the operation id distinguishes two open questions of the SAME
// family, which is why refill carries one and the two quick-logs do not.
export type TypedReplyFamily = "temp" | "weight" | "refill";

// ---- The prompt mark ----------------------------------------------------------
//
// WHAT MAKES A MESSAGE A PROMPT (#5955, ruling 36). A bot message takes a typed reply
// exactly when the send chokepoint recorded a pointer for it whose kind is one of
// `POINTER_RESOLVED_FAMILIES` below: that pointer is how the registry finds the prompt an
// explicit Reply quoted, how a bare number finds the one open question, and how the
// acknowledgement edits the prompt in place afterwards. `recordPointer` (./telegram)
// writes such a pointer ONLY for a message carrying this mark. An unmarked message whose
// kind names one of those families records no pointer at all, whatever else it carries,
// and a marked message sent chat-wide is refused as before. Answerability is a property
// of the MESSAGE, declared where the message is built, and never read off its kind.
//
// WHY A MARK AND NOT THE KIND. `temp` and `weight` are ordinary notification kinds: the
// per-kind delivery toggle, the (chat, kind) re-issue rule and the reconcile registry all
// key on them, so any send may carry one, and a command's notices conventionally inherit
// its kind. #5898's falsifying passes reached the same defect through that door twice —
// a notice, a refusal or an acknowledgement fallback carrying the prompt's kind recorded
// a pointer, became a question nobody asked, and a number typed under it wrote a
// reading. A census over send sites was declined (#5955): it is a hand-kept list over
// the cases someone enumerated, and this mark is the structural answer instead.
//
// WHAT THE TYPE REFUSES, AND WHAT IT DOES NOT. The mark is a branded object, the
// discipline `WriteAuthorizedProfileId` (lib/auth.ts) applies to a profile id, and
// `typedReplyPrompt` is where it is minted, together with the kind it belongs to. A send
// site cannot spell it: `prompt: {}`, `prompt: true` and `prompt: "temp"` do not
// typecheck. Two residuals remain and the type sees neither: a forge — a cast to
// `TypedReplyPromptMark`, or a value passed through `any` — and a COPY, since spreading
// a marked message into another one carries the mark with it, the way `...msg` at a send
// site would. Both are stated here, not banned.
declare const TYPED_REPLY_PROMPT: unique symbol;
export type TypedReplyPromptMark = { readonly [TYPED_REPLY_PROMPT]: true };
const TYPED_REPLY_PROMPT_MARK = Object.freeze({}) as TypedReplyPromptMark;

// What a prompt builder spreads into its message: the family's kind and the mark, as
// one pair, so a builder does not spell the kind and the mark separately.
export function typedReplyPrompt(family: PointerResolvedFamily): {
  kind: PointerResolvedFamily;
  prompt: TypedReplyPromptMark;
} {
  return { kind: family, prompt: TYPED_REPLY_PROMPT_MARK };
}

// The families whose prompt IS its pointer, so the pointer's `kind` may name the family
// for an explicit Reply. This is the ONE place a kind is read as a family.
//
// `temp` and `weight` hold no server-side operation state, so there is no operation row
// to key admissibility on the way refill's receipt is keyed on its own `promptId`.
//
// WHAT MAKES THAT SOUND. A pointer of these kinds is written only for a message carrying
// the prompt mark above and addressed to one profile: `recordPointer` (./telegram)
// refuses an unmarked message of these kinds and a marked one sent chat-wide. So a row of
// this kind is a question the bot asked, and reading its kind as the family reads the
// bot's own record. Held by `telegram-quicklog.test.ts`: "a chat-wide send never becomes
// an answerable prompt" and "an unmarked send never becomes an answerable prompt".
//
// Keying these two on promptness the way refill is keyed was considered and refused: it
// would mean inventing an operation record for families that deliberately have none,
// which is a design change rather than a guard.
//
// `refill` is NOT here, and must not be added: several messages carry that kind — the
// low-supply reminder with its Received button, the receipt prompt that button opens, the
// `Supply update` rebuild — and only one is a question. A receipt is found through its
// offer row's `promptId` instead, so a number typed under a reminder settles nothing.
//
// A fifth family (#5124) belongs here only if it can live under the same limits. If it
// cannot, it owes a lookup of its own, the way refill does.
export const POINTER_RESOLVED_FAMILIES = ["temp", "weight"] as const;
export type PointerResolvedFamily = (typeof POINTER_RESOLVED_FAMILIES)[number];

export function pointerResolvedFamily(
  kind: string | null | undefined
): TypedReplyFamily | null {
  return POINTER_RESOLVED_FAMILIES.find((family) => family === kind) ?? null;
}

// ---- The bare-number rule ---------------------------------------------------
//
// A POSITIVE, unit-less number and nothing else. This is the test for whether an
// unquoted message may be claimed at all, so it is deliberately stricter than any
// family's value grammar: `38,5 c` and `180 lb` are answers a person aimed at a prompt
// with the Reply swipe, while a bare `120` in a chat is only an answer because the bot
// just asked a question. Anything else follows the existing plain-text path unchanged
// (#1895's "ordinary text may go unanswered" rule, narrowed for numeric text only).
//
// THIS READS THE REPLY'S OWN TEXT, WHICH IS THE ANSWER, NOT THE ADMISSIBILITY. The text
// pointer-only keeps out of the decision is the QUOTED message's — the bot's own words,
// which carry names a person typed. What the person just typed is the value they are
// sending, and no family is chosen by it.
export function typedReplyNumber(
  text: string | null | undefined
): number | null {
  const value = text?.trim();
  if (!value || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

// ---- The open-prompt registry -----------------------------------------------

// One prompt this chat is still waiting on an answer for. Every field is the BOT'S OWN
// RECORD of a message it sent: `promptId` is the message the acknowledgement edits,
// `profileId` is the attribution, and `operationId` is the family's handle on the
// operation — null for the two quick-logs, which hold no server-side operation state.
export interface OpenTypedPrompt {
  family: TypedReplyFamily;
  profileId: number;
  operationId: number | null;
  promptId: number;
}

// A resolved typed reply: the `{family, profileId, operationId, text}` the dispatcher
// hands to the family's settle function, plus the prompt to acknowledge on.
export interface TypedReply extends OpenTypedPrompt {
  text: string;
}

export type TypedReplyResolution =
  // Not addressed to any prompt — the caller must leave the message to the rest of the
  // dispatch chain rather than claim it.
  | { kind: "none" }
  // A bare number in a chat where this sender has MORE THAN ONE open prompt. Named by no
  // profile, deliberately: the ambiguity may span two, and saying which would be the
  // guess this branch exists to refuse.
  | { kind: "ambiguous" }
  // A number typed as an explicit Reply to a message THE STORE HAS NO RECORD OF as an
  // open prompt — a prompt sent before pointers were recorded, one whose pointer has
  // been pruned, one already answered, or a message that was never a prompt at all.
  // This is the ruled cost of pointer-only, and it is ANSWERED rather than guessed at:
  // resolving it against the chat's other open prompts would be the guess, and reading
  // the quoted text for a marker is the steering class that does not exist here.
  | { kind: "unrecorded" }
  | { kind: "reply"; reply: TypedReply };

export interface TypedReplyInput {
  text: string | null | undefined;
  // The quoted message's ID — and ONLY its id — when the person used the Reply swipe.
  // Its TEXT is deliberately absent from this type: a caller cannot re-introduce
  // text-first resolution without changing the shape, which is the retirement of the
  // marker made structural rather than remembered.
  replyToId?: number | null;
}

// The two ways the store can be asked about open prompts. Both are DB reads and both
// are passed in, so this module stays a leaf; both are called LAZILY, because ordinary
// chat that is not a number at all must not pay for a pointer or offer lookup on its way
// to the symptom intake.
export interface TypedPromptRegistry {
  // The prompt recorded at this message id, for an EXPLICIT Reply. Not filtered by
  // sender or by state: any chat member may answer a prompt the chat can write, and an
  // already-settled receipt still owes its own `Already recorded` refusal.
  at: (messageId: number) => OpenTypedPrompt | null;
  // Every prompt still open for this sender in this chat, for a BARE number.
  open: () => readonly OpenTypedPrompt[];
}

// THE ONE RESOLUTION RULE, in two halves that never overlap, neither of which reads the
// quoted message's text.
//
// An EXPLICIT REPLY is resolved by looking the quoted message id up in the registry. A
// hit is the answer, with the family and the attribution taken from the record. A MISS
// is refused — see `unrecorded`. This is what makes the steering class unreachable: the
// only input taken from the quoted message is a Telegram-assigned integer.
//
// A BARE NUMBER is attributed by the open prompts the caller found for this sender in
// this chat. Exactly one is an answer; more than one is refused, never guessed; none
// leaves the message alone.
export function resolveTypedReply(
  input: TypedReplyInput,
  registry: TypedPromptRegistry
): TypedReplyResolution {
  const text = input.text ?? "";
  if (input.replyToId != null) {
    const prompt = registry.at(input.replyToId);
    if (prompt) return { kind: "reply", reply: { ...prompt, text } };
    // The quoted message is not a prompt this bot is holding open. A reply that is not
    // number-shaped was never aimed at this contract, so it stays ordinary chat; a
    // number was plainly meant as an answer, and saying so beats silence.
    return typedReplyNumber(text) == null
      ? { kind: "none" }
      : { kind: "unrecorded" };
  }
  if (typedReplyNumber(text) == null) return { kind: "none" };
  const prompts = registry.open();
  if (prompts.length === 0) return { kind: "none" };
  if (prompts.length > 1) return { kind: "ambiguous" };
  return { kind: "reply", reply: { ...prompts[0], text } };
}

// ---- What the chat hears when a reply cannot be applied ---------------------
//
// Ruling 1: an applied reply is acknowledged by a reaction and an in-place edit, never a
// new message. A message is sent ONLY when the reply cannot be applied, and then exactly
// one. These are the answers the contract itself owns; every other refusal is the
// family's own sentence, spoken through the same single-message path.

// More than one open prompt, or a reply to a prompt this bot is no longer holding open.
// The person picks by replying to — or tapping — a live prompt.
export const TYPED_REPLY_AMBIGUOUS = "Reply to the prompt you mean.";

// The title over that sentence when the quoted message is not an open prompt. Separate
// from the ambiguity's title because the two are opposite conditions — too many open
// prompts, and none at the message quoted — and a reader who is told the wrong one
// cannot act on it.
export const TYPED_REPLY_UNRECORDED_TITLE = "That prompt isn't open";

// A reply to a prompt naming a profile this chat may not write. Structurally
// unreachable under pointer-only — every registry entry is built from the profiles
// `getProfilesByTelegramChatId` returns for this chat, so a resolved reply always names
// one of them — and KEPT ANYWAY, because that guarantee is two functions agreeing rather
// than one fact, and a later registry source that forgot the chat filter would otherwise
// write another chat's profile in silence. Before #5650 the refill arm CLAIMED such a
// message and said nothing, which from the chat's side is indistinguishable from the bot
// being broken.
export const TYPED_REPLY_UNAUTHORIZED =
  "That profile isn't linked to this chat anymore.";

// The reaction a settled reply wears. Telegram's Bot API 7.0 reaction set; one emoji,
// on the PERSON'S message, which is what makes the acknowledgement cost the chat no new
// line at all.
export const TYPED_REPLY_REACTION = "👍";

// ---- What a family's settle function answers --------------------------------
//
// `applied` is the whole difference ruling 1 turns on: an applied reply wears the
// reaction and its prompt now states the result, and NOTHING is sent. A refusal is the
// one message the chat gets, and it is the family's own sentence — "Enter a positive
// number of units, such as 90.", "Already recorded: …" — because only the family knows
// which of its refusals happened.
export interface TypedReplyOutcome {
  applied: boolean;
  refusal: string | null;
}

// Where the reply came from. Separate from the reply itself because these are the chat's
// facts, not the answer's: a family settles against the sender and the chat it verified
// at open time, and the reply's own message id is the idempotency handle a re-delivered
// update settles under.
//
// BOTH IDS ARE NULLABLE, and a family that BINDS to one refuses rather than guesses.
// Telegram populates both on every real message, but the shapes this code reads are
// optional all the way down, and a missing id must not become a silent claim: a receipt
// bound to the sender who opened it cannot be settled by an update with no sender, and
// saying so is the ruling-4 obligation. The two quick-logs bind to neither — `/temp` is a
// chat-addressed command anyone in the chat may answer — so they settle regardless, and
// only the 👍 is skipped, having nothing to land on.
export interface TypedReplyContext {
  chatId: string;
  senderId: number | null;
  messageId: number | null;
}
