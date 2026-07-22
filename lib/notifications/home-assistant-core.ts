// Pure, dependency-free helpers for the Home Assistant notification channel
// (issue #248). No DB, no fetch, no network — so this stays in the "pure logic"
// test tier (lib/__tests__/home-assistant.test.ts). The DB reads + the outbound
// webhook POST live in ./home-assistant.ts.
//
// The channel POSTs the rendered NotificationMessage — title/body + a
// machine-readable `kind` + the profile display name, plus the dose ids of any
// actionable doses — to a per-profile Home Assistant webhook so an automation can
// present it with what only HA knows (who is home, which room): kitchen-speaker TTS
// dose announcements, escalation light-flashes, presence-aware delivery. This module
// owns the pure half: the payload shape, the actionable-dose extraction, the
// per-kind delivery toggle, and webhook-URL validation.

import type { NotificationKind, NotificationMessage } from "./types";

// A shared-secret header HA can verify on the receiving side (webhook ids are
// capability URLs, so this is belt-and-suspenders). Sent only when a secret is
// configured; the value is the raw shared secret, never derived from PHI.
export const HA_SECRET_HEADER = "x-allos-webhook-secret";

// One actionable dose carried in the payload — enough for an HA automation to wire
// a voice/button confirmation back to #235's `POST /dose` ({ doseId, date, action }).
// Ids only, never names (mirrors the Telegram callback-token contract).
export interface HomeAssistantDose {
  dose_id: number;
  date: string;
  action: "taken" | "skipped";
}

// The JSON body POSTed to the configured HA webhook. A stable, additive-only shape
// (documented in docs/home-assistant-notifications.md) so an HA automation can bind
// to it. Carries PHI (medication names in title/body) and typically travels
// LAN-to-LAN — the docs state that plainly.
export interface HomeAssistantPayload {
  title: string;
  body: string;
  kind: NotificationKind; // machine-readable classification ("other" when unset)
  profile: string; // the tracked person's display name ("Mom", "Dad")
  profile_id: number;
  doses: HomeAssistantDose[]; // actionable doses (for wiring to /dose)
  dose_ids: number[]; // convenience: unique dose ids referenced by `doses`
  links: string[]; // PHI-free deep-link URLs any action opens
  sent_at: string; // ISO 8601 timestamp of the send
}

// Map a callback-token prefix that actuates a dose to the /dose action it implies.
// `take`/`esctake` (a confirmed-taken tap) → "taken"; `skip` → "skipped". `escack`
// (an "I'm on it" ack) resolves nothing on the dose, so it's intentionally absent.
const DOSE_ACTION_BY_PREFIX: Record<string, "taken" | "skipped"> = {
  take: "taken",
  skip: "skipped",
  esctake: "taken",
};

