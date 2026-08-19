import path from "node:path";
import { db } from "@/lib/db";
import { canAccessProfile, getCurrentSession } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import { videoDomainRoot } from "@/lib/video/store";
import { serveRangedFile, videoJsonError } from "@/lib/video/serve";

// Serve stored TRAINING activity media (#1224 phase 1). Session-gated and
// scoped to the clip owner's accessible profile, path-contained to the
// activity-video root, nosniff, HTTP Range for scrubbing — the symptom-video
// serve posture, sharing the one serveRangedFile helper so the range/streaming
// behavior is written once.
// `?poster=1` serves the ingest-generated poster frame.
//
// New-route error convention (#478): JSON `{ ok: false, error }`, generic on 500.

const UPLOAD_ROOT = path.resolve(videoDomainRoot("activity"));

export async function GET(
  req: Request,
  props: { params: Promise<{ id: string }> }
) {
  const params = await props.params;
  const session = await getCurrentSession();
  if (!session) return videoJsonError("unauthorized", 401);

  const id = Number(params.id);
  if (!id) return videoJsonError("not found", 404);

  const row = db
    .prepare(
      `SELECT profile_id, stored_path, poster_path, mime_type FROM activity_videos
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

  recordAudit({
    loginId: session.login.id,
    profileId: session.profile.id,
    action: AUDIT_ACTIONS.medicalFileView,
    target: `activity-video:${id}${wantPoster ? ":poster" : ""}`,
    detail: `profile:${row.profile_id}`,
  });

  const contentType = wantPoster
    ? "image/jpeg"
    : row.mime_type || "application/octet-stream";
  return serveRangedFile(req, abs, contentType, `activity-video-${id}`);
}
