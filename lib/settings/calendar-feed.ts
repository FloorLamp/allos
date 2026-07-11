import crypto from "node:crypto";
import { db } from "../db";
import { hashShareToken } from "../share-token";
import {
  parseFeedCategories,
  canonicalizeFeedCategories,
  clampFeedWindowDays,
  type FeedCategory,
} from "../calendar-ics";
import {
  expiresAtFromChoice,
  isTokenExpired,
  shouldRecordUse,
  type TokenExpiryChoice,
} from "../token-lifecycle";
import {
  getProfileSetting,
  setProfileSetting,
  deleteProfileSetting,
  getLoginSetting,
  setLoginSetting,
  deleteLoginSetting,
} from "./kv";

// ---- Calendar subscribe feed (ICS) ----------------------------------------
// A per-profile secret `.ics` URL the user subscribes to in Google/Apple/Outlook
// so upcoming medical appointments show up (with reminders) in their calendar.
// Security mirrors the passport share links (lib/share-links-db): the URL carries
// a high-entropy token, but only its SHA-256 HASH is stored — a DB leak yields no
// usable URL, and the token can be regenerated (old URL dies) or the feed
// disabled. State lives in profile_settings (a settings tier, NOT profile-owned
// data — so no schema change and no owned-table query), as discrete keys:
//   calendar_feed_enabled     "1" | "0"
//   calendar_feed_token_hash  hex SHA-256 of the raw token
//   calendar_feed_detail      "minimal" | "full"   (default "minimal")
//   calendar_feed_categories  JSON string[] of FeedCategory (default ["appointment"])
//   calendar_feed_reminders   "1" | "0"            (default "1" — emit VALARMs)
//   calendar_feed_past_days   integer string       (default "30")
//   calendar_feed_future_days integer string       (absent = unbounded horizon)
// Minimal is the default: the feed then reveals nothing but "Medical appointment"
// (+ location). Full is an explicit opt-in that sends provider/reason too. The
// customization keys (issue #12) all default to the historical appointments-only,
// reminders-on, 30-day-past, unbounded-future behaviour so an existing feed is
// unchanged until the user opts in.

export type CalendarFeedDetail = "minimal" | "full";

export interface CalendarFeed {
  enabled: boolean;
  detail: CalendarFeedDetail;
  // Content/window customization (issue #12).
  categories: FeedCategory[]; // which category kinds the feed emits
  reminders: boolean; // emit VALARM reminders on events
  pastWindowDays: number; // how far back a stale-but-scheduled item is carried
  futureWindowDays: number | null; // optional horizon; null = unbounded
  hasToken: boolean; // whether a token is minted (never exposes the token itself)
  // Token lifecycle (issue #24). ISO 8601 UTC strings, or null when absent.
  createdAt: string | null; // when the current token was minted
  lastUsedAt: string | null; // last successful feed fetch (throttled write)
  expiresAt: string | null; // optional expiry; null = never expires
}

export function getCalendarFeed(profileId: number): CalendarFeed {
  const detail = getProfileSetting(profileId, "calendar_feed_detail");
  const pastRaw = getProfileSetting(profileId, "calendar_feed_past_days");
  const futureRaw = getProfileSetting(profileId, "calendar_feed_future_days");
  const past = pastRaw != null ? Number(pastRaw) : NaN;
  const future = futureRaw != null ? Number(futureRaw) : NaN;
  return {
    enabled: getProfileSetting(profileId, "calendar_feed_enabled") === "1",
    detail: detail === "full" ? "full" : "minimal",
    categories: parseFeedCategories(
      getProfileSetting(profileId, "calendar_feed_categories")
    ),
    // Default ON: only an explicit "0" disables reminders.
    reminders: getProfileSetting(profileId, "calendar_feed_reminders") !== "0",
    pastWindowDays: Number.isFinite(past) ? clampFeedWindowDays(past) : 30,
    futureWindowDays: Number.isFinite(future)
      ? clampFeedWindowDays(future)
      : null,
    hasToken: !!getProfileSetting(profileId, "calendar_feed_token_hash"),
    createdAt:
      getProfileSetting(profileId, "calendar_feed_token_created_at") ?? null,
    lastUsedAt:
      getProfileSetting(profileId, "calendar_feed_token_last_used_at") ?? null,
    expiresAt:
      getProfileSetting(profileId, "calendar_feed_token_expires_at") ?? null,
  };
}

