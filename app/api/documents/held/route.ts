import { accessForProfile, accessibleProfilesForLogin } from "@/lib/auth";
import { isDemoMode, isDemoRestricted } from "@/lib/demo";
import { authenticateApiToken } from "@/lib/api-tokens";
import { apiTokenRateLimitKey } from "@/lib/api-token-format";
import { parseUploadTarget } from "@/lib/acquirer-identity";
import { resolvePortalIdentity } from "@/lib/portals";
import { heldDocumentHashes } from "@/lib/medical-pipeline/storage";
import { tombstonedDocumentHashes } from "@/lib/document-tombstones";
import { coveredDocumentHashes } from "@/lib/document-coverage";
import { checkRateLimit } from "@/lib/rate-limit";

// Current inventory for an upload destination: stored bytes, user deletions, and
// clinical-entry coverage. Clients offer hashes absent from all three lists;
// upload independently enforces refusals. Coverage is recomputed by its reader.
// See docs/api-tokens.md for the client protocol. Unlike upload/report writes,
// an unmapped inventory read must not create a pending identity.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A reconciliation read at the start of a run — one call per identity, so a household
// with a handful of patients makes a handful of calls. Generous, still capped.
const HELD_RATE_LIMIT = 120;
const HELD_RATE_WINDOW_MS = 5 * 60 * 1000;

function jsonError(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status });
}

export async function GET(req: Request): Promise<Response> {
  const limit = checkRateLimit(
    `held:${apiTokenRateLimitKey(req.headers.get("authorization"))}`,
    { limit: HELD_RATE_LIMIT, windowMs: HELD_RATE_WINDOW_MS }
  );
  if (!limit.ok) {
    return Response.json(
      { ok: false, error: "rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } }
    );
  }

  const auth = await authenticateApiToken(req, "upload:documents");
  if (!auth.ok) return jsonError(auth.error, auth.status);
  const { login } = auth;

  // Query parameters only — this is a GET, so there is no multipart body to read the
  // fields from. Otherwise the destination contract is the upload's, byte for byte:
  // `profile=<id>` for a human with curl, `portal/account/patient` for an acquirer.
  const params = new URL(req.url).searchParams;
  const target = parseUploadTarget({
    profile: params.get("profile"),
    portal: params.get("portal"),
    account: params.get("account"),
    patient: params.get("patient"),
  });
  if (!target.ok) return jsonError(target.error, 400);

  let profileId: number;
  if (target.target.kind === "profile") {
    profileId = target.target.profileId;
  } else {
    const resolved = resolvePortalIdentity(
      target.target.portalSlug,
      target.target.accountSlug,
      target.target.patientLabel
    );
    if (!resolved.ok) {
      // The same typed refusal the upload gives, with the same wording, so a client
      // handles one case rather than two. Unknown, IGNORED, and ambiguous-account all
      // answer identically — the endpoint is non-oracular about a household's choices,
      // and a READ must be at least as careful about that as a write.
      return Response.json(
        {
          ok: false,
          error: "unmapped-identity",
          detail:
            "That portal patient is not mapped to a profile yet. Map it under Integrations → Patient portals.",
        },
        { status: 404 }
      );
    }
    profileId = resolved.profileId;
  }

  // Reach FIRST, then access — accessForProfile assumes reachability and defaults an
  // ungranted member to 'write', so it must never be consulted alone. A member who
  // cannot reach the profile and one who holds only read both get the same 403: the
  // endpoint is not a probe for which profiles exist.
  //
  // WRITE, not read, and deliberately so: this mirrors the upload's gate exactly, so the
  // inventory can never answer for a profile the same token would be refused at. Demo
  // mode refuses every non-admin write, so a demo-restricted token is refused here too.
  const reachable = accessibleProfilesForLogin(login.id).some(
    (p) => p.id === profileId
  );
  if (
    isDemoRestricted(isDemoMode(), login.role) ||
    !reachable ||
    accessForProfile(login.id, login.role, profileId) !== "write"
  ) {
    return jsonError("no write access to that profile", 403);
  }

  return Response.json({
    ok: true,
    profile: profileId,
    held: heldDocumentHashes(profileId),
    deleted: tombstonedDocumentHashes(profileId),
    // The third list (#1828). Additive on the wire: a client written against the two-list
    // contract keeps working unchanged — it simply keeps re-offering what this list would
    // have told it to stop offering, which is exactly today's behaviour.
    covered: coveredDocumentHashes(profileId),
  });
}
