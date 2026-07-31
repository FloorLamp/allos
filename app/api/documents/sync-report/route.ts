import { revalidatePath } from "next/cache";
import { accessForProfile, accessibleProfilesForLogin } from "@/lib/auth";
import { isDemoMode, isDemoRestricted } from "@/lib/demo";
import { authenticateApiToken } from "@/lib/api-tokens";
import { apiTokenRateLimitKey } from "@/lib/api-token-format";
import {
  isSyncReportStatus,
  parseSyncReportCounts,
  parseUploadTarget,
  syncReportEvent,
} from "@/lib/acquirer-identity";
import { resolvePortalIdentity } from "@/lib/portals";
import { recordSync, recordSyncEvent } from "@/lib/integrations/connections";
import { checkRateLimit } from "@/lib/rate-limit";
import { createLogger } from "@/lib/log";

// Acquirer sync report (issue #1739, the second #1735 extension).
//
// WHY THIS ENDPOINT EXISTS AT ALL. A "checked the portal, nothing new" run pushes ZERO
// documents — and it is the COMMON case. Without an explicit report the server sees no
// trace of it whatsoever, so the integrations card cannot tell *checked and unchanged*
// from *failed* or from *never ran*, and a perfectly healthy quiet week reads as broken.
// The integrations accounting rule already demands the other half of this: every sync is
// recorded with inserted/updated/unchanged counts, and Data → Review's failure badge keys
// off sync events. So the acquirer's run ends here, and the run lands as an ORDINARY sync
// event for the `mychart` provider — the same row type every other provider writes, read
// by the same surfaces, with no parallel reporting store to keep consistent.
//
// AUTH is identical to the upload route, in the same order and for the same reasons:
// rate-limit on the token's public id half BEFORE the scrypt verify; authenticate and
// demand `upload:documents` (a run report is part of the upload capability, not a new
// one); then compose the write gate explicitly — demo refusal, reachability, then write.
// A sync event is profile-owned data, so reporting one is a write and is gated like one.
//
// The destination is named exactly as an upload names it, through the same
// exactly-one-of parser: an acquirer reports `(portal, patient)` and allos resolves it,
// while a human debugging with curl may name a `profile`. A resolved identity is
// intersected with the token's write set here too — the binding says where a run belongs,
// never that this token may write there.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = createLogger("api-sync-report");

// A run report is one small JSON POST at the end of a run, so this is generous while
// still capping a client that reports in a loop.
const REPORT_RATE_LIMIT = 120;
const REPORT_RATE_WINDOW_MS = 5 * 60 * 1000;

// The provider these events land under — the registry id, so the card, the staleness
// reader and Data → Review all find them without a special case.
const PROVIDER = "mychart";

function jsonError(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status });
}

export async function POST(req: Request): Promise<Response> {
  const limit = checkRateLimit(
    `sync-report:${apiTokenRateLimitKey(req.headers.get("authorization"))}`,
    { limit: REPORT_RATE_LIMIT, windowMs: REPORT_RATE_WINDOW_MS }
  );
  if (!limit.ok) {
    return Response.json(
      { ok: false, error: "rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } }
    );
  }

  const auth = await authenticateApiToken(req, "upload:documents");
  if (!auth.ok) return jsonError(auth.error, auth.status);
  const { login, tokenId } = auth;

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return jsonError("expected a JSON object body", 400);
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return jsonError("expected a JSON object body", 400);
  }

  const status = typeof body.status === "string" ? body.status : "";
  if (!isSyncReportStatus(status)) {
    return jsonError(
      "`status` must be one of: downloaded, nothing-new, failed",
      400
    );
  }

  const target = parseUploadTarget({
    profile: body.profile,
    portal: body.portal,
    patient: body.patient,
  });
  if (!target.ok) return jsonError(target.error, 400);

  let profileId: number;
  if (target.target.kind === "profile") {
    profileId = target.target.profileId;
  } else {
    const resolved = resolvePortalIdentity(
      target.target.portalSlug,
      target.target.patientLabel
    );
    if (!resolved.ok) {
      return Response.json(
        {
          ok: false,
          error: "unmapped-identity",
          detail:
            "That portal patient is not mapped to a profile yet. Map it under Integrations → MyChart.",
        },
        { status: 404 }
      );
    }
    profileId = resolved.profileId;
  }

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

  const counts = parseSyncReportCounts({
    inserted: body.inserted,
    updated: body.updated,
    unchanged: body.unchanged,
    failed: body.failed,
  });
  const message =
    typeof body.message === "string" && body.message.trim()
      ? body.message.trim().slice(0, 500)
      : null;
  const ev = syncReportEvent(status, counts, message);

  try {
    // The append-only event history: this is what Data → Review reads and what the
    // failure badge keys off. recordSyncEvent is best-effort by contract (it never throws
    // into its caller), so a reporting hiccup can't fail an otherwise-good run.
    recordSyncEvent(profileId, PROVIDER, {
      ok: ev.ok,
      received: ev.received,
      written: ev.inserted + ev.updated,
      inserted: ev.inserted,
      updated: ev.updated,
      unchanged: ev.unchanged,
      skipped: ev.skipped,
      error: ev.error,
    });
    // "Last synced" on the card. Only a SUCCESSFUL run advances it — including a
    // nothing-new one, which is the whole point: a quiet check is still a check, and the
    // connection is demonstrably alive. A failed run deliberately leaves the previous
    // timestamp standing so the card shows how long it has actually been since the
    // portal was last read.
    if (ev.ok) {
      recordSync(profileId, PROVIDER, {
        inserted: ev.inserted,
        updated: ev.updated,
        unchanged: ev.unchanged,
      });
    }
  } catch (err) {
    // Identifiers only — never the token, never a portal address (there isn't one).
    log.error("sync report failed to record", {
      token: tokenId,
      login: login.id,
      profile: profileId,
      err: err instanceof Error ? err : String(err),
    });
    return jsonError("internal error", 500);
  }

  revalidatePath("/data");
  return Response.json({ ok: true, profile: profileId, status });
}
