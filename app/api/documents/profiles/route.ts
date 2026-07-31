import { accessForProfile, accessibleProfilesForLogin } from "@/lib/auth";
import { isDemoMode, isDemoRestricted } from "@/lib/demo";
import { authenticateApiToken } from "@/lib/api-tokens";
import { disambiguateProfileNames } from "@/lib/profile-disambiguation";
import { checkRateLimit } from "@/lib/rate-limit";
import { apiTokenRateLimitKey } from "@/lib/api-token-format";

// The token's WRITABLE profiles (issue #1735). This is what lets a CLI resolve
// `--profile alice` to an id, and target several people in one run, without the operator
// having to look ids up in the UI first.
//
// SAME TOKEN, SAME SCOPE. It deliberately does NOT introduce a read capability: an
// `upload:documents` token needs to know where it may upload, so the destination list is
// part of that capability rather than a separate grant. What it discloses is exactly the
// set of names this login already sees in its own header profile switcher — labels run
// through the SAME disambiguation the switcher and the household chips use, so a
// household with two "Alex" profiles reads identically here — and nothing else: no
// health data, no counts, no profiles the login cannot reach.
//
// WRITABLE, not merely accessible. A caregiver with a read-only grant on grandma's
// profile can see her in the switcher but may not upload to her, so listing her here
// would only produce a 403 one step later. Reach is checked FIRST and access second,
// the same order the POST route uses (accessForProfile assumes reachability). Demo mode
// refuses every non-admin write, so a demo-restricted token's writable set is empty.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIST_RATE_LIMIT = 120;
const LIST_RATE_WINDOW_MS = 5 * 60 * 1000;

export async function GET(req: Request): Promise<Response> {
  // Rate-limited before the scrypt verify for the same reason the POST is; a separate
  // key namespace so a chatty resolver can't consume the upload budget.
  const limit = checkRateLimit(
    `profiles:${apiTokenRateLimitKey(req.headers.get("authorization"))}`,
    { limit: LIST_RATE_LIMIT, windowMs: LIST_RATE_WINDOW_MS }
  );
  if (!limit.ok) {
    return Response.json(
      { ok: false, error: "rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } }
    );
  }

  const auth = await authenticateApiToken(req, "upload:documents");
  if (!auth.ok) {
    return Response.json(
      { ok: false, error: auth.error },
      { status: auth.status }
    );
  }
  const { login } = auth;

  const demoBlocked = isDemoRestricted(isDemoMode(), login.role);
  const accessible = accessibleProfilesForLogin(login.id);
  // Disambiguate across the whole ACCESSIBLE set, then filter to the writable ones, so a
  // label here is byte-identical to the one the switcher shows for the same person.
  const labels = disambiguateProfileNames(accessible);
  const profiles = demoBlocked
    ? []
    : accessible
        .filter((p) => accessForProfile(login.id, login.role, p.id) === "write")
        .map((p) => ({ id: p.id, name: labels.get(p.id) ?? p.name }));

  return Response.json({ ok: true, profiles });
}