// Mint a fresh 256-bit token, store its hash, mark the feed enabled, and return
// the RAW token exactly once (for building the subscribe URL — it's never stored,
// so it can't be shown again). Rotating = calling this again: a new token, and the
// previous URL immediately stops resolving. `expiry` (issue #24) records an
// optional absolute expiry alongside the hash; "never" (default) preserves the
// historical no-expiry behaviour. A fresh mint clears the previous last-used stamp.
export function mintCalendarFeedToken(
  profileId: number,
  expiry: TokenExpiryChoice = "never"
): string {
  const token = crypto.randomBytes(32).toString("hex");
  const now = new Date();
  const expiresAt = expiresAtFromChoice(expiry, now.getTime());
  const write = db.transaction(() => {
    setProfileSetting(
      profileId,
      "calendar_feed_token_hash",
      hashShareToken(token)
    );
    setProfileSetting(profileId, "calendar_feed_enabled", "1");
    setProfileSetting(
      profileId,
      "calendar_feed_token_created_at",
      now.toISOString()
    );
    if (expiresAt) {
      setProfileSetting(profileId, "calendar_feed_token_expires_at", expiresAt);
    } else {
      deleteProfileSetting(profileId, "calendar_feed_token_expires_at");
    }
    deleteProfileSetting(profileId, "calendar_feed_token_last_used_at");
  });
  write();
  return token;
}

// Disable the feed (the route then 404s) and drop the token hash so the URL is
// dead even if re-enabled later without a fresh mint. Also clears the lifecycle
// stamps so a later re-enable starts clean. Idempotent.
export function disableCalendarFeed(profileId: number): void {
  const write = db.transaction(() => {
    setProfileSetting(profileId, "calendar_feed_enabled", "0");
    deleteProfileSetting(profileId, "calendar_feed_token_hash");
    deleteProfileSetting(profileId, "calendar_feed_token_created_at");
    deleteProfileSetting(profileId, "calendar_feed_token_expires_at");
    deleteProfileSetting(profileId, "calendar_feed_token_last_used_at");
  });
  write();
}

// Record a successful feed fetch, throttled to once an hour (mirrors the session
// sliding-refresh write in lib/auth) so a frequently-polled feed isn't written on
// every request. Best-effort: called from the token-authed route on the read path.
export function recordCalendarFeedUse(profileId: number): void {
  const last = getProfileSetting(profileId, "calendar_feed_token_last_used_at");
  if (!shouldRecordUse(last, Date.now())) return;
  setProfileSetting(
    profileId,
    "calendar_feed_token_last_used_at",
    new Date().toISOString()
  );
}

export function setCalendarFeedDetail(
  profileId: number,
  detail: CalendarFeedDetail
): void {
  setProfileSetting(
    profileId,
    "calendar_feed_detail",
    detail === "full" ? "full" : "minimal"
  );
}

// The content/window customization the user controls (issue #12). Category list is
// validated + canonicalized, windows clamped, all written in one transaction. An
// unbounded future horizon (null) DELETES the key so the absence reads back as
// unbounded. detail is left to setCalendarFeedDetail (its own PHI-warned control).
export interface CalendarFeedOptionsInput {
  categories: readonly string[];
  reminders: boolean;
  pastWindowDays: number;
  futureWindowDays: number | null;
}

