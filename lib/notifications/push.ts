// Web Push channel + subscription store (issue #17). The second delivery channel
// beside Telegram, so getChannels() fans out to both under the same hourly tick
// and per-day/slot dedup.
//
// SCOPES (mirrors, but differs from, Telegram):
//   - VAPID keypair: GLOBAL, in the settings table. Generated ONCE, lazily, the
//     first time any login enables push (ensureVapidKeys) — no admin setup step,
//     like the auto-generated Telegram webhook secret. The private key never
//     leaves the server and is never logged.
//   - Subscriptions: PER-LOGIN (a browser belongs to a login, not a profile —
//     unlike a Telegram chat-id, which is inherently per-profile). Enabling push
//     IS subscribing this browser; there is no separate per-profile toggle.
//   - Audience: a message built for profile P is pushed to every subscription of
//     every login ENTITLED to P (admins reach all profiles; members reach their
//     granted ones). So a subscribed browser receives reminders for every profile
//     that login manages — the sensible default for a personal/family instance.

import webpush from "web-push";
import { db, writeTx } from "../db";
import { getSetting, setSetting, getPublicUrl } from "../settings";
import { createLogger } from "../log";
import type { NotificationChannel, NotificationMessage } from "./types";
import {
  buildPushPayload,
  isPushDeliverableKind,
  isSubscriptionGone,
  vapidConfigured,
  type StoredPushSubscription,
} from "./push-core";

const log = createLogger("push");

// ---- VAPID keys (global settings) ----

const VAPID_PUBLIC_KEY = "vapid_public_key";
const VAPID_PRIVATE_KEY = "vapid_private_key";

// web-push requires a "subject" (contact for the push service): a mailto: or an
// https URL. Prefer the configured public app URL, else a neutral mailto. This is
// not a secret and carries no PHI.
function vapidSubject(): string {
  const url = getPublicUrl();
  return url && /^https:\/\//.test(url) ? url : "mailto:allos@localhost";
}

export function getStoredVapidKeys(): {
  publicKey: string | null;
  privateKey: string | null;
} {
  return {
    publicKey: getSetting(VAPID_PUBLIC_KEY) ?? null,
    privateKey: getSetting(VAPID_PRIVATE_KEY) ?? null,
  };
}

// Whether push can be sent at all (a keypair exists). Cheap read; used by the
// channel's isConfigured and the settings UI.
export function isPushConfigured(): boolean {
  return vapidConfigured(getStoredVapidKeys());
}

// The instance VAPID PUBLIC key — the client needs it to subscribe. Read-only;
// returns null until keys are generated. (The private key is never exposed.)
export function getVapidPublicKey(): string | null {
  return getSetting(VAPID_PUBLIC_KEY) ?? null;
}

// Ensure the instance has a VAPID keypair, generating + persisting one on first
// use. Idempotent: once stored, the same keys are reused forever (rotating them
// would orphan every existing subscription). Returns the public key. The private
// key is stored but never returned or logged.
export function ensureVapidKeys(): string {
  const existing = getStoredVapidKeys();
  if (vapidConfigured(existing)) return existing.publicKey!;
  const keys = webpush.generateVAPIDKeys();
  writeTx(() => {
    setSetting(VAPID_PUBLIC_KEY, keys.publicKey);
    setSetting(VAPID_PRIVATE_KEY, keys.privateKey);
  });
  log.info("generated VAPID keypair"); // note: no key material logged
  return keys.publicKey;
}

// Apply the stored keys to the web-push client, or return false when unconfigured.
function applyVapid(): boolean {
  const { publicKey, privateKey } = getStoredVapidKeys();
  if (!publicKey || !privateKey) return false;
  webpush.setVapidDetails(vapidSubject(), publicKey, privateKey);
  return true;
}

// ---- Subscription store (per login) ----

interface SubscriptionRow extends StoredPushSubscription {
  login_id: number;
}

