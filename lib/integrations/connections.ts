import crypto from "node:crypto";
import { db, writeTx } from "@/lib/db";
import { log } from "@/lib/log";
import type {
  IntegrationConnection,
  IntegrationConnectionStatus,
} from "@/lib/types";
import { matchTokenToProfile, type TokenCandidate } from "./token-match";
import { isAuthRefreshFailure } from "./auth-failure";
import {
  expiresAtFromChoice,
  isTokenExpired,
  shouldRecordUse,
  type TokenExpiryChoice,
} from "@/lib/token-lifecycle";
import { daysAgoModifier, SYNC_EVENTS_RETENTION_DAYS } from "@/lib/retention";

// Generic per-provider connection state, backed by integration_connections. Holds
// the push token for Health Connect and OAuth tokens for Strava (Garmin later).

export function getConnection(
  profileId: number,
  provider: string
): IntegrationConnection | undefined {
  return db
    .prepare(
      "SELECT * FROM integration_connections WHERE profile_id = ? AND provider = ?"
    )
    .get(profileId, provider) as IntegrationConnection | undefined;
}

interface ConnectionPatch {
  status?: IntegrationConnectionStatus;
  config?: Record<string, unknown> | null;
}

// The DB `status` column is bare TEXT (no CHECK — a rebuild isn't worth it for a
// three-value set), so this is where the TS union is enforced at runtime: the single
// writer refuses any status outside the set (issue #326). An out-of-set value is a
// programming error, not user input, so throwing is correct — it fails the test/build.
const VALID_STATUSES: ReadonlySet<IntegrationConnectionStatus> = new Set([
  "connected",
  "disconnected",
  "needs_reauth",
]);

// Insert-or-update a connection row, bumping updated_at. `config` is stored as JSON.
export function upsertConnection(
  profileId: number,
  provider: string,
  patch: ConnectionPatch
) {
  const existing = getConnection(profileId, provider);
  const status = patch.status ?? existing?.status ?? "disconnected";
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`upsertConnection: invalid status "${status}"`);
  }
  const config =
    patch.config !== undefined
      ? patch.config === null
        ? null
        : JSON.stringify(patch.config)
      : (existing?.config ?? null);
  db.prepare(
    `INSERT INTO integration_connections (profile_id, provider, status, config)
       VALUES (?, ?, ?, ?)
     ON CONFLICT(profile_id, provider) DO UPDATE SET
       status = excluded.status,
       config = excluded.config,
       updated_at = datetime('now')`
  ).run(profileId, provider, status, config);
}

// Read-merge-write a connection's config JSON inside an IMMEDIATE transaction (issue
// #470). A patch is `{ ...currentConfig, ...patch }`, so two processes patching the
// SAME connection concurrently — the hourly tick writing a sync cursor while web "Sync
// now" writes a fresh token pair — would lost-update each other under plain read-then-
// write (last writer wins, the other's keys vanish). BEGIN IMMEDIATE takes the write
// lock up front, so the second process blocks until the first commits, then re-reads
// the just-merged config and layers its own keys onto that fresh value. better-sqlite3
// is fully synchronous, so `read` runs entirely inside the transaction with no await.
function mergeConnectionConfig<T extends object>(
  profileId: number,
  provider: string,
  read: () => T,
  patch: Partial<T>,
  status?: "connected" | "disconnected"
): void {
  writeTx(() => {
    const next = { ...read(), ...patch } as Record<string, unknown>;
    upsertConnection(profileId, provider, { status, config: next });
  });
}

// Single-flight the OAuth token refresh for one connection (issue #470). Strava and
// Withings ROTATE the refresh token on every refresh, so two processes refreshing the
// same connection at once (web "Sync now" + the hourly tick) race: the loser presents
// an already-consumed refresh token, gets invalid_grant, and spuriously flags the
// connection needs_reauth. This atomic claim makes exactly ONE caller the refresher —
// the flip itself is the claim (UPDATE ... WHERE the slot is free or its claim aged
// out), so a concurrent caller gets changes === 0 and skips the fetch. The 60s window
// is far longer than a refresh round-trip yet short enough that a crashed winner's
// stale claim frees within a tick. Returns true iff THIS caller won and may refresh.
export function claimTokenRefresh(
  profileId: number,
  provider: string
): boolean {
  const res = db
    .prepare(
      `UPDATE integration_connections
          SET refresh_claimed_at = datetime('now')
        WHERE profile_id = ? AND provider = ?
          AND (refresh_claimed_at IS NULL
               OR refresh_claimed_at < datetime('now','-60 seconds'))`
    )
    .run(profileId, provider);
  return res.changes === 1;
}

