import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { accessForProfile, accessibleProfilesForLogin } from "@/lib/auth";
import { isDemoMode, isDemoRestricted } from "@/lib/demo";
import { authenticateApiToken } from "@/lib/api-tokens";
import { apiTokenRateLimitKey } from "@/lib/api-token-format";
import { ingestMedicalUpload } from "@/lib/medical-pipeline";
import { MEDICAL_UPLOAD_BATCH_CAP } from "@/lib/upload-gate";
import {
  classifyUploadOutcome,
  type UploadOutcome,
} from "@/lib/document-upload-api";
import { parseUploadTarget } from "@/lib/acquirer-identity";
import { recordPendingIdentity, resolvePortalIdentity } from "@/lib/portals";
import { checkRateLimit } from "@/lib/rate-limit";
import { createLogger } from "@/lib/log";

// Remote document upload (issue #1735). A sibling of app/share-target/route.ts: an HTTP
// route handler that authenticates, composes the write gate, and hands files to the ONE
// ingest engine. What it adds over share-target is that the caller is a SCRIPT, not a
// browser — so it authenticates with a #1734 bearer token instead of a cookie, names its
// target profile explicitly instead of inheriting a session's active one, and answers
// JSON instead of redirecting.
//
// NO SECOND INGEST PATH. Every file goes to lib/medical-pipeline::ingestMedicalUpload
// and this route adds nothing to it: per-profile storage, content-hash dedup, the
// pre-buffer + per-path size gates (#695), the content sniff, the audit row, the
// failed-document rows and the /data revalidation all come free. The route validates
// only what the engine cannot see — the token, the profile write access, and that the
// multipart body actually carried files — and never re-implements a size or type gate
// of its own, because a second copy would drift from the form's.
//
// AUTH, in the order it must happen:
//
//   1. RATE LIMIT, keyed on the presented token's ID and applied BEFORE any
//      verification. Verifying a token is a scrypt derivation — real CPU and memory by
//      design — so an unauthenticated caller can otherwise make the server work for
//      free. The key is the id half only: it is the public half, so this never puts a
//      secret in a map key, and the parse that extracts it touches no database. The
//      same posture as app/api/integrations/health-connect/ingest.
//   2. AUTHENTICATE: authenticateApiToken() resolves the login and demands the
//      `upload:documents` capability. It stops there — it never authorizes a profile.
//   3. AUTHORIZE, composed explicitly here, because the redirecting guards
//      (requireProfileWriteAccess) are wrong for a route handler: a thrown redirect out
//      of a POST is a method-preserving 307. The same three decisions that guard makes:
//        • demo mode refuses every non-admin write;
//        • the target profile must be REACHABLE by this login (accessForProfile assumes
//          reachability and defaults an ungranted member to 'write', so it must never be
//          consulted alone — accessibility is checked FIRST);
//        • and the login must hold WRITE on it.
//      Reach and access are re-derived from the login's CURRENT grants on every request,
//      so a revoked grant takes effect immediately on every token that login holds.
//
// WHICH PROFILE. Explicit, always — but named in one of TWO ways, and exactly one per
// request (#1739):
//
//   `profile=<id>`                                  the human CLI, which knows its own
//                                                   instance's ids.
//   `portal=<slug>[&account=<slug>]&patient=<label>` an ACQUIRER, which must not know
//                                                   them.
//
// `account` names WHICH LOGIN of the portal, and is optional: a patient label is unique
// per login, not per portal (two parents' proxy lists can both render "SMITH, ALEX"
// meaning two different people), but a single-login household has nothing to say here.
// Omitting it resolves only when the portal has exactly one login; with more than one it
// REFUSES rather than picking, because picking would be a guess about whose records these
// are.
//
// The second form exists because an external tool deciding profile ids would have to keep
// that mapping in local config on every machine it runs on, and a stale local mapping
// filing one person's records under another is the precise harm this surface must not
// cause. So the tool reports the identity the portal showed it, VERBATIM, and allos
// resolves it against the user-managed binding table — then intersects the result with
// this token's write set, so a mapping is never a bypass of profile authorization.
//
// An identity that is not bound refuses with the typed `unmapped-identity` outcome. It
// never defaults: a new proxy patient appearing on a portal must fail visibly and become
// a one-tap binding, not land on whichever profile seemed closest. A share sheet cannot
// choose at all, which is why /share-target alone falls back to the session's active
// profile; a caller that CAN choose must.
//
// ERROR SHAPE (#478). `{ ok: false, error }` with an appropriate status; the 500 message
// stays generic and the real cause goes to the server error log. Nothing here ever logs
// the token: the log lines carry the token ID and login ID only.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = createLogger("api-documents");

// A generous budget for a human-driven uploader (a folder scan pushing a stack of PDFs)
// that still caps a runaway or hostile client hammering this write path.
const UPLOAD_RATE_LIMIT = 60;
const UPLOAD_RATE_WINDOW_MS = 5 * 60 * 1000;

function jsonError(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status });
}

// The highest medical_documents id THIS PROFILE currently holds — the "before" mark that
// lets the outcome classifier tell a freshly stored document from the pre-existing row a
// reprocessing duplicate landed on. Taken per FILE, immediately before its ingest.
//
// Profile-scoped, and correct precisely because it is: dedup is per profile, so the only
// pre-existing row an ingest can land on belongs to this profile and is therefore <= this
// maximum, while a newly inserted row takes a global rowid above every existing id and is
// therefore above it too.
function maxDocumentId(profileId: number): number {
  return (
    db
      .prepare(
        "SELECT COALESCE(MAX(id), 0) AS m FROM medical_documents WHERE profile_id = ?"
      )
      .get(profileId) as { m: number }
  ).m;
}

