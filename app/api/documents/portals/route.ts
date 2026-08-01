import { accessForProfile, accessibleProfilesForLogin } from "@/lib/auth";
import { isDemoMode, isDemoRestricted } from "@/lib/demo";
import { authenticateApiToken } from "@/lib/api-tokens";
import { checkRateLimit } from "@/lib/rate-limit";
import { apiTokenRateLimitKey } from "@/lib/api-token-format";
import { buildToolConfig } from "@/lib/acquirer-identity";
import { listVisiblePortalRegistry } from "@/lib/portal-visibility";

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
// is gated the same way. A read-only-everywhere caregiver is REFUSED (403) rather than
// handed an empty list: the gate is about the CAPABILITY, and "here are your zero
// portals" would answer a question this token may not ask at all.
//
// WHAT IT ANSWERS WITH IS SCOPED (#1796). Passing the gate no longer buys the whole
// instance-wide vocabulary: the rows are filtered to the accounts this login can reach,
// through the ONE reachability computation #1791 established for run reports
// (`lib/portal-visibility.ts`), applied here to the registry row. An account nickname
// is household information — "Mom" names a household's composition — so a caller who
// cannot reach the profiles an account is claimed by does not learn it exists. An admin
// reaches every profile, so an admin still gets the full registry, and an unclaimed
// account (no binding at all) stays visible to this population because a portal created
// a minute ago has no bindings yet and `tool init` must still be able to learn its slug.
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
  const accessible = accessibleProfilesForLogin(login.id);
  const canRead =
    !isDemoRestricted(isDemoMode(), login.role) &&
    accessible.some(
      (p) => accessForProfile(login.id, login.role, p.id) === "write"
    );
  if (!canRead) {
    return Response.json(
      { ok: false, error: "no write access to any profile" },
      { status: 403 }
    );
  }

  // The accessible set, resolved HERE at the auth boundary and handed to the reader as
  // already-authorized ids — the cross-profile reader convention. The unclaimed flag is
  // `canRead` itself, not a constant: this gate IS the `canManagePending` population the
  // page passes, so both surfaces answer from one decision rather than two that happen
  // to agree.
  const registry = listVisiblePortalRegistry(
    accessible.map((p) => p.id),
    canRead
  );

  return Response.json({
    ok: true,
    portals: buildToolConfig(registry.portals, registry.accounts),
  });
}
