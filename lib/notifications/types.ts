// Channel-agnostic notification core. A message is built by a feature (e.g. the
// intake reminder) and dispatched to every configured channel; the core
// knows nothing about supplements and channels know nothing about features.

import type { MessageBody } from "./rich-text";

export type ChannelId = "telegram" | "push" | "home-assistant" | "email";

// A machine-readable classification of what a notification IS, carried on the
// message so a structured channel (Home Assistant, #248) can route/announce it and
// a per-kind delivery toggle can gate it. Purely a delivery hint — it never changes
// what's decided upstream (the findings-suppression bus, safety-tier rules) — so an
// unset kind is legal and treated as "other". Kept as a small, stable union;
// growing it is additive.
export type NotificationKind =
  | "dose" // scheduled supplement/medication dose reminder
  | "redose" // PRN redose-window notice (safety-adjacent, #798)
  | "escalation" // missed-dose escalation (safety)
  | "refill" // low-supply refill nudge
  | "preventive" // preventive-care nudge
  | "illness-care" // logged-symptom duration/trajectory care finding (#805)
  | "followup" // overdue safety follow-up escalation (#1866; two sends, terminator-gated)
  | "workout" // training/workout reminder
  | "workout-stale" // unfinished-session nudge (#560/#1205)
  | "workout-recap" // post-workout session recap line (#924)
  | "ease-back" // one-shot post-illness ease-back re-entry note (#837)
  | "food" // food-log nudge / first-connection opt-in prompt (#682)
  | "mood" // opt-in daily wellbeing check-in (#992; auto-pauses when ignored)
  | "practice" // pace-aware wellness-practice check-in (#1259)
  | "practice-recap" // what a finished practice did to the heart rate (#4775)
  | "digest" // morning digest
  | "upcoming" // "what's due" upcoming digest
  | "weekly-recap" // weekly recap summary
  | "milestone" // milestone reached
  | "wear-reminder" // opt-in bedtime "watch still on the charger?" nudge (#2161)
  // ── On-demand command replies (#1895's vocabulary, kinded for #1898) ───────
  // These are RE-ISSUABLE: the user asks for the keyboard, so asking again must
  // re-issue THE keyboard rather than stack another one in the chat. They carry a
  // kind for exactly that reason — the single-live invariant is keyed on
  // (chat, kind), and an unkinded send collapses into the "other" catch-all where
  // superseding would close unrelated messages.
  | "prn-list" // the /dose as-needed medication list (#797)
  | "symptom" // the /symptom grid + its severity picker (#859)
  | "temp" // the /temp reply prompt (#859)
  | "practice-list" // the /practice tracked-practice list (#1895)
  | "weight" // the /weight reply prompt (#1895)
  | "test" // a send-test from Settings
  | "other"; // unclassified / default

// An interactive action attached to a message. Either a callback action — `data`
// is an opaque token the inbound webhook decodes to perform the action (e.g.
// "take:<doseId>:<itemId>:<date>") — OR a deep-link action, where `url` opens a
// page in the app instead of firing a callback (issue #233's refill "Open form").
// Exactly one of `data`/`url` is set. Channels that support buttons render it;
// channels that don't (push) ignore actions entirely.
export interface NotificationAction {
  label: string;
  data?: string;
  // A deep-link target (absolute URL). Telegram renders it as a link button; a
  // deep-link button carries no callback token, so it's never consumed on tap.
  url?: string;
  // Optional keyboard-row grouping key (#232). Consecutive actions sharing a
  // `row` render side by side on ONE button row (e.g. a dose's ✅ take + ⏭️ skip);
  // an action with no `row` gets its own row. Channels without buttons ignore it.
  row?: string;
}

// The row key the digest's two COLLAPSED tail controls share, so the ➕ offer tail and
// the ⚙️ Tune button sit side by side instead of stacking (#2890). It lives here rather
// than in either builder because it belongs to NEITHER of them alone: `offer-tail.ts`
// and `digest-tune.ts` know nothing about each other, and a literal copied into both is
// the pairing that drifts apart the next time one of them is edited.
//
// It groups the COLLAPSED pair only. Each control's EXPANDED keyboard is its own layout
// with its own keys (`offer-<itemId>` plus `offer-tail` for the list, `tune-<n>` plus
// `digest-tune` for the toggles), and neither is grouped with anything here. Grouping is
// by ADJACENCY (#232), so either control still renders as a single button when its
// partner is absent.
export const DIGEST_TAIL_ROW = "digest-tail";