// Flip a connection into `needs_reauth` after a DEFINITIVE auth failure (a dead or
// revoked refresh token / PAT — see isAuthRefreshFailure). Preserves the existing
// config (creds and now-dead tokens are kept so the setup page can show which
// account was linked and the user can reconnect without re-pasting), changing only
// the status. Because the hourly tick auto-syncs `connected` rows ONLY, this ends the
// unbounded failing-forever refresh loop (issue #326) until the user reconnects — at
// which point setStravaTokens/setOuraToken/setWithingsTokens flip it back to
// `connected`. Idempotent: a row already in `needs_reauth` just bumps updated_at.
export function markConnectionNeedsReauth(profileId: number, provider: string) {
  upsertConnection(profileId, provider, { status: "needs_reauth" });
}

// Record the result of a sync (timestamp + per-type counts as JSON).
export function recordSync(
  profileId: number,
  provider: string,
  summary: Record<string, number>
) {
  db.prepare(
    `UPDATE integration_connections
       SET last_sync_at = datetime('now'),
           last_sync_summary = ?,
           updated_at = datetime('now')
     WHERE profile_id = ? AND provider = ?`
  ).run(JSON.stringify(summary), profileId, provider);
}

export interface SyncEventInput {
  ok: boolean;
  windowStart?: string | null;
  windowEnd?: string | null;
  received?: number | null;
  written?: number | null;
  // Real insert/update/unchanged accounting. Optional/nullable: a failure
  // event or a legacy caller leaves them null and the reader falls back to
  // `written`.
  inserted?: number | null;
  updated?: number | null;
  unchanged?: number | null;
  // Rows the source re-sent that a re-import tombstone held out (#507/#508). Null on a
  // failure event or a legacy caller.
  suppressed?: number | null;
  skipped?: number | null;
  // Bare filename of the raw provider payload captured for this sync (issue #9),
  // written by lib/integrations/raw-log.ts. Null when capture was off/failed.
  raw_ref?: string | null;
  error?: string | null;
}

