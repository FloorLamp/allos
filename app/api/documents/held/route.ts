import { accessForProfile, accessibleProfilesForLogin } from "@/lib/auth";
import { isDemoMode, isDemoRestricted } from "@/lib/demo";
import { authenticateApiToken } from "@/lib/api-tokens";
import { apiTokenRateLimitKey } from "@/lib/api-token-format";
import { parseUploadTarget } from "@/lib/acquirer-identity";
import { resolvePortalIdentity } from "@/lib/portals";
import { heldDocumentHashes } from "@/lib/medical-pipeline/storage";
import { tombstonedDocumentHashes } from "@/lib/document-tombstones";
import { checkRateLimit } from "@/lib/rate-limit";

// THE DOCUMENT INVENTORY (issue #1776) — "what does allos have for this identity?"
//
// ── THE FAILURE IT FIXES ─────────────────────────────────────────────────────
//
// The acquirer contract (#1739) let a client SEND documents and REPORT what a run did,
// but never ask what allos already holds. So a client avoiding re-uploads had exactly
// one option: remember locally which hashes it had sent. That local list is a record of
// the CLIENT'S OWN PAST BEHAVIOUR, not of allos's current state, and the two diverge the
// instant a document is deleted in allos — the client still believes it sent that
// document, so it never sends it again; allos no longer has it; nothing on either side
// notices. The failure is silent AND permanent: a daily sync keeps reporting success and
// the document simply is not there any more.
//
// The only reconciliation available was a `--force` flag re-uploading every byte for an
// identity to find the one that was missing — which also landed a 'skipped' row per
// attempt, visibly inflating the document count (11 documents became 22 rows on a test
// instance). This endpoint replaces that with a question: no bytes move to discover the
// answer, no rows are created, and a deletion is noticed on the NEXT run rather than
// never.
//
// ── THREE STATES, NOT TWO — AND THAT IS THE WHOLE SAFETY ARGUMENT ────────────
//
// A bare `held` list would be actively dangerous, because the obvious client behaviour
// it invites — diff against it and send the difference — would RESURRECT every document
// the user deleted in allos. The documents people delete from a portal feed are junk
// pages, wrong-patient bindings, and things they specifically do not want held; a
// sensitive document silently returning every morning is a trust-destroying failure. So
// the answer distinguishes:
//
//   held    — hashes with stored bytes for this identity's profile.
//   deleted — content-hash tombstones (#1777), written when a user deletes a document.
//
// A client sends exactly the hashes in NEITHER list. That is what makes the contract
// safe for a client with NO local state at all — it needs no memory of its own, which is
// precisely what made the old design fail. A hash absent from both after a previous send
// means the document is genuinely gone WITHOUT a deliberate delete (lost, corrupted):
// re-sending it is correct, and that is the reconciliation this endpoint exists for.
//
// THE LISTS ARE DISJOINT BY CONSTRUCTION, not by filtering here: a delete removes the
// stored row as it writes the tombstone, a human re-upload clears the tombstone as it
// stores, and a reassignment clears the destination's. If they ever overlapped, the
// client's "in neither list" rule would still be safe — it would simply not send — so
// the invariant is load-bearing for freshness, never for safety.
//
// DELETIONS STAY DEAD SERVER-SIDE, NOT BY CLIENT CONVENTION. This endpoint is only the
// polite half. The upload path REFUSES a tombstoned hash outright (#1777), so a client
// that ignores `deleted` — or was written before it existed — still cannot resurrect
// anything. Un-deleting is an explicit human act: the allow-again affordance in Data →
// Review, or a person re-uploading the file.
//
// ── AUTH: THE UPLOAD'S, EXACTLY ──────────────────────────────────────────────
//
// Same `upload:documents` scope, because a token that can SEND bytes may know what is
// held — the inventory discloses strictly less than the sender already knows it sent.
// Same rate-limit-before-scrypt-verify posture in its own key namespace, so a chatty
// reconciler cannot consume the upload budget. Same destination contract through the
// same exactly-one-of parser, the same `resolvePortalIdentity` path, and the same
// non-oracular `unmapped-identity` refusal. Then the same explicit write gate: demo,
// reachability, then write. The endpoint therefore never answers beyond the scope of its
// authenticated identity.
//
// ONE DELIBERATE DIFFERENCE FROM THE UPLOAD: an unmapped identity records NO pending
// row here. The pending list is populated by the WRITE paths (an upload, a run report),
// where a refusal represents a real attempt to file something; letting a read append to
// it would let a token grow a household's pending list forever without ever pushing a
// document. The refusal SHAPE is identical, which is what a client actually keys on.
//
// WHAT IT DOES NOT DISCLOSE: hashes only. No filenames, no dates, no counts, no patient
// labels — a filename is household information, and this answer goes to an automated
// client. The names of deleted documents are shown to PEOPLE, in Data → Review.
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
  });
}
