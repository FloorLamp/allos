// Channel-agnostic notification core. A message is built by a feature (e.g. the
// supplement reminder) and dispatched to every configured channel; the core
// knows nothing about supplements and channels know nothing about features.

import type { MessageBody } from "./rich-text";

export type ChannelId = "telegram" | "push" | "home-assistant";

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
  | "workout" // training/workout reminder
  | "workout-stale" // unfinished-session nudge (#560/#1205)
  | "workout-recap" // post-workout session recap line (#924)
  | "ease-back" // one-shot post-illness ease-back re-entry note (#837)
  | "food" // food-log nudge / first-connection opt-in prompt (#682)
  | "mood" // opt-in daily wellbeing check-in (#992; auto-pauses when ignored)
  | "practice" // pace-aware wellness-practice check-in (#1259)
  | "digest" // morning digest
  | "upcoming" // "what's due" upcoming digest
  | "weekly-recap" // weekly recap summary
  | "milestone" // milestone reached
  | "test" // a send-test from Settings
  | "other"; // unclassified / default

// An interactive action attached to a message. Either a callback action — `data`
// is an opaque token the inbound webhook decodes to perform the action (e.g.
// "take:<doseId>:<suppId>:<date>") — OR a deep-link action, where `url` opens a
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
  // `row` render side by side on ONE button row (e.g. a dose's ✅ take + ⏭ skip);
  // an action with no `row` gets its own row. Channels without buttons ignore it.
  row?: string;
}

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
  send(
    profileId: number,
    msg: NotificationMessage,
    opts?: DispatchOptions
  ): Promise<void>;
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

export function prefixMessage(
  msg: NotificationMessage,
  prefix: string
): NotificationMessage {
  if (!prefix) return msg;
  return { ...msg, title: `${prefix}${msg.title}` };
}