// Append one integration_sync_events row (the append-only debug history the setup
// pages surface). Profile-scoped: the caller supplies the profile the batch landed
// under — for Health Connect that is the TOKEN-resolved profile (the ingest is
// token-authed, NOT session-authed), for Strava the sync's profile. BEST-EFFORT:
// this MUST NOT change ingest behavior, so it never throws into the caller and a
// failure is only logged, never propagated — an event-insert problem can neither
// break nor (materially) slow the idempotent ingest. Error text is truncated so a
// pathological message can't bloat the row; tokens/secrets are never passed here.
export function recordSyncEvent(
  profileId: number,
  provider: string,
  ev: SyncEventInput
): void {
  try {
    db.prepare(
      `INSERT INTO integration_sync_events
         (profile_id, provider, at, ok, window_start, window_end,
          received, written, inserted, updated, unchanged, suppressed, skipped, raw_ref, error)
       VALUES (?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      profileId,
      provider,
      ev.ok ? 1 : 0,
      ev.windowStart ?? null,
      ev.windowEnd ?? null,
      ev.received ?? null,
      ev.written ?? null,
      ev.inserted ?? null,
      ev.updated ?? null,
      ev.unchanged ?? null,
      ev.suppressed ?? null,
      ev.skipped ?? null,
      ev.raw_ref ?? null,
      ev.error ? ev.error.slice(0, 500) : null
    );
  } catch (err) {
    // Swallow: debug logging can never be allowed to break the ingest it observes.
    log.error("recordSyncEvent failed", {
      provider,
      err: String(err),
    });
  }
}

// Retention sweep for integration_sync_events (issue #388), run once per hourly
// notify tick alongside the other maintenance sweeps (sweepReplayedKeys /
// pruneAuditEvents / sweepDeletedRows). Deletes events STRICTLY older than the
// window EXCEPT the newest event per (profile, provider) — kept regardless of age so
// a dormant provider's last-known state survives for the failure detector. GLOBAL by
// design (one call prunes every profile's aged rows), mirroring the sibling sweeps;
// the retained-newest subquery names `profile_id`, so it clears the profile-scoping
// guard. Best-effort — never throws, so a prune failure can't affect the tick. The
// prune SET matches the pure planSyncEventPrune (lib/integrations/sync-log), pinned
// in the db tier. Returns the number of rows removed.
export function pruneSyncEvents(
  maxAgeDays = SYNC_EVENTS_RETENTION_DAYS
): number {
  try {
    return db
      .prepare(
        `DELETE FROM integration_sync_events
          WHERE at < datetime('now', ?)
            AND id NOT IN (
              SELECT MAX(id) FROM integration_sync_events
               GROUP BY profile_id, provider
            )`
      )
      .run(daysAgoModifier(maxAgeDays)).changes;
  } catch (err) {
    log.error("pruneSyncEvents failed", { err: String(err) });
    return 0;
  }
}

function readConfig(
  conn: IntegrationConnection | undefined
): Record<string, unknown> {
  if (!conn?.config) return {};
  try {
    const v = JSON.parse(conn.config);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

// ---- Health Connect push token ----

// The active ingest token: the DB connection's token, falling back to the
// HEALTH_CONNECT_TOKEN env var for headless setups. Null when neither is set.
export function getHealthConnectToken(profileId: number): string | null {
  const fromDb = readConfig(getConnection(profileId, "health-connect")).token;
  if (typeof fromDb === "string" && fromDb) return fromDb;
  const env = process.env.HEALTH_CONNECT_TOKEN;
  return env && env.trim() ? env.trim() : null;
}

// Token lifecycle metadata for the setup UI (issue #24). The Health Connect token
// is stored raw (unlike the calendar feed's hash) because the setup page re-shows
// it so a user can re-copy it into the phone exporter; the env fallback carries no
// lifecycle (it's config, not a minted token).
export interface HealthConnectTokenInfo {
  token: string | null;
  source: "db" | "env" | "none";
  createdAt: string | null; // ISO 8601, DB token only
  lastUsedAt: string | null; // ISO 8601, throttled write on ingest
  expiresAt: string | null; // ISO 8601 or null (never)
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

export function getHealthConnectTokenInfo(
  profileId: number
): HealthConnectTokenInfo {
  const cfg = readConfig(getConnection(profileId, "health-connect"));
  const dbToken = str(cfg.token);
  if (dbToken) {
    return {
      token: dbToken,
      source: "db",
      createdAt: str(cfg.tokenCreatedAt),
      lastUsedAt: str(cfg.tokenLastUsedAt),
      expiresAt: str(cfg.tokenExpiresAt),
    };
  }
  const env = process.env.HEALTH_CONNECT_TOKEN;
  if (env && env.trim()) {
    return {
      token: env.trim(),
      source: "env",
      createdAt: null,
      lastUsedAt: null,
      expiresAt: null,
    };
  }
  return {
    token: null,
    source: "none",
    createdAt: null,
    lastUsedAt: null,
    expiresAt: null,
  };
}

// Generate (or rotate) a fresh token, mark the connection connected, and return
// it. `expiry` (issue #24) records an optional absolute expiry; "never" (default)
// preserves the historical no-expiry behaviour. A fresh mint replaces the whole
// config, dropping any prior last-used stamp.
export function generateHealthConnectToken(
  profileId: number,
  expiry: TokenExpiryChoice = "never"
): string {
  const token = crypto.randomBytes(24).toString("hex");
  const now = Date.now();
  upsertConnection(profileId, "health-connect", {
    status: "connected",
    config: {
      token,
      tokenCreatedAt: new Date(now).toISOString(),
      tokenExpiresAt: expiresAtFromChoice(expiry, now),
    },
  });
  return token;
}

// Record a successful ingest auth, throttled to once an hour (mirrors the session
// sliding-refresh write in lib/auth). Only stamps a DB-backed token — the env
// fallback isn't a minted token and has nowhere to record.
export function recordHealthConnectUse(profileId: number): void {
  const conn = getConnection(profileId, "health-connect");
  const cfg = readConfig(conn);
  if (!str(cfg.token)) return; // env fallback / no token: nothing to stamp
  if (!shouldRecordUse(str(cfg.tokenLastUsedAt), Date.now())) return;
  upsertConnection(profileId, "health-connect", {
    config: { ...cfg, tokenLastUsedAt: new Date().toISOString() },
  });
}

export function disconnectHealthConnect(profileId: number) {
  upsertConnection(profileId, "health-connect", {
    status: "disconnected",
    config: null,
  });
}

// Resolve a presented bearer token to the profile that owns it, or null. Each
// family member's phone pushes with their own profile's Health Connect token, so
// the token — not a fixed profile — determines whose data an ingest lands under.
// Every profile's stored token is compared in constant time (see token-match);
// the HEALTH_CONNECT_TOKEN env var is kept as a fallback that maps to profile 1,
// preserving existing single-user deployments.
function profileOneExists(): boolean {
  return !!db.prepare("SELECT 1 FROM profiles WHERE id = 1").get();
}

export function resolveHealthConnectProfile(
  presented: string | null
): number | null {
  const rows = db
    .prepare(
      "SELECT profile_id, config FROM integration_connections WHERE provider = 'health-connect'"
    )
    .all() as { profile_id: number; config: string | null }[];
  const nowMs = Date.now();
  const candidates: TokenCandidate[] = [];
  for (const r of rows) {
    const cfg = readConfig({ config: r.config } as IntegrationConnection);
    const token = cfg.token;
    if (typeof token === "string" && token) {
      // An expired token (issue #24) is treated as if it doesn't exist: it never
      // becomes a candidate, so a presented expired token yields the same "no
      // match" (401) as a bogus one — no oracle distinguishes the two.
      if (isTokenExpired(str(cfg.tokenExpiresAt), nowMs)) continue;
      candidates.push({ profileId: r.profile_id, token });
    }
  }
  const env = process.env.HEALTH_CONNECT_TOKEN?.trim();
  // The env-token fallback maps to profile 1, but only while profile 1 still
  // exists — an admin can delete it (profile deletion), and ingesting under a
  // missing profile would violate the profile_id FK on every write.
  if (env && profileOneExists()) {
    candidates.push({ profileId: 1, token: env });
  }
  const matched = matchTokenToProfile(presented, candidates);
  if (matched !== null) {
    recordHealthConnectUse(matched);
    // A good push self-clears a prior rotated/expired-token failure (#607): flip the
    // connection back to `connected` if it had been marked needs_reauth. Cheap — the
    // write only fires while it's actually needs_reauth.
    clearHealthConnectReauth(matched);
  }
  return matched;
}

// Flip a health-connect connection from `needs_reauth` back to `connected` — used
// after a successful ingest resolves, so a token that was rotated/expired and later
// re-copied to the phone (or freshly minted) stops showing as failing (#607). Only
// writes when it's currently needs_reauth, so the ingest hot path stays cheap.
function clearHealthConnectReauth(profileId: number): void {
  const conn = getConnection(profileId, "health-connect");
  if (conn?.status !== "needs_reauth") return;
  upsertConnection(profileId, "health-connect", { status: "connected" });
}

// True when this profile's stored Health Connect ingest token is present AND past its
// optional expiry (#607). The env-fallback token carries no expiry, and a profile with
// no DB token has nothing to enforce — both read false. Read at page render time by
// the Review/Issues surfaces so an expired token surfaces as a failing provider even
// when the phone has stopped pushing entirely (an expired token is dropped from
// candidacy, so its pushes 401 with nothing to attribute a sync event to).
export function isHealthConnectTokenExpired(profileId: number): boolean {
  const cfg = readConfig(getConnection(profileId, "health-connect"));
  if (!str(cfg.token)) return false;
  return isTokenExpired(str(cfg.tokenExpiresAt), Date.now());
}

// Record a best-effort failure sync event when a presented bearer token matched NO
// Health Connect connection but at least one is configured (#607) — i.e. the phone is
// pushing with a rotated or expired token, which otherwise 401s silently with no sync
// event, leaving the badge/Issues/card green while data stops flowing.
//
// Attribution: connection-scoped only when EXACTLY ONE non-disconnected HC connection
// exists (the overwhelmingly common single-user case); with several we can't tell
// which phone is misconfigured, so we skip rather than misattribute to the wrong
// profile. RATE-LIMITED to once per hour per profile so a phone hammering the ingest
// with a stale token can't flood integration_sync_events. The recorded ok:0 event
// flows through the existing currentlyFailingProviders read (badge, Issues, card) and
// self-clears on the next successful ingest; we also flip the connection needs_reauth
// so the setup card shows a Reconnect prompt.
export function recordUnmatchedHealthConnectPush(
  presented: string | null
): void {
  if (!presented) return; // a missing Authorization header isn't a rotated token
  const rows = db
    .prepare(
      "SELECT profile_id FROM integration_connections WHERE provider = 'health-connect' AND status != 'disconnected'"
    )
    .all() as { profile_id: number }[];
  if (rows.length !== 1) return; // can't attribute (0 or many) — skip
  const profileId = rows[0].profile_id;
  // Rate limit: skip if any failure event for this provider landed within the hour.
  const recent = db
    .prepare(
      `SELECT 1 FROM integration_sync_events
        WHERE profile_id = ? AND provider = 'health-connect' AND ok = 0
          AND at > datetime('now', '-1 hour') LIMIT 1`
    )
    .get(profileId);
  if (recent) return;
  markConnectionNeedsReauth(profileId, "health-connect");
  recordSyncEvent(profileId, "health-connect", {
    ok: false,
    error:
      "Ingest rejected: the pushed token no longer matches this connection. Mint a new token on Integrations → Google Health Connect and update the phone exporter.",
  });
}

// Short server-side timeout on the OAuth token-refresh fetches (issue #476, the same
// gap #470 touched). Without an AbortSignal a hung refresh — a connection that opens
// but never responds — would freeze the sequential hourly tick just as a hung API
// call would, only earlier (before any activity is fetched). A throw here is already
// caught by each sync's getXAccessToken try/catch, which records an ok:false event.
const TOKEN_REFRESH_TIMEOUT_MS = 15_000;

// ---- Strava OAuth ----

export const STRAVA_ID = "strava";
const STRAVA_TOKEN_URL = "https://www.strava.com/api/v3/oauth/token";

// Everything we persist for the Strava connection lives in the connection's
// `config` JSON: the app-registration credentials (entered in the UI), the
// transient OAuth `state`, the access/refresh tokens, and the incremental sync
// cursor.
export interface StravaConfig {
  clientId?: string;
  clientSecret?: string;
  oauthState?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number; // epoch seconds
  athleteId?: number;
  lastActivityAfter?: number; // epoch seconds — newest synced activity start
}

export function getStravaConfig(profileId: number): StravaConfig {
  return readConfig(getConnection(profileId, STRAVA_ID)) as StravaConfig;
}

// Merge a patch into the Strava config, preserving the rest. Pass status to flip
// connected/disconnected at the same time.
function patchStravaConfig(
  profileId: number,
  patch: Partial<StravaConfig>,
  status?: "connected" | "disconnected"
) {
  // Atomic read-merge-write (issue #470) so a token patch and a cursor patch from two
  // processes can't drop each other.
  mergeConnectionConfig(
    profileId,
    STRAVA_ID,
    () => getStravaConfig(profileId),
    patch,
    status
  );
}

export function setStravaCredentials(
  profileId: number,
  clientId: string,
  clientSecret: string
) {
  patchStravaConfig(profileId, {
    clientId: clientId.trim(),
    clientSecret: clientSecret.trim(),
  });
}

export function hasStravaCredentials(profileId: number): boolean {
  const c = getStravaConfig(profileId);
  return !!(c.clientId && c.clientSecret);
}

export function setStravaOAuthState(profileId: number, state: string) {
  patchStravaConfig(profileId, { oauthState: state });
}

// Read and clear the one-time CSRF state (single use).
export function takeStravaOAuthState(profileId: number): string | undefined {
  const state = getStravaConfig(profileId).oauthState;
  patchStravaConfig(profileId, { oauthState: undefined });
  return state;
}

// Store freshly-obtained tokens and mark the connection connected.
export function setStravaTokens(
  profileId: number,
  tokens: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    athleteId?: number;
  }
) {
  patchStravaConfig(
    profileId,
    {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      ...(tokens.athleteId != null ? { athleteId: tokens.athleteId } : {}),
    },
    "connected"
  );
}

export function setStravaCursor(profileId: number, epochSeconds: number) {
  patchStravaConfig(profileId, { lastActivityAfter: epochSeconds });
}

export function getStravaCursor(profileId: number): number {
  return getStravaConfig(profileId).lastActivityAfter ?? 0;
}

// Disconnect: clear tokens/state/cursor and mark disconnected, but KEEP the
// entered client id/secret so the user can reconnect without re-pasting them.
export function disconnectStrava(profileId: number) {
  const { clientId, clientSecret } = getStravaConfig(profileId);
  upsertConnection(profileId, STRAVA_ID, {
    status: "disconnected",
    config: {
      ...(clientId ? { clientId } : {}),
      ...(clientSecret ? { clientSecret } : {}),
    },
  });
}

// Return a valid access token, refreshing it first when it's missing or within a
// 5-minute margin of expiry. Strava rotates the refresh token on refresh, so we
// persist whatever comes back. Returns null when the connection isn't usable
// (no credentials or no refresh token yet).
export async function getStravaAccessToken(
  profileId: number
): Promise<string | null> {
  const c = getStravaConfig(profileId);
  if (!c.clientId || !c.clientSecret) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  if (c.accessToken && c.expiresAt && c.expiresAt - nowSec > 300) {
    return c.accessToken;
  }
  if (!c.refreshToken) return null;

  // Single-flight the refresh (issue #470): Strava rotates the refresh token, so if a
  // sibling process (web "Sync now" vs the hourly tick) is already refreshing this
  // connection, we must NOT present our about-to-be-consumed token — that consumed
  // token would come back invalid_grant and spuriously flag needs_reauth. On a lost
  // claim, reuse whatever usable access token is stored (the peer's fresh one, or our
  // own still-unexpired one — we entered here only within the 5-min expiry margin) and
  // otherwise skip this sync; the next tick picks up the refreshed pair.
  if (!claimTokenRefresh(profileId, STRAVA_ID)) {
    const latest = getStravaConfig(profileId);
    if (latest.accessToken && latest.expiresAt && latest.expiresAt > nowSec) {
      return latest.accessToken;
    }
    return null;
  }

  const res = await fetch(STRAVA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      grant_type: "refresh_token",
      refresh_token: c.refreshToken,
    }),
    signal: AbortSignal.timeout(TOKEN_REFRESH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text();
    // A definitive auth failure (invalid_grant / 401) means the refresh token is
    // dead — mark the connection needs_reauth so the tick stops retrying it forever
    // (issue #326). A transient failure (429/5xx/network) leaves it `connected` to
    // retry next tick. Either way we throw so the sync records an ok:0 event.
    if (isAuthRefreshFailure(res.status, body)) {
      markConnectionNeedsReauth(profileId, STRAVA_ID);
    }
    throw new Error(`Strava token refresh failed (${res.status}): ${body}`);
  }
  const json = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_at: number;
  };
  patchStravaConfig(profileId, {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: json.expires_at,
  });
  return json.access_token;
}

// ---- Oura personal access token ----

export const OURA_ID = "oura";

// Oura is a TOKEN-kind integration: the self-hoster mints a personal access token in
// the Oura developer portal and pastes it here — no OAuth app, redirect, or callback.
// Everything we persist lives in the connection's `config` JSON: the pasted token,
// the (optional) whoami identity captured at connect time for display, and the
// incremental sync cursor (the newest local day we've fully processed).
export interface OuraConfig {
  token?: string;
  // Captured from the personal_info whoami on connect, purely to show the user which
  // account is linked. Never contains anything we key on.
  personalInfo?: { id?: string; email?: string } | null;
  lastDay?: string; // YYYY-MM-DD — newest local day fully synced (the cursor)
}

export function getOuraConfig(profileId: number): OuraConfig {
  return readConfig(getConnection(profileId, OURA_ID)) as OuraConfig;
}

function patchOuraConfig(
  profileId: number,
  patch: Partial<OuraConfig>,
  status?: "connected" | "disconnected"
) {
  // Atomic read-merge-write (issue #470) — mirrors patchStravaConfig. Oura doesn't
  // rotate a refresh token (it's a pasted PAT), but its cursor patch still shares the
  // config row with connect-time writes, so the same lost-update guard applies.
  mergeConnectionConfig(
    profileId,
    OURA_ID,
    () => getOuraConfig(profileId),
    patch,
    status
  );
}

export function getOuraToken(profileId: number): string | null {
  const t = getOuraConfig(profileId).token;
  return typeof t === "string" && t ? t : null;
}

export function hasOuraToken(profileId: number): boolean {
  return !!getOuraToken(profileId);
}

// Store the pasted token (and the whoami identity), marking the connection connected.
// A freshly pasted token replaces the whole config — dropping any prior cursor — so a
// new token backfills from scratch rather than resuming a stale window.
export function setOuraToken(
  profileId: number,
  token: string,
  personalInfo?: { id?: string; email?: string } | null
) {
  upsertConnection(profileId, OURA_ID, {
    status: "connected",
    config: { token: token.trim(), personalInfo: personalInfo ?? null },
  });
}

export function getOuraCursor(profileId: number): string | null {
  const d = getOuraConfig(profileId).lastDay;
  return typeof d === "string" && d ? d : null;
}

export function setOuraCursor(profileId: number, day: string) {
  patchOuraConfig(profileId, { lastDay: day });
}

// Disconnect: clear the token/cursor/identity outright and mark disconnected. Unlike
// Strava (which keeps the entered client id/secret), the Oura token IS the whole
// credential, so there's nothing to retain — reconnecting means pasting a fresh token.
export function disconnectOura(profileId: number) {
  upsertConnection(profileId, OURA_ID, {
    status: "disconnected",
    config: null,
  });
}

// ---- Withings OAuth ----

export const WITHINGS_ID = "withings";
// Withings' single OAuth2 endpoint serves both the authorization-code exchange and
// the refresh (distinguished by grant_type); every API response is wrapped in
// { status, body } with status 0 = success.
const WITHINGS_TOKEN_URL = "https://wbsapi.withings.net/v2/oauth2";

// Everything we persist for the Withings connection lives in the connection's
// `config` JSON: the app-registration credentials (entered in the UI), the transient
// OAuth `state`, the access/refresh tokens, and the incremental sync cursor.
export interface WithingsConfig {
  clientId?: string;
  clientSecret?: string;
  oauthState?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number; // epoch seconds
  userId?: string; // Withings userid, captured for display
  lastUpdate?: number; // epoch seconds — measures `updatetime` cursor
}

export function getWithingsConfig(profileId: number): WithingsConfig {
  return readConfig(getConnection(profileId, WITHINGS_ID)) as WithingsConfig;
}

function patchWithingsConfig(
  profileId: number,
  patch: Partial<WithingsConfig>,
  status?: "connected" | "disconnected"
) {
  // Atomic read-merge-write (issue #470) — mirrors patchStravaConfig.
  mergeConnectionConfig(
    profileId,
    WITHINGS_ID,
    () => getWithingsConfig(profileId),
    patch,
    status
  );
}

export function setWithingsCredentials(
  profileId: number,
  clientId: string,
  clientSecret: string
) {
  patchWithingsConfig(profileId, {
    clientId: clientId.trim(),
    clientSecret: clientSecret.trim(),
  });
}

export function hasWithingsCredentials(profileId: number): boolean {
  const c = getWithingsConfig(profileId);
  return !!(c.clientId && c.clientSecret);
}

export function setWithingsOAuthState(profileId: number, state: string) {
  patchWithingsConfig(profileId, { oauthState: state });
}

// Read and clear the one-time CSRF state (single use).
export function takeWithingsOAuthState(profileId: number): string | undefined {
  const state = getWithingsConfig(profileId).oauthState;
  patchWithingsConfig(profileId, { oauthState: undefined });
  return state;
}

// Store freshly-obtained tokens and mark the connection connected.
export function setWithingsTokens(
  profileId: number,
  tokens: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    userId?: string;
  }
) {
  patchWithingsConfig(
    profileId,
    {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      ...(tokens.userId != null ? { userId: tokens.userId } : {}),
    },
    "connected"
  );
}

export function getWithingsCursor(profileId: number): number {
  return getWithingsConfig(profileId).lastUpdate ?? 0;
}

export function setWithingsCursor(profileId: number, epochSeconds: number) {
  patchWithingsConfig(profileId, { lastUpdate: epochSeconds });
}

// Disconnect: clear tokens/state/cursor and mark disconnected, but KEEP the entered
// client id/secret so the user can reconnect without re-pasting them (mirrors Strava).
export function disconnectWithings(profileId: number) {
  const { clientId, clientSecret } = getWithingsConfig(profileId);
  upsertConnection(profileId, WITHINGS_ID, {
    status: "disconnected",
    config: {
      ...(clientId ? { clientId } : {}),
      ...(clientSecret ? { clientSecret } : {}),
    },
  });
}

// The subset of a Withings OAuth token response we validate + persist. Withings
// returns expires_in (seconds), so callers compute expiresAt = now + expires_in.
export interface WithingsTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  userid?: string | number;
}

// Parse + shape-validate the { status, body } envelope of a Withings OAuth token
// response. Returns the token fields on success (status 0 with a well-formed body),
// or null for any error status / malformed body — so a 200 carrying an error object
// is treated as a failure, never stored as blank/NaN credentials. Pure (no I/O), so
// the callback + refresh paths share ONE validator and it's unit-testable.
export function parseWithingsTokenResponse(
  json: unknown
): WithingsTokenResponse | null {
  if (!json || typeof json !== "object") return null;
  const env = json as Record<string, unknown>;
  if (env.status !== 0) return null;
  const body =
    env.body && typeof env.body === "object"
      ? (env.body as Record<string, unknown>)
      : null;
  if (!body) return null;
  const access = body.access_token;
  const refresh = body.refresh_token;
  const expires = body.expires_in;
  if (
    typeof access !== "string" ||
    !access ||
    typeof refresh !== "string" ||
    !refresh ||
    typeof expires !== "number" ||
    !Number.isFinite(expires)
  ) {
    return null;
  }
  const userid = body.userid;
  return {
    access_token: access,
    refresh_token: refresh,
    expires_in: expires,
    userid:
      typeof userid === "string" || typeof userid === "number"
        ? userid
        : undefined,
  };
}

// Return a valid access token, refreshing it first when it's missing or within a
// 5-minute margin of expiry. Withings rotates the refresh token on refresh, so we
// persist whatever comes back. Returns null when the connection isn't usable (no
// credentials or no refresh token yet); throws on a refresh HTTP/shape failure so
// the sync records a failed event (mirrors getStravaAccessToken).
export async function getWithingsAccessToken(
  profileId: number
): Promise<string | null> {
  const c = getWithingsConfig(profileId);
  if (!c.clientId || !c.clientSecret) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  if (c.accessToken && c.expiresAt && c.expiresAt - nowSec > 300) {
    return c.accessToken;
  }
  if (!c.refreshToken) return null;

  // Single-flight the refresh (issue #470) — mirrors getStravaAccessToken. Withings
  // also rotates the refresh token, so a lost claim means a sibling process is
  // refreshing now; reuse a usable stored token or skip this sync rather than burn the
  // consumed refresh token into a spurious needs_reauth.
  if (!claimTokenRefresh(profileId, WITHINGS_ID)) {
    const latest = getWithingsConfig(profileId);
    if (latest.accessToken && latest.expiresAt && latest.expiresAt > nowSec) {
      return latest.accessToken;
    }
    return null;
  }

  const res = await fetch(WITHINGS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      action: "requesttoken",
      grant_type: "refresh_token",
      client_id: c.clientId,
      client_secret: c.clientSecret,
      refresh_token: c.refreshToken,
    }).toString(),
    signal: AbortSignal.timeout(TOKEN_REFRESH_TIMEOUT_MS),
  });
  if (!res.ok) {
    if (isAuthRefreshFailure(res.status)) {
      markConnectionNeedsReauth(profileId, WITHINGS_ID);
    }
    throw new Error(`Withings token refresh failed (${res.status})`);
  }
  // Withings rides errors in its { status, body } envelope over HTTP 200, so a dead
  // refresh token surfaces as an envelope status (401) that parseWithingsTokenResponse
  // rejects. Inspect that envelope status to mark needs_reauth on an auth failure
  // (issue #326) rather than losing it as a generic "unexpected shape".
  const json: unknown = await res.json();
  const parsed = parseWithingsTokenResponse(json);
  if (!parsed) {
    const envStatus =
      json &&
      typeof json === "object" &&
      typeof (json as { status?: unknown }).status === "number"
        ? (json as { status: number }).status
        : -1;
    if (isAuthRefreshFailure(envStatus)) {
      markConnectionNeedsReauth(profileId, WITHINGS_ID);
    }
    throw new Error("Withings token refresh returned an unexpected shape");
  }
  patchWithingsConfig(profileId, {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresAt: nowSec + parsed.expires_in,
    ...(parsed.userid != null ? { userId: String(parsed.userid) } : {}),
  });
  return parsed.access_token;
}