// Upsert this browser's subscription for a login. The endpoint is the PK, so a
// re-subscribe (same browser) refreshes the keys rather than duplicating. NOT
// profile-owned data (keyed by login, like sessions) — deliberately unscoped.
export function savePushSubscription(
  loginId: number,
  sub: StoredPushSubscription
): void {
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, login_id, p256dh, auth, created_at, last_used_at)
     VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(endpoint) DO UPDATE SET
       login_id = excluded.login_id,
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       last_used_at = datetime('now')`
  ).run(sub.endpoint, loginId, sub.p256dh, sub.auth);
}

// Remove one browser's subscription, scoped to the owning login so a login can
// only ever delete its own (a forged/foreign endpoint deletes nothing).
export function deletePushSubscription(
  loginId: number,
  endpoint: string
): void {
  db.prepare(
    "DELETE FROM push_subscriptions WHERE endpoint = ? AND login_id = ?"
  ).run(endpoint, loginId);
}

// Delete a gone endpoint unconditionally (404/410 during send) — no login scope,
// because the push service told us this endpoint is dead for everyone.
function deleteGoneEndpoint(endpoint: string): void {
  db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
}

export function getPushSubscriptionsForLogin(
  loginId: number
): StoredPushSubscription[] {
  return db
    .prepare(
      "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE login_id = ?"
    )
    .all(loginId) as StoredPushSubscription[];
}

export function countPushSubscriptionsForLogin(loginId: number): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM push_subscriptions WHERE login_id = ?"
      )
      .get(loginId) as { n: number }
  ).n;
}

// Every subscription entitled to profile P's notifications: subscriptions whose
// owning login can access P (admins reach every profile; members via a
// login_profiles grant). push_subscriptions/logins/login_profiles are all
// login/global tables — NOT profile-owned — so this is not (and can't be)
// profile_id-scoped; the profile filter lives in the grant subquery.
export function getPushSubscriptionsForProfile(
  profileId: number
): SubscriptionRow[] {
  return db
    .prepare(
      `SELECT ps.endpoint, ps.login_id, ps.p256dh, ps.auth
         FROM push_subscriptions ps
         JOIN logins l ON l.id = ps.login_id
        WHERE l.role = 'admin'
           OR l.id IN (SELECT login_id FROM login_profiles WHERE profile_id = ?)`
    )
    .all(profileId) as SubscriptionRow[];
}

// ---- Sending ----

// Push a message to an explicit set of subscriptions. Prunes endpoints the
// service reports as gone (404/410). Resolves when at least one delivery
// succeeded (or there was nothing live to deliver to); throws only when every
// attempt failed for a NON-gone reason, so the caller (dispatch) marks the
// channel failed and the slot can retry.
async function sendToSubscriptions(
  subs: StoredPushSubscription[],
  msg: NotificationMessage
): Promise<void> {
  if (!applyVapid())
    throw new Error("Web Push is not configured (no VAPID keys)");
  if (subs.length === 0) return; // nothing live to deliver to — not an error

  const payload = buildPushPayload(msg);
  let ok = 0;
  const errors: string[] = [];

  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload
        );
        ok++;
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode ?? 0;
        if (isSubscriptionGone(status)) {
          deleteGoneEndpoint(s.endpoint);
          return; // expected cleanup, not a failure
        }
        errors.push(e instanceof Error ? e.message : String(e));
      }
    })
  );

  if (ok === 0 && errors.length > 0) {
    throw new Error(`web-push failed: ${errors.join("; ")}`);
  }
}

// Test send to a single login's OWN browsers (the "send test" button), bypassing
// the profile-audience mapping so a member can always verify their own device.
// Returns how many subscriptions were targeted so the UI can say "no browsers".
export async function sendTestPushToLogin(
  loginId: number,
  msg: NotificationMessage
): Promise<number> {
  const subs = getPushSubscriptionsForLogin(loginId);
  if (subs.length > 0) await sendToSubscriptions(subs, msg);
  return subs.length;
}

export const pushChannel: NotificationChannel = {
  id: "push",
  isConfigured(profileId: number) {
    return (
      isPushConfigured() && getPushSubscriptionsForProfile(profileId).length > 0
    );
  },
  async send(profileId: number, msg: NotificationMessage) {
    // An interaction-only kind (e.g. the food-log nudge) would arrive here as a
    // content-less, button-less push since the payload drops actions — so no-op it,
    // a healthy success like the HA channel's disabled-kind gate (#692). This also
    // covers the both-channels case the tick's telegramChannel.isConfigured guard
    // can't: Telegram + Web Push both on must not turn one food nudge into a useless
    // push alongside the real Telegram one.
    if (!isPushDeliverableKind(msg.kind)) {
      log.info("skipped: kind not deliverable to push", {
        profile: profileId,
        kind: msg.kind ?? "other",
      });
      return;
    }
    await sendToSubscriptions(getPushSubscriptionsForProfile(profileId), msg);
  },
};