export function setCalendarFeedOptions(
  profileId: number,
  opts: CalendarFeedOptionsInput
): void {
  const categories = canonicalizeFeedCategories(opts.categories);
  const write = db.transaction(() => {
    setProfileSetting(
      profileId,
      "calendar_feed_categories",
      JSON.stringify(categories)
    );
    setProfileSetting(
      profileId,
      "calendar_feed_reminders",
      opts.reminders ? "1" : "0"
    );
    setProfileSetting(
      profileId,
      "calendar_feed_past_days",
      String(clampFeedWindowDays(opts.pastWindowDays))
    );
    if (opts.futureWindowDays != null && opts.futureWindowDays >= 0) {
      setProfileSetting(
        profileId,
        "calendar_feed_future_days",
        String(clampFeedWindowDays(opts.futureWindowDays))
      );
    } else {
      deleteProfileSetting(profileId, "calendar_feed_future_days");
    }
  });
  write();
}

// Resolve a raw token from the feed URL to the owning profile id, or null. This is
// the ONE unauthenticated seam (the calendar client has no session): hash the
// caller-supplied token and match the stored hash across profile_settings — the
// attacker controls only the raw token, never the hash, and a non-matching hash
// returns no row, so there's no value-dependent timing on the secret. Returns null
// unless a matching row exists AND its feed is still enabled; the returned
// profile_id then re-scopes every downstream read (exactly like getShareLinkByToken).
// profile_settings is a settings tier, not profile-owned data, so this query is
// intentionally not profile-scoped (mirrors getProfilesByTelegramChatId).
export function resolveProfileByCalendarToken(rawToken: string): number | null {
  if (!rawToken) return null;
  const row = db
    .prepare(
      "SELECT profile_id FROM profile_settings WHERE key = 'calendar_feed_token_hash' AND value = ?"
    )
    .get(hashShareToken(rawToken)) as { profile_id?: number } | undefined;
  const profileId = row?.profile_id;
  if (!profileId) return null;
  const enabled = getProfileSetting(profileId, "calendar_feed_enabled") === "1";
  if (!enabled) return null;
  // An expired token (issue #24) is rejected exactly like a bad/disabled one — the
  // same uniform null → 404 with no oracle distinguishing expired from invalid.
  const expiresAt = getProfileSetting(
    profileId,
    "calendar_feed_token_expires_at"
  );
  if (isTokenExpired(expiresAt, Date.now())) return null;
  // Successful resolve → stamp last-used (throttled).
  recordCalendarFeedUse(profileId);
  return profileId;
}

// ---- Consolidated (per-LOGIN) calendar feed --------------------------------
// The "family calendar": a login-scoped .ics feed merging EVERY profile the login
// can currently access. Same token machinery as the per-profile feed (mint/rotate/
// disable/last-used/expiry via lib/token-lifecycle), but keyed by LOGIN in
// login_settings — which has `ON DELETE CASCADE` on logins(id), so deleting the
// login drops the token and the feed dies. Two deliberate differences from the
// per-profile feed:
//   1. NO detail level is stored here — the consolidated feed honors EACH profile's
//      own `calendar_feed_detail`, so a profile set to minimal contributes only
//      "Medical appointment" even inside the shared feed.
//   2. The set of profiles is resolved AT REQUEST TIME from live grants (see the
//      route), never frozen at mint — a revoked grant stops appearing immediately.
// Keys (login_settings): consolidated_calendar_feed_{enabled,token_hash,
//   token_created_at,token_last_used_at,token_expires_at}.

const CCF_KEY = {
  enabled: "consolidated_calendar_feed_enabled",
  hash: "consolidated_calendar_feed_token_hash",
  createdAt: "consolidated_calendar_feed_token_created_at",
  lastUsedAt: "consolidated_calendar_feed_token_last_used_at",
  expiresAt: "consolidated_calendar_feed_token_expires_at",
} as const;

