import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { log } from "@/lib/log";
import { getCurrentSession } from "@/lib/auth";
import { getUserSex, setUserSex } from "@/lib/settings";
import {
  getStravaConfig,
  takeStravaOAuthState,
  setStravaTokens,
} from "@/lib/integrations/connections";
import { appUrl } from "@/app/(app)/integrations/strava/url";

// OAuth 2.0 authorization-code callback for Strava. The user is redirected here
// from Strava after approving access; we validate the CSRF `state`, exchange the
// `code` for tokens, persist them, and (once) backfill the profile's sex from the
// athlete data. The session cookie rides along on this top-level redirect
// (SameSite=Lax), so we resolve the ACTIVE profile from it and bind the
// connection to that profile — and reject anonymous hits. The single-use `state`
// is stored per-profile, so takeStravaOAuthState(profile.id) only matches when
// the state belongs to the session's active profile.
export const dynamic = "force-dynamic";

const TOKEN_URL = "https://www.strava.com/api/v3/oauth/token";
const ATHLETE_URL = "https://www.strava.com/api/v3/athlete";

// Build the post-callback redirect off the externally-visible base URL, NOT
// `req.url`: behind a reverse proxy `req.url`'s host is the internal target
// (localhost:3000), so a redirect derived from it bounces the browser to
// localhost after a successful auth. `appUrl()` uses the configured public URL
// (else the forwarded host) — the address the user actually reached us on.
function redirectTo(params?: Record<string, string>) {
  const url = new URL(appUrl("/integrations/strava"));
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

// Constant-time compare of the presented state against the stored one.
function statesMatch(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export async function GET(req: Request) {
  // Require a live session: the callback binds tokens to the caller's ACTIVE
  // profile, so an anonymous hit has no profile to bind to. The middleware only
  // checks cookie presence (this path is no longer allowlisted), so this is the
  // authoritative check.
  const session = getCurrentSession();
  if (!session) {
    return NextResponse.redirect(new URL(appUrl("/login")));
  }
  const STRAVA_PROFILE_ID = session.profile.id;

  const { searchParams } = new URL(req.url);
  const error = searchParams.get("error");
  const code = searchParams.get("code");
  const state = searchParams.get("state") ?? undefined;

  // Don't consume the stored OAuth state on stray/garbage hits — a bare GET (no
  // code/state) must not wipe an in-flight attempt. Only a request that actually
  // carries both a code and a state is a real callback, so read-and-clear the
  // single-use state only then (preserving its single-use property for real
  // attempts). Strava-reported errors and param-less hits are rejected untouched.
  if (error) return redirectTo({ error });
  if (!code) return redirectTo({ error: "missing_code" });
  if (!state) return redirectTo({ error: "state_mismatch" });
  const expectedState = takeStravaOAuthState(STRAVA_PROFILE_ID);
  if (!statesMatch(state, expectedState)) {
    return redirectTo({ error: "state_mismatch" });
  }

  const { clientId, clientSecret } = getStravaConfig(STRAVA_PROFILE_ID);
  if (!clientId || !clientSecret) {
    return redirectTo({ error: "missing_credentials" });
  }

  // Exchange the code for tokens. The response embeds a summary `athlete`.
  let tokenJson: {
    access_token: string;
    refresh_token: string;
    expires_at: number;
    athlete?: { id?: number; sex?: string };
  };
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
      }),
    });
    if (!res.ok) {
      log.error("strava token exchange failed", { status: res.status });
      return redirectTo({ error: "token_exchange_failed" });
    }
    const parsed = (await res.json()) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_at?: unknown;
      athlete?: { id?: number; sex?: string };
    };
    // Validate the token payload before persisting: a 200 with a malformed/empty
    // body (an error object, an HTML error page parsed as JSON, a partial response)
    // must be treated as a failure, not stored as blank/NaN credentials.
    if (
      typeof parsed.access_token !== "string" ||
      !parsed.access_token ||
      typeof parsed.refresh_token !== "string" ||
      !parsed.refresh_token ||
      typeof parsed.expires_at !== "number" ||
      !Number.isFinite(parsed.expires_at)
    ) {
      log.error("strava token exchange returned an unexpected shape");
      return redirectTo({ error: "token_exchange_failed" });
    }
    tokenJson = {
      access_token: parsed.access_token,
      refresh_token: parsed.refresh_token,
      expires_at: parsed.expires_at,
      athlete: parsed.athlete,
    };
  } catch (err) {
    log.error("strava token exchange error", { err: String(err) });
    return redirectTo({ error: "token_exchange_failed" });
  }

  setStravaTokens(STRAVA_PROFILE_ID, {
    accessToken: tokenJson.access_token,
    refreshToken: tokenJson.refresh_token,
    expiresAt: tokenJson.expires_at,
    athleteId: tokenJson.athlete?.id,
  });

  // One-time profile fetch to backfill the user's sex if it isn't already set.
  // Best-effort: a failure here must not block the connection. The token
  // response's embedded athlete carries `sex` too, used as a fallback.
  try {
    if (getUserSex(STRAVA_PROFILE_ID) === null) {
      let sexRaw = tokenJson.athlete?.sex;
      try {
        const res = await fetch(ATHLETE_URL, {
          headers: { Authorization: `Bearer ${tokenJson.access_token}` },
        });
        if (res.ok) {
          const athlete = (await res.json()) as { sex?: string };
          if (athlete.sex) sexRaw = athlete.sex;
        }
      } catch {
        /* fall back to the embedded athlete sex */
      }
      const sex = sexRaw === "M" ? "male" : sexRaw === "F" ? "female" : null;
      if (sex) setUserSex(STRAVA_PROFILE_ID, sex);
    }
  } catch (err) {
    log.warn("strava sex backfill skipped", { err: String(err) });
  }

  return redirectTo();
}
