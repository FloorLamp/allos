// e2e seed fixtures — session domain. Composed (in order) by e2e/seed-events.ts.
//
// THE WORKER'S SESSION, MINTED AT SEED TIME.
//
// Every worker used to drive the real login form once during setup: new context,
// GET /login, fill, submit, wait for the redirect, save storageState. Measured in
// CI that was `auth=2039ms` — MORE than the `next start` boot beside it
// (`boot=1540ms`) — and it is paid per worker, and again per worker GENERATION,
// because a Playwright worker is bound to one project (a shard holding both
// chromium and mobile specs starts a second set of workers partway through).
//
// Almost all of it is one scrypt verification, which is the login form's whole
// job and cannot be made cheaper without making it worse. So this skips the form
// instead: the template database is seeded with a session row, and the raw token
// is written beside it as a Playwright storageState. Every worker copies the
// template, so every worker — and every later generation — starts already signed
// in, for free.
//
// WHY THIS DOES NOT COST COVERAGE. Nine specs drive the real form explicitly
// (smoke, dashboard, two-factor, email-auth, family-grants, household-rollup,
// household-history, emergency-card, demo), so the flow is still exercised on
// purpose rather than incidentally.
//
// WHY IT IS TWO CALLS AND NOT ONE. `app/(auth)/login/actions.ts` finishes a
// successful login with exactly three effects that outlive the request:
// `createSession`, `issueSessionCookies`, and `recordAudit(loginSuccess)`. All
// three are reproduced below, from the same helpers, because the audit row is not
// bookkeeping — e2e/audit-log.spec.ts asserts a `login.success` entry is visible,
// and it was there only as a side effect of the worker signing in. A seed that
// minted the session and skipped the audit would leave that spec failing with no
// hint that a session shortcut caused it.
//
// KEEP THIS PAIRED WITH THAT ACTION. If the success path grows a fourth effect,
// it belongs here too.

import "../../scripts/load-env";

import fs from "node:fs";
import path from "node:path";
import { recordAudit } from "../../lib/audit";
import { AUDIT_ACTIONS } from "../../lib/audit-actions";
import { createSession } from "../../lib/auth";
import { db } from "../../lib/db";
import {
  SESSION_SLIDE_MARK_TTL_SEC,
  SESSION_SLIDE_MARK_VALUE,
  sessionCookieName,
  sessionCookieOptions,
  slideMarkCookieName,
} from "../../lib/session-cookie";
import { ADMIN_USERNAME, AUTH_BASENAME } from "../worker-env";

/**
 * The worker servers ALWAYS run `NODE_ENV=production` (e2e/fixtures.ts pins it
 * unconditionally — see #1538), so they read the `__Host-` cookie names and
 * require Secure. This process is a plain `tsx` script and is NOT production, so
 * the module-level `SESSION_COOKIE` / `sessionCookieOptions().secure` it would
 * otherwise inherit are the DEV answers.
 *
 * That mismatch is silent and total: the browser stores a valid `ht_session`
 * cookie, the server only ever looks for `__Host-ht_session`, and every request
 * is anonymous with nothing anywhere reporting a problem. It is what the first
 * version of this fixture did. Ask for the server's shape explicitly.
 *
 * Chrome accepts a Secure cookie on `http://localhost` — localhost is a secure
 * context — which is why the whole harness works over plain HTTP.
 */
const SERVER_COOKIES_ARE_SECURE = true;

/**
 * The user agent recorded on the seeded session.
 *
 * The real flow stores the browser's own string; `sessions.user_agent` is
 * display-only, so naming this one is honest about where the session came from
 * and makes the row self-explaining on Settings → Account & security.
 *
 * Keep it ONE token of under 40 characters that does not look like a real UA.
 * `deviceLabel()` recognises no browser or platform in it and falls through to
 * the first whitespace-delimited word, which is what `e2e/active-sessions.spec.ts`
 * asserts on: a short label, never a raw `Mozilla/5.0…`.
 */
const SEEDED_USER_AGENT = "e2e-seeded-session";

/** A Playwright storageState cookie. Mirrors what the browser would have stored. */
interface StorageStateCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Lax" | "Strict" | "None";
}

/**
 * One cookie exactly as `issueSessionCookies` would have set it.
 *
 * `expires` is REAL time, not the run's frozen instant: the browser evicts an
 * expired cookie by its OWN clock, which no e2e freeze reaches. Seeding it
 * against the frozen instant would work by luck and break whenever a run's
 * ALLOS_TEST_NOW was nudged backwards.
 */
function cookie(
  name: string,
  value: string,
  maxAgeSec: number
): StorageStateCookie {
  const opts = sessionCookieOptions(maxAgeSec);
  return {
    name,
    value,
    // Host-only, no leading dot — a `__Host-` cookie may not carry a Domain
    // attribute. The port is deliberately absent: cookies are not port-scoped, so
    // ONE storageState is valid on every worker's port.
    domain: "localhost",
    path: opts.path,
    expires: Math.floor(Date.now() / 1000) + maxAgeSec, // clock-ok: a cookie expiry is judged by the BROWSER's clock, which no e2e freeze reaches — frozenNow() here would expire the session against real time
    httpOnly: opts.httpOnly,
    // NOT `opts.secure` — see SERVER_COOKIES_ARE_SECURE. `__Host-` is only
    // honoured on a Secure cookie, so the name and this flag must move together.
    secure: SERVER_COOKIES_ARE_SECURE,
    sameSite: "Lax",
  };
}

/**
 * Mint the admin session the workers will start with, and write it as a
 * storageState into the template directory (cwd), where the per-worker copy puts
 * it at `workerAuthPath(idx)` with no further work.
 */
export function seedWorkerSession(): void {
  const login = db
    .prepare("SELECT id FROM logins WHERE username = ?")
    .get(ADMIN_USERNAME) as { id: number } | undefined;
  if (!login) {
    throw new Error(
      `seedWorkerSession: no login "${ADMIN_USERNAME}" — the admin bootstrap ` +
        `must run before this fixture`
    );
  }

  const { token, maxAgeSec } = createSession(login.id, SEEDED_USER_AGENT);
  recordAudit({
    loginId: login.id,
    action: AUDIT_ACTIONS.loginSuccess,
    detail: ADMIN_USERNAME,
  });

  const state = {
    cookies: [
      cookie(sessionCookieName(SERVER_COOKIES_ARE_SECURE), token, maxAgeSec),
      cookie(
        slideMarkCookieName(SERVER_COOKIES_ARE_SECURE),
        SESSION_SLIDE_MARK_VALUE,
        SESSION_SLIDE_MARK_TTL_SEC
      ),
    ],
    origins: [],
  };
  fs.writeFileSync(
    path.join(process.cwd(), AUTH_BASENAME),
    JSON.stringify(state, null, 2) + "\n"
  );
}
