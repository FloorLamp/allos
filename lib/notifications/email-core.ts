// Email notification channel — the PURE half (issue #1855). Message → mail
// composition, the per-login content-mode contract, recipient dedup, and the
// deliverable-kind rule. No DB, no network — unit-tested in
// lib/__tests__/email-notify-core.test.ts. The DB reads + the actual send live in
// ./email; the wire itself stays behind the ONE lib/email.ts chokepoint (#985).
//
// THE PHI DECISION (owner ruling on #1855, 2026-08-01): email is the leakiest
// channel — relayed, stored, often synced to third-party inboxes — so what a
// notification email may CARRY is a per-login choice between two modes, and the
// default is the safe one:
//
//   - "content-free" (DEFAULT): the mail says something needs attention and where
//     to look, and NOTHING else. Structurally enforced: contentFreeEmail() does not
//     even accept the message, so no code path can leak a title, a body line, a
//     medication name, or a profile name into it.
//   - "full": the mail carries the same words every other channel renders
//     (plainBody parity, #1720), plus the message's deep-link actions as plain
//     links. Chosen per LOGIN, only by that login's own explicit tap on the
//     Settings control — nothing else may ever widen the default (the ruling's
//     load-bearing sentence, mirrored by dedupeEmailRecipients below).

import type {
  NotificationAction,
  NotificationKind,
  NotificationMessage,
} from "./types";
import { bodyFor } from "./types";
import { plainBody } from "./rich-text";
import { isPushDeliverableKind } from "./push-core";

// What a notification email is allowed to carry (see header).
export type EmailContentMode = "content-free" | "full";

export interface ComposedEmail {
  subject: string;
  text: string;
}

// A resolved delivery target: the login whose channel this is, the address the
// mail goes to, and that login's content-mode choice.
export interface EmailRecipient {
  loginId: number;
  address: string;
  fullContent: boolean;
}

// The fixed content-free mail. Takes the public URL and NOTHING else — the
// message deliberately isn't a parameter, so this mode cannot leak content by
// construction (the test pins the signature's consequence: two different messages
// compose to the identical mail).
export function contentFreeEmail(publicUrl: string): ComposedEmail {
  const open = publicUrl
    ? `Open Allos to see it: ${publicUrl}`
    : "Open Allos to see it.";
  return {
    subject: "Allos — something needs your attention",
    text: `A notification is waiting for you in Allos.\n\n${open}\n`,
  };
}

// A deep-link action rendered as a plain "Label: url" line. Callback actions
// (inline buttons) are DROPPED: email has no tap channel, and a callback token
// must never ride a mail (it is an opaque capability string).
function actionLines(actions: readonly NotificationAction[] | undefined): string[] {
  return (actions ?? [])
    .filter((a): a is NotificationAction & { url: string } => !!a.url)
    .map((a) => `${a.label}: ${a.url}`);
}

// The full-content mail: channel parity with Web Push / Home Assistant — the SAME
// words (plainBody over the email body override, #1720), never a fork. The
// subject is the message title (which carries dispatch()'s "[Name] " attribution
// prefix on multi-profile instances, exactly like every other channel's title).
export function fullContentEmail(
  msg: NotificationMessage,
  publicUrl: string
): ComposedEmail {
  const parts = [plainBody(bodyFor(msg, "email"))];
  const links = actionLines(msg.actions);
  if (links.length) parts.push(links.join("\n"));
  if (publicUrl) parts.push(`Open Allos: ${publicUrl}`);
  return {
    subject: msg.title,
    text: `${parts.filter((p) => p.trim() !== "").join("\n\n")}\n`,
  };
}

// The ONE composition entry the channel calls: mode-dispatched, so a send site
// cannot accidentally build full content for a content-free login.
export function composeNotificationEmail(
  msg: NotificationMessage,
  mode: EmailContentMode,
  publicUrl: string
): ComposedEmail {
  return mode === "full"
    ? fullContentEmail(msg, publicUrl)
    : contentFreeEmail(publicUrl);
}

// Kinds worth delivering over email: the SAME rule as Web Push
// (isPushDeliverableKind), because the two channels strip actions identically — a
// message whose entire value is its interactive buttons (the food nudge, the mood
// check-in) arrives as words instructing you to tap buttons that aren't there.
// One predicate, aliased rather than copied, so the two channels can't drift.
export function isEmailDeliverableKind(
  kind: NotificationKind | undefined
): boolean {
  return isPushDeliverableKind(kind);
}

// Collapse a recipient list to ONE entry per distinct address (case-insensitive,
// trimmed — addresses are compared the way logins.email's NOCASE unique index
// compares them). The FIRST login (input order — managingLoginIdsForProfile is
// id-ordered) owns the entry, mirroring dedupeRecipientsByChat; empties are
// dropped. The content mode collapses CONSERVATIVELY: a shared address gets full
// content only when EVERY login pointing at it opted in — content-free wins any
// disagreement, because the default may not be widened by anything but the
// affected login's own choice (the #1855 ruling applied to the merge).
export function dedupeEmailRecipients(
  recipients: readonly EmailRecipient[]
): EmailRecipient[] {
  const byKey = new Map<string, EmailRecipient>();
  for (const r of recipients) {
    const address = r.address.trim();
    if (!address) continue;
    const key = address.toLowerCase();
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...r, address });
    } else if (prev.fullContent && !r.fullContent) {
      byKey.set(key, { ...prev, fullContent: false });
    }
  }
  return [...byKey.values()];
}
