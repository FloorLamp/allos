// THE PROMPT-AND-REPLY CONTRACT (issue #5650) — one grammar, one parser, one rule for
// deciding which prompt a typed answer belongs to.
//
// Three Telegram flows ask a question and take a TYPED answer: `/temp`, `/weight` and
// the refill receipt (#5580). Each used to be its own implementation of the same
// interaction — three marker grammars across two modules, three dispatch arms chained
// by hand in `handleIncomingMessage`, and three acknowledgements that each sent a NEW
// message. #5124 would have been a fourth copy. This module is the one contract they
// share, and the one place a fifth family registers.
//
// NOTHING IS IMPORTED HERE, and that is the property to keep rather than an accident of
// what moved first — the same rule `callback-tokens.ts` and the retired
// `reply-markers.ts` held. A marker is a string a prompt carries, a parser is a rule for
// reading one back, and "which of these open prompts does this number name?" is a
// decision over values. None of the three needs the database, the clock or the wire, so
// the module that owns them can be a LEAF: the DB reads stay with the dispatcher, which
// passes what it found in. A file in the token layer that grows an import is a file that
// can be in an import cycle again (#2961 AC 3) — and that is MACHINE-ENFORCED, not left
// to whoever reads this next: `import/no-cycle` covers every file under
// lib/notifications with no exemption (eslint.config.mjs), which is where the retired
// `notification-import-cycles.test.ts` walk went at #5720. A cycle through this module
// fails the lint tier.
//
// DELIVERED PROMPTS KEEP PARSING. There is a live chat with prompts already sitting in
// it, so the parser accepts all three shipped marker strings exactly as written —
// `(#temp:<pid>)`, `(#weight:<pid>)` and `(refill:<pid>:<offerId>)` — and the ONE
// canonical form new prompts carry differs from them only in that every family now
// spells the `#`. The grammar is therefore a widening, never a migration: no prompt in
// anybody's chat has to be rewritten for a reply to it to attribute.

// The typed-reply families. A family is a question the bot asks and a number-shaped
// answer it takes back; the operation id distinguishes two open questions of the SAME
// family, which is why refill carries one and the two quick-logs do not.
export type TypedReplyFamily = "temp" | "weight" | "refill";

// The notification kinds whose message is a prompt awaiting a typed reply, so the send
// chokepoint records a pointer for it (`telegram.ts`'s `recordPointer`). That pointer is
// how ruling 2 finds a temp or weight prompt to attribute a BARE number to, and how
// ruling 1 edits it in place afterwards; before #5650 these two prompts carried neither
// a keyboard nor a prose claim, so nothing could find or edit them after the send. The
// refill prompt carries buttons and has always recorded one.
export const TYPED_REPLY_PROMPT_KINDS: readonly string[] = [
  "temp",
  "weight",
  "refill",
];

export function awaitsTypedReply(kind: string | null | undefined): boolean {
  return kind != null && TYPED_REPLY_PROMPT_KINDS.includes(kind);
}

// ---- The one marker grammar -------------------------------------------------
//
// `(#<family>:<profileId>[:<operationId>])`. The profile id is the ATTRIBUTION — a
// multi-profile chat gets one named prompt per profile, and a reply resolves to the
// profile its own prompt named rather than to whoever sorts first (#1995). The optional
// operation id binds a reply to ONE immutable operation, which is what stops an old
// reply from landing on a newer receipt (#5580's accepted design).

export function typedReplyMarker(
  family: TypedReplyFamily,
  profileId: number,
  operationId?: number
): string {
  const op = operationId == null ? "" : `:${operationId}`;
  return `(#${family}:${profileId}${op})`;
}

export interface TypedReplyMarker {
  family: TypedReplyFamily;
  profileId: number;
  operationId: number | null;
}