export interface NotificationMessage {
  title: string;
  // Plain text, or a RichText of builder-declared runs (#1720). The Telegram renderer
  // turns declared emphasis into markup around already-escaped text; every other
  // channel reads plainBody() and gets the same words without tags.
  body: MessageBody;
  // A per-channel REPLACEMENT body, for the narrow case where a channel structurally
  // cannot render an affordance the default body assumes (#1712): the digest's offer
  // tail is a keyboard control on Telegram, so its body line there would be a redundant
  // duplicate — while Web Push and Home Assistant cannot edit a message in place, so
  // they genuinely need the count in words. Channels that have no entry use `body`.
  //
  // This is deliberately NOT a general per-channel message fork: the words must stay
  // the same message. Reach for it only when a channel cannot render the control the
  // default copy refers to.
  bodyByChannel?: Partial<Record<ChannelId, MessageBody>>;
  actions?: NotificationAction[];
  // Machine-readable classification (#248). Optional — channels that don't care
  // (Telegram/push) ignore it; the Home Assistant channel forwards it so an
  // automation can route by kind and a per-kind toggle can gate delivery. Unset
  // reads as "other".
  kind?: NotificationKind;
}

// Per-send delivery routing a caller may need on TOP of the profile's own configured
// channels. Today there is exactly one: the missed-dose escalation's per-item
// `escalate_chat_id` (#615), which routes THAT item's Telegram copy to one explicit
// caregiver chat instead of the managing-login fan-out. It rides the dispatch call —
// rather than the escalation sending Telegram itself — so the safety tier keeps
// dispatch()'s delivery accounting and still reaches Web Push / Home Assistant (#1716).
// Channels that don't understand an option ignore it.
export interface DispatchOptions {
  // Explicit Telegram chat ids that REPLACE the profile's fan-out recipients for this
  // one send. An override chat is not a login, so it carries no per-login
  // disabled-kinds gate — it was configured for exactly this item.
  telegramChatIds?: readonly string[];
}

export interface NotificationChannel {
  id: ChannelId;
  // Enabled and credentials present for the given profile, under this send's routing.
  isConfigured(profileId: number, opts?: DispatchOptions): boolean;
  // The delivery OWNERS this send would reach (#2565): login ids for the login-scoped
  // channels, the profile id for Home Assistant — the same audience `send` resolves,
  // gated the same way. `send` records each owner's outcome itself at the moment it
  // has it; this is for the one outcome `send` never sees, the whole-dispatch timeout
  // (#3057), which dispatch() records against the owners the adapter was addressing.
  // An explicit chat override names no login and so no owner.
  owners(
    profileId: number,
    msg: NotificationMessage,
    opts?: DispatchOptions
  ): number[];
  // Deliver the message, and say WHO it reached — see SendOutcome. A throw is still the
  // channel-level failure dispatch() reports as `ok: false`; nothing about that changed.
  send(
    profileId: number,
    msg: NotificationMessage,
    opts?: DispatchOptions
  ): Promise<SendOutcome>;
}

// WHAT A COMPLETED SEND ACTUALLY REACHED — the RECIPIENT-level fact `ok` cannot carry
// (#5194, tenth falsifying pass).
//
// A channel result says whether the CHANNEL finished without throwing. That is a
// different question from "did anybody get this", because three of the four channels fan
// one message out to many recipients: Telegram to every managing login's chat, Web Push
// to every subscribed browser, email to every address. A channel can finish cleanly
// having delivered to NOBODY — a per-kind gate that filtered the whole audience is a
// deliberate no-op success on all of them — and Telegram can throw having ALREADY
// delivered to somebody (see PartialDeliveryError).
//
// So the channel answers it rather than a caller inferring it from `ok`. A caller that
// only wants "is the channel healthy" keeps reading `ok` and is unaffected; a caller
// whose correctness depends on a person having actually been shown the message reads
// `delivered` — today the "Still working out?" nudge, which records the minute its body
// promised so the tap stamps that minute instead of a second reading of the trace.
export interface SendOutcome {
  // At least one intended recipient received this message.
  delivered: boolean;
}

// A send that reached SOME of its recipients and then failed for another.
//
// The Telegram channel fans out in a loop and lets a recipient's throw propagate, so
// dispatch() marks the channel failed and the slot can retry — deliberate, stated in
// that module's header, and unchanged. What the throw discarded was the knowledge that
// an earlier chat in the same loop already HAS the message: in a two-chat household
// where one chat has blocked the bot, the healthy chat holds a delivered message with a
// live button while the channel reports nothing but failure. This carries that one bit
// out past the throw, so `ok` keeps its exact meaning and `delivered` is still answerable.
export class PartialDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PartialDeliveryError";
  }
}

// Prefix a message's title with a profile name so a shared channel (or a
// multi-profile instance) makes clear who a reminder is for. Pure — no DB.
// Returns the message unchanged when the prefix is empty (single-profile
// instance). See profileMessagePrefix for when a prefix applies.
export function profileMessagePrefix(
  name: string,
  profileCount: number
): string {
  return profileCount > 1 && name ? `[${name}] ` : "";
}

// The body a given channel should render — its override when one exists, else the
// shared body. The ONE accessor every channel reads, so a fork can't be forgotten.
export function bodyFor(
  msg: NotificationMessage,
  channel: ChannelId
): MessageBody {
  return msg.bodyByChannel?.[channel] ?? msg.body;
}
