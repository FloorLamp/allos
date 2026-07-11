import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { log } from "@/lib/log";
import { getCurrentSession } from "@/lib/auth";
import {
  getWithingsConfig,
  takeWithingsOAuthState,
  setWithingsTokens,
  parseWithingsTokenResponse,
} from "@/lib/integrations/connections";
import {
  appUrl,
  withingsCallbackUrl,
} from "@/app/(app)/integrations/withings/url";

// OAuth 2.0 authorization-code callback for Withings. The user is redirected here
// from Withings after approving access; we validate the CSRF `state`, exchange the
// `code` for tokens, and persist them. The session cookie rides along on this
// top-level redirect (SameSite=Lax), so we resolve the ACTIVE profile from it and
// bind the connection to that profile — and reject anonymous hits. The single-use
// `state` is stored per-profile, so takeWithingsOAuthState(profile.id) only matches
// when the state belongs to the session's active profile. Mirrors the Strava
// callback end to end (per the middleware/auth conventions — this path is NOT public).
export const dynamic = "force-dynamic";

const TOKEN_URL = "https://wbsapi.withings.net/v2/oauth2";

async function redirectTo(params?: Record<string, string>) {
  const url = new URL(await appUrl("/integrations/withings"));
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
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.redirect(new URL(await appUrl("/login")));
  }
  const profileId = session.profile.id;

  const { searchParams } = new URL(req.url);
  const error = searchParams.get("error");
  const code = searchParams.get("code");
  const state = searchParams.get("state") ?? undefined;

  // Don't consume the stored OAuth state on stray/garbage hits — a bare GET (no
  // code/state) must not wipe an in-flight attempt. Only a request that actually
  // carries both a code and a state is a real callback, so read-and-clear the
  // single-use state only then.
  if (error) return await redirectTo({ error });
  if (!code) return await redirectTo({ error: "missing_code" });
  if (!state) return await redirectTo({ error: "state_mismatch" });
  const expectedState = takeWithingsOAuthState(profileId);
  if (!statesMatch(state, expectedState)) {
    return await redirectTo({ error: "state_mismatch" });
  }

  const { clientId, clientSecret } = getWithingsConfig(profileId);
  if (!clientId || !clientSecret) {
    return await redirectTo({ error: "missing_credentials" });
  }

  // Withings' token exchange requires the SAME redirect_uri used to start the flow.
  const redirectUri = await withingsCallbackUrl();
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        action: "requesttoken",
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }).toString(),
    });
    if (!res.ok) {
      log.error("withings token exchange failed", { status: res.status });
      return await redirectTo({ error: "token_exchange_failed" });
    }
    // Shape-validate the { status, body } envelope before persisting: a 200 with an
    // error status / malformed body must be treated as a failure, not stored as
    // blank/NaN credentials.
    const parsed = parseWithingsTokenResponse(await res.json());
    if (!parsed) {
      log.error("withings token exchange returned an unexpected shape");
      return await redirectTo({ error: "token_exchange_failed" });
    }
    setWithingsTokens(profileId, {
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token,
      expiresAt: Math.floor(Date.now() / 1000) + parsed.expires_in,
      userId: parsed.userid != null ? String(parsed.userid) : undefined,
    });
  } catch (err) {
    log.error("withings token exchange error", { err: String(err) });
    return await redirectTo({ error: "token_exchange_failed" });
  }

  return await redirectTo();
}