// The `#` is OPTIONAL on the way in and always written on the way out: the refill
// receipt shipped its marker as `(refill:…)` and those prompts are in real chats today.
const MARKER = /\(#?(temp|weight|refill):([1-9]\d*)(?::([1-9]\d*))?\)/;

export function parseTypedReplyMarker(
  text: string | null | undefined
): TypedReplyMarker | null {
  if (!text) return null;
  const m = MARKER.exec(text);
  if (!m) return null;
  return {
    family: m[1] as TypedReplyFamily,
    profileId: Number(m[2]),
    operationId: m[3] == null ? null : Number(m[3]),
  };
}

// ---- The bare-number rule ---------------------------------------------------
//
// A POSITIVE, unit-less number and nothing else. This is the test for whether an
// unquoted message may be claimed at all, so it is deliberately stricter than any
// family's value grammar: `38,5 c` and `180 lb` are answers a person aimed at a prompt
// with the Reply swipe, while a bare `120` in a chat is only an answer because the bot
// just asked a question. Anything else follows the existing plain-text path unchanged
// (#1895's "ordinary text may go unanswered" rule, narrowed for numeric text only).
export function typedReplyNumber(
  text: string | null | undefined
): number | null {
  const value = text?.trim();
  if (!value || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

// ---- Resolving a message to one open prompt ---------------------------------

// One prompt this chat is still waiting on an answer for. `promptId` is the message the
// acknowledgement edits; `operationId` is the family's handle on the operation, null for
// the two quick-logs, which hold no server-side operation state.
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
  | { kind: "reply"; reply: TypedReply };

export interface TypedReplyInput {
  text: string | null | undefined;
  // The quoted message's text and id, when the person used the Reply swipe.
  replyToText?: string | null;
  replyToId?: number | null;
}

// THE ONE RESOLUTION RULE, in two halves that never overlap.
//
// An EXPLICIT REPLY is attributed by the marker the quoted prompt carries. The marker is
// the attribution and it always wins: it names a profile and an operation, and it can
// name a prompt that the open-prompt list no longer holds (an already-settled receipt
// still owes the reader `Already recorded`, which is a refusal the family must speak).
//
// A BARE NUMBER is attributed by the open prompts the caller found for this sender in
// this chat. Exactly one is an answer; more than one is refused, never guessed; none
// leaves the message alone. `open` is read LAZILY because the common case — ordinary
// chat that is not a number at all — must not pay for a pointer or offer lookup.
export function resolveTypedReply(
  input: TypedReplyInput,
  open: () => readonly OpenTypedPrompt[]
): TypedReplyResolution {
  const text = input.text ?? "";
  const marker = parseTypedReplyMarker(input.replyToText);
  if (marker)
    return {
      kind: "reply",
      reply: {
        family: marker.family,
        profileId: marker.profileId,
        operationId: marker.operationId,
        // Telegram always numbers the quoted message; 0 stands for "there is no prompt
        // to acknowledge on", and the settle that would edit it simply does not.
        promptId: input.replyToId ?? 0,
        text,
      },
    };
  // A reply that quoted something ELSE is that thing's business, not a bare number.
  if (input.replyToText != null || typedReplyNumber(text) == null)
    return { kind: "none" };
  const prompts = open();
  if (prompts.length === 0) return { kind: "none" };
  if (prompts.length > 1) return { kind: "ambiguous" };
  return { kind: "reply", reply: { ...prompts[0], text } };
}

// ---- What the chat hears when a reply cannot be applied ---------------------
//
// Ruling 1: an applied reply is acknowledged by a reaction and an in-place edit, never a
// new message. A message is sent ONLY when the reply cannot be applied, and then exactly
// one. These are the two answers the contract itself owns; every other refusal is the
// family's own sentence, spoken through the same single-message path.

// More than one open prompt. The person picks by using the Reply swipe.
export const TYPED_REPLY_AMBIGUOUS = "Reply to the prompt you mean.";

// A reply to a prompt naming a profile this chat may not write. Before #5650 the refill
// arm CLAIMED this message and said nothing, which from the chat's side is
// indistinguishable from the bot being broken.
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