// Extract the actionable doses from a message's action tokens. The dose tokens are
// "<prefix>:<profileId>:<doseId>:<suppId>:<date>" (take/skip/esctake) — the same
// shape the Telegram keyboard uses — so the dose id is field 2 and the date field 4.
// Deduped on (dose_id, action) so a message with both a ✅ and a ⏭ for one dose
// yields two distinct entries but never a repeat. A deep-link (`url`) action carries
// no token and contributes nothing here.
export function extractDoses(msg: NotificationMessage): HomeAssistantDose[] {
  const out: HomeAssistantDose[] = [];
  const seen = new Set<string>();
  for (const a of msg.actions ?? []) {
    if (!a.data) continue;
    const parts = a.data.split(":");
    const action = DOSE_ACTION_BY_PREFIX[parts[0]];
    if (!action) continue;
    const doseId = Number(parts[2]);
    const date = parts[4];
    if (!Number.isInteger(doseId) || doseId <= 0 || !date) continue;
    const key = `${doseId}:${action}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ dose_id: doseId, date, action });
  }
  return out;
}

// The PHI-free deep-link URLs any action opens (e.g. the refill form). Deduped,
// order-preserving. These are safe to forward — they carry no record detail.
export function extractLinks(msg: NotificationMessage): string[] {
  const out: string[] = [];
  for (const a of msg.actions ?? []) {
    if (a.url && !out.includes(a.url)) out.push(a.url);
  }
  return out;
}

// Build the webhook body from a rendered message + the profile it's for. Pure and
// deterministic given `sentAt`, so the unit tests pin the exact JSON. An unset
// message kind is forwarded as "other".
export function buildHomeAssistantPayload(
  msg: NotificationMessage,
  opts: { profileId: number; profileName: string; sentAt: string }
): HomeAssistantPayload {
  const doses = extractDoses(msg);
  return {
    title: msg.title,
    body: msg.body,
    kind: msg.kind ?? "other",
    profile: opts.profileName,
    profile_id: opts.profileId,
    doses,
    dose_ids: [...new Set(doses.map((d) => d.dose_id))],
    links: extractLinks(msg),
    sent_at: opts.sentAt,
  };
}

// ---- Per-kind delivery toggle ----
// A household may want doses announced on the wall panel but not weekly recaps, so
// each kind can be turned OFF for the HA channel independently. Stored as a JSON
// array of DISABLED kinds in profile_settings (absence = every kind on), so the
// default is "announce everything". A send-test (`test`) is never gated — it must
// always reach the webhook so the user can verify the wiring.

// Parse the stored disabled-kinds blob into a validated set. Anything malformed or
// not a known kind is dropped, so a corrupt value degrades to "nothing disabled"
// rather than throwing. Never includes "test" (which is not gate-able).
export function parseDisabledKinds(
  raw: string | undefined
): NotificationKind[] {
  if (!raw) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const valid = new Set<NotificationKind>([
    "dose",
    "escalation",
    "refill",
    "preventive",
    "workout",
    "workout-recap",
    "food",
    "mood",
    "digest",
    "upcoming",
    "weekly-recap",
    "milestone",
  ]);
  const out: NotificationKind[] = [];
  for (const x of arr) {
    if (typeof x === "string" && valid.has(x as NotificationKind)) {
      const k = x as NotificationKind;
      if (!out.includes(k)) out.push(k);
    }
  }
  return out;
}

export function serializeDisabledKinds(
  kinds: readonly NotificationKind[]
): string {
  return JSON.stringify([...new Set(kinds)]);
}

// Whether a message of `kind` should be delivered to the HA channel given the
// profile's disabled set. "test" is always enabled (a send-test must go through);
// every other kind is enabled unless explicitly disabled.
export function isKindEnabled(
  kind: NotificationKind | undefined,
  disabled: readonly NotificationKind[]
): boolean {
  const k = kind ?? "other";
  if (k === "test") return true;
  return !disabled.includes(k);
}

// The kinds a household can toggle in the settings UI (excludes "test" and the
// internal "other" catch-all). Paired with human labels for the checkbox grid.
// Channel-neutral since #928: the SAME registry drives all three columns of the
// notification matrix (Telegram, Web Push, Home Assistant), so a new kind (e.g.
// #924's workout-recap) becomes one new row across every channel for free. The
// historical `TOGGLEABLE_HA_KINDS` name is kept as an alias below for back-compat.
export const TOGGLEABLE_NOTIFICATION_KINDS: readonly {
  kind: NotificationKind;
  label: string;
}[] = [
  { kind: "dose", label: "Dose reminders" },
  { kind: "escalation", label: "Missed-dose escalation" },
  { kind: "refill", label: "Refill nudges" },
  { kind: "preventive", label: "Preventive care" },
  { kind: "workout", label: "Workout reminders" },
  { kind: "workout-recap", label: "Post-workout recap" },
  { kind: "food", label: "Food-log nudges" },
  { kind: "mood", label: "Mood check-ins" },
  // One "Morning digest" toggle since #1108 — the "what's due" list is now the
  // morning digest's Today section, ONE message of kind `digest`, so there's no
  // second `upcoming` send to toggle. The `upcoming` kind stays in the type union +
  // parseDisabledKinds' valid set for back-compat with any stored disabled blob, but
  // it's no longer a toggleable matrix row.
  { kind: "digest", label: "Morning digest" },
  { kind: "weekly-recap", label: "Weekly recap" },
  { kind: "milestone", label: "Milestones" },
];

// Back-compat alias (the registry predates the matrix as an HA-only list).
export const TOGGLEABLE_HA_KINDS = TOGGLEABLE_NOTIFICATION_KINDS;

// The SAFETY-tier kinds (#928): scheduled-dose reminders, missed-dose escalation,
// and the PRN redose notice. The matrix may disable them per channel, but WARNS —
// never blocks — when one ends up off on EVERY configured channel, consistent with
// the findings-bus principle that a safety signal is never silently suppressed.
export const SAFETY_NOTIFICATION_KINDS: ReadonlySet<NotificationKind> = new Set(
  ["dose", "escalation", "redose"]
);

export function isSafetyKind(kind: NotificationKind): boolean {
  return SAFETY_NOTIFICATION_KINDS.has(kind);
}

// Validate a configured HA webhook URL: a well-formed absolute http(s) URL whose
// path is exactly HA's built-in webhook trigger shape,
// `http(s)://<host>:8123/api/webhook/<id>`. This keeps the outbound channel from
// becoming an arbitrary server-side POST primitive: profile editors may point it
// at their HA webhook, not at any URL the server can reach. Empty is treated as
// "not configured" (returns false) by callers.
// Whether a live webhook response status is an accepted success. Only 2xx passes.
// A 3xx is DELIBERATELY a failure (issue #502): the outbound POST is sent with
// `redirect: "manual"`, so a redirect surfaces here as a 3xx rather than being
// transparently followed to whatever host/port/path the Location header names. That
// closes the SSRF hole isValidWebhookUrl (#371) left open — it can only validate the
// CONFIGURED URL at save time and has no say over where a 3xx on the live request
// would re-POST the medication-bearing payload. The request now only ever reaches the
// exact validated URL. Pure so the refusal is unit-tested without a live server.
export function isAcceptableWebhookStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

export function isValidWebhookUrl(url: string): boolean {
  if (!url) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (!u.host) return false;
  if (u.username || u.password || u.search || u.hash) return false;

  const parts = u.pathname.split("/");
  return (
    parts.length === 4 &&
    parts[0] === "" &&
    parts[1] === "api" &&
    parts[2] === "webhook" &&
    parts[3].length > 0
  );
}