export interface ConsolidatedCalendarFeed {
  enabled: boolean;
  hasToken: boolean;
  createdAt: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export function getConsolidatedCalendarFeed(
  loginId: number
): ConsolidatedCalendarFeed {
  return {
    enabled: getLoginSetting(loginId, CCF_KEY.enabled) === "1",
    hasToken: !!getLoginSetting(loginId, CCF_KEY.hash),
    createdAt: getLoginSetting(loginId, CCF_KEY.createdAt) ?? null,
    lastUsedAt: getLoginSetting(loginId, CCF_KEY.lastUsedAt) ?? null,
    expiresAt: getLoginSetting(loginId, CCF_KEY.expiresAt) ?? null,
  };
}

// Mint a fresh per-login token, store its hash, enable the feed, and return the RAW
// token once (never stored — can't be shown again). Rotating = calling this again:
// the previous URL immediately stops resolving. Mirrors mintCalendarFeedToken.
export function mintConsolidatedCalendarFeedToken(
  loginId: number,
  expiry: TokenExpiryChoice = "never"
): string {
  const token = crypto.randomBytes(32).toString("hex");
  const now = new Date();
  const expiresAt = expiresAtFromChoice(expiry, now.getTime());
  const write = db.transaction(() => {
    setLoginSetting(loginId, CCF_KEY.hash, hashShareToken(token));
    setLoginSetting(loginId, CCF_KEY.enabled, "1");
    setLoginSetting(loginId, CCF_KEY.createdAt, now.toISOString());
    if (expiresAt) setLoginSetting(loginId, CCF_KEY.expiresAt, expiresAt);
    else deleteLoginSetting(loginId, CCF_KEY.expiresAt);
    deleteLoginSetting(loginId, CCF_KEY.lastUsedAt);
  });
  write();
  return token;
}

// Disable the feed (route then 404s) and drop the token hash so the URL is dead.
// Also clears the lifecycle stamps so a later re-enable starts clean. Idempotent.
export function disableConsolidatedCalendarFeed(loginId: number): void {
  const write = db.transaction(() => {
    setLoginSetting(loginId, CCF_KEY.enabled, "0");
    deleteLoginSetting(loginId, CCF_KEY.hash);
    deleteLoginSetting(loginId, CCF_KEY.createdAt);
    deleteLoginSetting(loginId, CCF_KEY.expiresAt);
    deleteLoginSetting(loginId, CCF_KEY.lastUsedAt);
  });
  write();
}

// Record a successful feed fetch, throttled to once an hour (mirrors the per-profile
// feed + the session sliding-refresh write).
export function recordConsolidatedCalendarFeedUse(loginId: number): void {
  const last = getLoginSetting(loginId, CCF_KEY.lastUsedAt);
  if (!shouldRecordUse(last, Date.now())) return;
  setLoginSetting(loginId, CCF_KEY.lastUsedAt, new Date().toISOString());
}

// Resolve a raw token from the family feed URL to the owning LOGIN id, or null. The
// unauthenticated seam (a calendar client has no session): hash the caller-supplied
// token and match the stored hash across login_settings. Returns null unless a
// matching row exists AND its feed is still enabled AND unexpired — a uniform null →
// 404 with no oracle. login_settings is a settings tier (per-login, not
// profile-owned data), so this query is intentionally not profile-scoped, mirroring
// resolveProfileByCalendarToken. The returned login id drives request-time grant
// resolution in the route (a revoked grant stops appearing).
export function resolveLoginByConsolidatedCalendarToken(
  rawToken: string
): number | null {
  if (!rawToken) return null;
  const row = db
    .prepare(
      "SELECT login_id FROM login_settings WHERE key = 'consolidated_calendar_feed_token_hash' AND value = ?"
    )
    .get(hashShareToken(rawToken)) as { login_id?: number } | undefined;
  const loginId = row?.login_id;
  if (!loginId) return null;
  if (getLoginSetting(loginId, CCF_KEY.enabled) !== "1") return null;
  if (isTokenExpired(getLoginSetting(loginId, CCF_KEY.expiresAt), Date.now()))
    return null;
  recordConsolidatedCalendarFeedUse(loginId);
  return loginId;
}
