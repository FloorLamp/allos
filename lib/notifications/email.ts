// Email notification channel (issue #1855) — the fourth delivery channel beside
// Telegram, Web Push, and Home Assistant. The DB reads + the send loop; every
// composition/content decision is pure and lives in ./email-core, and the wire
// itself stays behind the ONE lib/email.ts chokepoint (#985) — this module never
// imports nodemailer.
//
// SCOPE: the channel belongs to the LOGIN (#1072 — a person with an inbox), and a
// per-profile event fans out to the managing logins exactly like Telegram: explicit
// grants + own profile, never admin-bypass-all, minus the per-(login, profile)
// mute. The ADDRESS is `logins.email` (migration 064) — the one address the login
// already has for auth mail — so there is no second "notification address" store.
//
// PHI: what a mail may carry is the per-login content mode (email-core header;
// owner ruling on #1855). Default is content-free; only the login's own Settings
// tap widens it.
//
// RETRY POSTURE (#2121/#2157): none of email's own. A failed send throws, dispatch
// records the channel failed, the slot marker stays unset, and the shared
// attempt-band budget retries ONCE an hour later — an hour outlives an SMTP
// greylist, so the shared budget serves email as-is (no email-specific counter).

import { db } from "../db";
import { sendEmail } from "../email";
import { isEmailConfigured } from "../settings/email";
import {
  getLoginEmailNotify,
  getLoginEmailDisabledKinds,
  isProfileMutedForLogin,
} from "../settings/notifications";
import { getPublicUrl } from "../settings/server";
import { createLogger } from "../log";
import type {
  NotificationChannel,
  NotificationKind,
  NotificationMessage,
} from "./types";
import { managingLoginIdsForProfile } from "./managing-logins";
import { isKindEnabled } from "./home-assistant-core";
import {
  composeNotificationEmail,
  dedupeEmailRecipients,
  isEmailDeliverableKind,
  type EmailRecipient,
} from "./email-core";

const log = createLogger("email-notify");

// The login's notification address = its auth address (logins.email, migration
// 064). logins is a GLOBAL table (not profile-owned data), keyed by the login id.
// Admin-managed in Settings → Family (setLoginEmail); "" when unset.
export function loginEmailAddress(loginId: number): string {
  const row = db
    .prepare("SELECT email FROM logins WHERE id = ?")
    .get(loginId) as { email: string | null } | undefined;
  return (row?.email ?? "").trim();
}

// Every login whose channel should carry a mail ABOUT `profileId`, BEFORE the
// per-address dedup: managing logins (grants + own profile, id-ordered) that have
// the channel enabled, an address on file, and haven't muted this profile. Kept
// per-login so the per-kind gate below can consult each login's OWN disabled set.
function rawEmailRecipients(profileId: number): EmailRecipient[] {
  const recipients: EmailRecipient[] = [];
  for (const loginId of managingLoginIdsForProfile(profileId)) {
    if (isProfileMutedForLogin(loginId, profileId)) continue;
    const cfg = getLoginEmailNotify(loginId);
    if (!cfg.emailEnabled) continue;
    const address = loginEmailAddress(loginId);
    if (!address) continue;
    recipients.push({
      loginId,
      address,
      fullContent: cfg.emailFullContent,
    });
  }
  return recipients;
}

// The delivery audience for a message about `profileId`, deduped by address —
// optionally gated per kind (each login's own matrix column, #928's discipline
// applied BEFORE the dedup so a login that turned a kind off keeps its address out
// of the fan-out while a login that left it on still receives). A shared address
// collapses to the more restrictive content mode (email-core).
export function resolveEmailRecipients(
  profileId: number,
  kind?: NotificationKind
): EmailRecipient[] {
  const raw =
    kind === undefined
      ? rawEmailRecipients(profileId)
      : rawEmailRecipients(profileId).filter((r) =>
          isKindEnabled(kind, getLoginEmailDisabledKinds(r.loginId))
        );
  return dedupeEmailRecipients(raw);
}

// Send one composed-per-recipient message. Mirrors the push channel's failure
// posture: resolves when at least one delivery succeeded (or there was nothing to
// deliver to — a healthy no-op, never a failure); throws only when EVERY attempt
// failed, so dispatch() marks the channel failed and the slot's shared attempt
// band retries an hour later.
async function sendToRecipients(
  recipients: EmailRecipient[],
  msg: NotificationMessage
): Promise<void> {
  if (recipients.length === 0) return;
  const publicUrl = getPublicUrl();
  let ok = 0;
  const errors: string[] = [];
  for (const r of recipients) {
    const mail = composeNotificationEmail(
      msg,
      r.fullContent ? "full" : "content-free",
      publicUrl
    );
    try {
      await sendEmail({ to: r.address, subject: mail.subject, text: mail.text });
      ok++;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (ok === 0 && errors.length > 0) {
    throw new Error(`email send failed: ${errors.join("; ")}`);
  }
}

export const emailChannel: NotificationChannel = {
  id: "email",
  isConfigured(profileId: number) {
    return isEmailConfigured() && resolveEmailRecipients(profileId).length > 0;
  },
  async send(profileId: number, msg: NotificationMessage) {
    // A button-only kind (food nudge, mood check-in) would arrive as words about
    // buttons email strips — a no-op success, exactly like Web Push (#692).
    if (!isEmailDeliverableKind(msg.kind)) {
      log.info("skipped: kind not deliverable to email", {
        profile: profileId,
        kind: msg.kind ?? "other",
      });
      return;
    }
    // A fully kind-filtered audience is a deliberate no-op success (mirrors the HA
    // disabled-kind gate) — it must never set the delivery-health marker.
    await sendToRecipients(
      resolveEmailRecipients(profileId, msg.kind ?? "other"),
      msg
    );
  },
};

// Send a test mail to a single login's OWN address (the Settings "send test"),
// bypassing the profile fan-out so a member can always verify their own inbox —
// mirrors sendTestPushToLogin. The test rides the login's STORED content mode, so
// what arrives is exactly the shape real reminders will take. Typed outcome; a
// relay failure throws and the caller surfaces it.
export async function sendTestEmailToLogin(
  loginId: number
): Promise<"not-configured" | "no-address" | "sent"> {
  if (!isEmailConfigured()) return "not-configured";
  const address = loginEmailAddress(loginId);
  if (!address) return "no-address";
  const mode = getLoginEmailNotify(loginId).emailFullContent
    ? "full"
    : "content-free";
  const mail = composeNotificationEmail(
    {
      title: "Allos test notification",
      body: "Email notifications are working.",
      kind: "test",
    },
    mode,
    getPublicUrl()
  );
  await sendEmail({ to: address, subject: mail.subject, text: mail.text });
  return "sent";
}
