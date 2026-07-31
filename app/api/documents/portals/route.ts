import { accessForProfile, accessibleProfilesForLogin } from "@/lib/auth";
import { isDemoMode, isDemoRestricted } from "@/lib/demo";
import { authenticateApiToken } from "@/lib/api-tokens";
import { checkRateLimit } from "@/lib/rate-limit";
import { apiTokenRateLimitKey } from "@/lib/api-token-format";
import { buildToolConfig } from "@/lib/acquirer-identity";
import { listPortalAccounts, listPortals } from "@/lib/portals";

// The allos-side portal CONFIG, for the tool to ingest (issue #1759).
//
// WHY IT EXISTS. Portal and account slugs are allos-MINTED vocabulary, yet the tool
// operator used to hand-type them into local config. A typo'd slug does not fail loudly:
// it produces an `unmapped-identity` refusal deliberately indistinguishable from every
// other cause (correct security posture, miserable debugging). Letting the tool INGEST
// the vocabulary makes slug typos impossible instead of merely debuggable — `tool init`
// fetches this, writes the slugs into local config, and prompts only for what allos
// genuinely does not know: the URL per portal, and which account slug this machine's
// login is.
//
// SAME FAMILY AS /api/documents/profiles, deliberately and in the same order:
//   • rate-limited on the token's PUBLIC ID HALF, BEFORE the scrypt verify, in its own
//     key namespace so a chatty `init` cannot consume the upload budget;
//   • the SAME `upload:documents` scope — destination knowledge is part of the upload
//     capability, not a separate grant. The argument that justified the profiles GET
//     applies verbatim: a tool that may upload needs to know where it may upload to.
//   • the same `lib/public-paths.ts` entry-family (a bearer GET from a tool on the
//     user's own machine carries no session cookie, and the coarse middleware would
//     answer it with a 307 at /login instead of a status the caller can act on).
//
// THE VISIBILITY GATE MIRRORS THE CARD'S. Integrations → Patient portals is
// member-visible to any login with write access to at least one profile (#1753's owner
// ruling: `login.role === "admin" || writableProfiles.length > 0`), so the token's login
// is gated the same way and this discloses exactly what that login already sees there.
// A read-only-everywhere caregiver is REFUSED (403) rather than handed an empty list:
// there is no such thing as "your zero portals" — the registry is instance-wide, so an
// empty array would be a lie about the household rather than a scoped answer.
//
// DELIBERATELY ABSENT. No address-shaped field anywhere (allos has no column for one),
// and no patient labels — mapped, pending and ignored bindings alike. Enforced by the
// pure `buildToolConfig` shape rather than by remembering not to spread a row.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// `tool init` is a config read, not a hot path; generous, still capped.
const CONFIG_RATE_LIMIT = 120;
const CONFIG_RATE_WINDOW_MS = 5 * 60 * 1000;

export async function GET(req: Request): Promise<Response> {
  const limit = checkRateLimit(
    `portals:${apiTokenRateLimitKey(req.headers.get("authorization"))}`,
    { limit: CONFIG_RATE_LIMIT, windowMs: CONFIG_RATE_WINDOW_MS }
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

  // The card's gate, recomputed: reach FIRST, then access (accessForProfile assumes
  // reachability — the same order the POST routes use). Demo mode refuses every
  // non-admin write, so a demo-restricted token has no writable profile and is refused
  // here exactly as it would be at an upload.
  const canRead =
    !isDemoRestricted(isDemoMode(), login.role) &&
    accessibleProfilesForLogin(login.id).some(
      (p) => accessForProfile(login.id, login.role, p.id) === "write"
    );
  if (!canRead) {
    return Response.json(
      { ok: false, error: "no write access to any profile" },
      { status: 403 }
    );
  }

  return Response.json({
    ok: true,
    portals: buildToolConfig(listPortals(), listPortalAccounts()),
  });
}
