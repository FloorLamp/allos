// Channel-agnostic notification core. A message is built by a feature (e.g. the
// supplement reminder) and dispatched to every configured channel; the core
// knows nothing about supplements and channels know nothing about features.

export type ChannelId = "telegram" | "push";

// An interactive action attached to a message. `data` is an opaque token the
// inbound webhook decodes to perform the action (e.g. "take:<doseId>:<suppId>:<date>").
// Channels that support buttons render it; channels that don't ignore it.
export interface NotificationAction {
  label: string;
  data: string;
  // Optional keyboard-row grouping key (#232). Consecutive actions sharing a
  // `row` render side by side on ONE button row (e.g. a dose's ✅ take + ⏭ skip);
  // an action with no `row` gets its own row. Channels without buttons ignore it.
  row?: string;
}

export interface NotificationMessage {
  title: string;
  body: string;
  actions?: NotificationAction[];
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