interface LandedRow {
  status: string;
  storedPath: string | null;
  error: string | null;
}

// Read back the row the engine landed on. Scoped by BOTH id and profile_id, the same
// double-scoping every other medical-document read uses.
function readLanded(docId: number, profileId: number): LandedRow | null {
  const row = db
    .prepare(
      `SELECT extraction_status AS status, stored_path AS storedPath,
              extraction_error AS error
         FROM medical_documents WHERE id = ? AND profile_id = ?`
    )
    .get(docId, profileId) as LandedRow | undefined;
  return row ?? null;
}

export async function POST(req: Request): Promise<Response> {
  // 1. Rate limit, before the scrypt verify.
  const limit = checkRateLimit(
    apiTokenRateLimitKey(req.headers.get("authorization")),
    { limit: UPLOAD_RATE_LIMIT, windowMs: UPLOAD_RATE_WINDOW_MS }
  );
  if (!limit.ok) {
    return Response.json(
      { ok: false, error: "rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } }
    );
  }

  // 2. Authenticate + demand the capability.
  const auth = await authenticateApiToken(req, "upload:documents");
  if (!auth.ok) return jsonError(auth.error, auth.status);
  const { login, tokenId } = auth;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonError("expected a multipart/form-data body", 400);
  }

  // 3. Resolve the destination. Query parameters first (the documented curl shape), then
  //    the matching multipart fields. parseUploadTarget enforces exactly-one-of.
  const params = new URL(req.url).searchParams;
  const target = parseUploadTarget({
    profile: params.get("profile") ?? form.get("profile"),
    portal: params.get("portal") ?? form.get("portal"),
    account: params.get("account") ?? form.get("account"),
    patient: params.get("patient") ?? form.get("patient"),
  });
  if (!target.ok) return jsonError(target.error, 400);

  let profileId: number;
  // The portal this upload was ACQUIRED from, or null for the plain human CLI path
  // (#1748). Set only on the resolved-identity branch: a `profile=<id>` upload is a
  // person putting a file somewhere, and NULL says exactly that.
  let acquiredPortalId: number | null = null;
  if (target.target.kind === "profile") {
    profileId = target.target.profileId;
  } else {
    const resolved = resolvePortalIdentity(
      target.target.portalSlug,
      target.target.accountSlug,
      target.target.patientLabel
    );
    if (!resolved.ok) {
      // REMEMBER what we refused (#1739), so the card can offer the one-tap binding the
      // refusal is supposed to become. Reachable only after authenticateApiToken
      // succeeded, so this is never an anonymous write. It records nothing when the
      // portal or login is itself unresolvable — allos owns those vocabularies.
      recordPendingIdentity(
        target.target.portalSlug,
        target.target.accountSlug,
        target.target.patientLabel,
        "unmapped-upload"
      );
      revalidatePath("/integrations/patient-portals");
      // TYPED refusal, not a generic 400: the tool surfaces `unmapped-identity` as "this
      // patient isn't mapped yet" and the card turns it into a one-tap binding. Answered
      // with 404 because the identity genuinely does not resolve — distinct from the 403
      // a resolved-but-unauthorized identity gets below, so the two are debuggable apart
      // WITHOUT revealing whether some other login has bound this label. Unknown,
      // IGNORED, and ambiguous-account all answer identically: the endpoint is
      // non-oracular about a household's choices.
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
    acquiredPortalId = resolved.portalId;
  }

  // 4. Authorize: demo, then reachability, then write. A member who cannot reach the
  //    profile and a member who can but holds only read both get the same 403 — the
  //    endpoint is not a probe for which profiles exist. A RESOLVED identity goes through
  //    exactly this gate too: the binding says where the records belong, never that this
  //    token may put them there.
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

  // The upload form and the share target both read files this way; a client may send
  // several `file` parts in one request.
  const files = form
    .getAll("file")
    .filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) {
    return jsonError("no file was uploaded", 400);
  }

  // Sequential + the same soft batch cap as the form and the share target: one file
  // body buffered at a time, and a huge batch can't swamp the extraction queue. The
  // overflow is reported rather than silently dropped.
  const toIngest = files.slice(0, MEDICAL_UPLOAD_BATCH_CAP);
  const skipped = files.length - toIngest.length;

  const documents: {
    id: number;
    name: string;
    outcome: UploadOutcome;
    reason: string | null;
  }[] = [];
  try {
    for (const file of toIngest) {
      const maxIdBefore = maxDocumentId(profileId);
      const docId = await ingestMedicalUpload(login.id, profileId, file, {
        acquiredPortalId,
      });
      const landed = readLanded(docId, profileId);
      // The engine lands a row on every path, so a missing one means the row was
      // deleted underneath us mid-request. Report the id we were given rather than
      // inventing an outcome for a row we can no longer see.
      const classified = landed
        ? classifyUploadOutcome({ docId, maxIdBefore, ...landed })
        : { outcome: "stored" as const, reason: null };
      documents.push({
        id: docId,
        name: file.name,
        outcome: classified.outcome,
        reason: classified.reason,
      });
    }
  } catch (err) {
    // Identifiers only — never the token, never the file contents.
    log.error("remote document ingest failed", {
      token: tokenId,
      login: login.id,
      profile: profileId,
      err: err instanceof Error ? err : String(err),
    });
    return jsonError("internal error", 500);
  }
  revalidatePath("/data");

  return Response.json({
    ok: true,
    profile: profileId,
    documents,
    ...(skipped > 0
      ? {
          skipped,
          note: `only the first ${MEDICAL_UPLOAD_BATCH_CAP} files were ingested; send the rest in another request`,
        }
      : {}),
  });
}
