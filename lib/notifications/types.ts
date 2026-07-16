// Channel-agnostic notification core. A message is built by a feature (e.g. the
// supplement reminder) and dispatched to every configured channel; the core
// knows nothing about supplements and channels know nothing about features.

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
  | "food" // food-log nudge / first-connection opt-in prompt (#682)
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
  body: string;
  actions?: NotificationAction[];
  // Machine-readable classification (#248). Optional — channels that don't care
  // (Telegram/push) ignore it; the Home Assistant channel forwards it so an
  // automation can route by kind and a per-kind toggle can gate delivery. Unset
  // reads as "other".
  kind?: NotificationKind;
}

export interface NotificationChannel {
  id: ChannelId;
  // Enabled and credentials present for the given profile.
  isConfigured(profileId: number): boolean;
  send(profileId: number, msg: NotificationMessage): Promise<void>;
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

export function prefixMessage(
  msg: NotificationMessage,
  prefix: string
): NotificationMessage {
  if (!prefix) return msg;
  return { ...msg, title: `${prefix}${msg.title}` };
}
