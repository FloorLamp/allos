// Pure, dependency-free helpers for the Web Push channel (issue #17). No DB, no
// web-push import, no network — so this stays in the "pure logic" test tier
// (lib/__tests__/push.test.ts). The DB + web-push wiring lives in ./push.ts.

import type { NotificationKind, NotificationMessage } from "./types";

// Where a tapped push notification opens. Deep links carry NO detail beyond the
// message the user already sees; tapping just opens the app (see the SW's
// notificationclick handler). "/" is the dashboard — a safe, always-valid target.
export const DEFAULT_PUSH_URL = "/";

// A stored push subscription, flattened from the browser's PushSubscription JSON
// ({ endpoint, keys: { p256dh, auth } }) into the columns we persist.
export interface StoredPushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

// The minimal JSON payload the service worker receives. Kept terse and
// PHI-conscious: title + body (the same text Telegram would show — it's the
// user's own device) plus a deep-link URL. No action tokens, no record ids.
export interface PushPayload {
  title: string;
  body: string;
  url: string;
}

// A push endpoint the service reports as permanently gone: the browser
// unsubscribed or the subscription expired. On these we DELETE the row rather
// than retrying (any other status is treated as a transient/real error).
export const PUSH_GONE_STATUSES = [404, 410] as const;

export function isSubscriptionGone(status: number): boolean {
  return (PUSH_GONE_STATUSES as readonly number[]).includes(status);
}

// Validate + normalize a raw PushSubscription (as posted from the client via
// subscription.toJSON()) into the flat shape we store, or null when it's
// malformed. Guards the write path so a garbage post can't create a junk row.
export function parsePushSubscription(
  raw: unknown
): StoredPushSubscription | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as {
    endpoint?: unknown;
    keys?: { p256dh?: unknown; auth?: unknown } | null;
  };
  const endpoint = obj.endpoint;
  const p256dh = obj.keys?.p256dh;
  const auth = obj.keys?.auth;
  if (typeof endpoint !== "string" || !/^https:\/\//.test(endpoint))
    return null;
  if (typeof p256dh !== "string" || !p256dh) return null;
  if (typeof auth !== "string" || !auth) return null;
  return { endpoint, p256dh, auth };
}

// Cap the body so a runaway message can't bloat the (size-limited) push payload
// and to keep the on-screen notification readable. The Web Push spec caps
// encrypted payloads at 4KB; this is well under it.
const MAX_BODY = 400;

// The push click-through URL for a message (#1083): Web Push drops `actions`, so a
// deep-link (`url`) action can't ride a button there — instead it becomes the
// notification's tap target so the push opens the exact next action (the refill form,
// a preventive screening's prefilled form…) rather than the app root. The first
// url-bearing action wins; a message with only callback actions (dose/skip) keeps the
// default root target. Pure so the channel send and any test agree on one rule.
export function pushClickThroughUrl(msg: NotificationMessage): string {
  return msg.actions?.find((a) => a.url)?.url ?? DEFAULT_PUSH_URL;
}

// Build the JSON string the SW's push handler parses. Title + body (truncated) +
// a deep-link URL. Pure: no reference to who/where it's sent. When `url` is omitted
// the click-through is derived from the message's deep-link action (pushClickThroughUrl).
export function buildPushPayload(
  msg: NotificationMessage,
  url: string = pushClickThroughUrl(msg)
): string {
  const body =
    msg.body.length > MAX_BODY
      ? `${msg.body.slice(0, MAX_BODY - 1)}…`
      : msg.body;
  const payload: PushPayload = { title: msg.title, body, url };
  return JSON.stringify(payload);
}

// Kinds whose ENTIRE value is their interactive buttons. A Web Push notification
// drops actions (buildPushPayload carries only title/body/url), so pushing one of
// these delivers a content-less, button-less notification — e.g. a food nudge whose
// body ("Tap what you've eaten to log a serving.") means nothing without its
// food-group buttons (#692). The push channel treats these as a no-op success,
// mirroring the Home Assistant channel's per-kind gate (isKindEnabled). Deliberately
// narrow: dose/refill/etc. carry real content in their body and stay push-deliverable
// even when their tap actions are dropped.
const PUSH_UNDELIVERABLE_KINDS: ReadonlySet<NotificationKind> = new Set([
  "food",
]);

// Whether a message of this kind is worth delivering over Web Push. Pure so the
// channel send and any test agree on one rule. An unset kind ("other") is deliverable.
export function isPushDeliverableKind(
  kind: NotificationKind | undefined
): boolean {
  return !PUSH_UNDELIVERABLE_KINDS.has(kind ?? "other");
}

// A VAPID keypair is usable only when BOTH halves are present. Pure predicate so
// the channel's isConfigured / the UI's "supported" state agree on one rule.
export function vapidConfigured(keys: {
  publicKey?: string | null;
  privateKey?: string | null;
}): boolean {
  return !!keys.publicKey && !!keys.privateKey;
}
