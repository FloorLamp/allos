import path from "node:path";
import { db } from "@/lib/db";
import { getCurrentSession, canAccessProfile } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import { videoDomainRoot } from "@/lib/video/store";
import { serveRangedFile, videoJsonError } from "@/lib/video/serve";

// Serve a stored SYMPTOM / episode video clip (#1224 phase 1). Session-gated (the
// Edge middleware only checks cookie presence) and scoped by `id AND an ACCESSIBLE
// profile`. Path-contained to the symptom-video root, nosniff, HTTP Range for
// scrubbing (serveRangedFile). NOT a public/share surface — by the #1224 strictest
// privacy tier, no share/export path ever links here. `?poster=1` serves the
// ingest-generated poster frame (the grid reads posters; the <video> loads the clip
// only on open).
//
// ACCESS (#1696): the clip's OWNING profile is RESOLVED from the row and the session
// is then gated against THAT profile (canAccessProfile — the grants set, the same rule
// the switcher and the profile-photo serve route use). This matches the episode page
// that renders the strip, which resolves the episode across the viewer's ACCESSIBLE
// profiles (#879): scoping the bytes by the ACTIVE profile instead made every clip on a
// household member's episode 404 for the caregiver reading it. The grants boundary is
// untouched — an ungranted profile's clip is still refused, and refused IDENTICALLY to a
// nonexistent one (the same "not found" 404 body), so this never becomes an oracle for
// whether some other family's row id exists.
//
// New-route error convention (#478): JSON `{ ok: false, error }`, generic on 500.

const UPLOAD_ROOT = path.resolve(videoDomainRoot("symptom"));

export async function GET(
  req: Request,
  props: { params: Promise<{ id: string }> }
) {
  const params = await props.params;
  const session = await getCurrentSession();
  if (!session) return videoJsonError("unauthorized", 401);

  const id = Number(params.id);
  if (!id) return videoJsonError("not found", 404);

  // Resolve the OWNER, then gate on it. Filtering by profile_id here would presuppose
  // the answer; the access check below is the protection, and it runs before anything
  // about the row (its existence included) can be observed.
  const row = db
    .prepare(
      `SELECT profile_id, stored_path, poster_path, mime_type FROM symptom_videos
        WHERE id = ?`
    )
    .get(id) as
    | {
        profile_id: number;
        stored_path: string;
        poster_path: string | null;
        mime_type: string | null;
      }
    | undefined;
  if (!row || !row.stored_path || !canAccessProfile(session, row.profile_id)) {
    return videoJsonError("not found", 404);
  }

  const wantPoster = new URL(req.url).searchParams.get("poster") === "1";
  if (wantPoster && !row.poster_path) return videoJsonError("no poster", 404);
  const rel = wantPoster ? row.poster_path! : row.stored_path;
  const abs = path.resolve(process.cwd(), rel);
  if (abs !== UPLOAD_ROOT && !abs.startsWith(UPLOAD_ROOT + path.sep)) {
    return videoJsonError("not found", 404);
  }

  // `active_profile_id` keeps its meaning (the profile the login was ACTING as); the
  // SUBJECT — which on a caregiver's cross-profile read is a different profile — rides
  // in `detail` as a bare identifier, so the trail still answers "whose bytes".
  recordAudit({
    loginId: session.login.id,
    profileId: session.profile.id,
    action: AUDIT_ACTIONS.medicalFileView,
    target: `symptom-video:${id}${wantPoster ? ":poster" : ""}`,
    detail: `profile:${row.profile_id}`,
  });

  const contentType = wantPoster
    ? "image/jpeg"
    : row.mime_type || "application/octet-stream";
  return serveRangedFile(req, abs, contentType, `symptom-video-${id}`);
}
