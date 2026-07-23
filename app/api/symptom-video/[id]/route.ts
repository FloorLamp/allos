import path from "node:path";
import { db } from "@/lib/db";
import { getCurrentSession } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import { videoDomainRoot } from "@/lib/video/store";
import { serveRangedFile, videoJsonError } from "@/lib/video/serve";

// Serve a stored SYMPTOM / episode video clip (#1224 phase 1). Session-gated (the
// Edge middleware only checks cookie presence) and scoped by `id AND profile_id`,
// so one profile can never fetch another's clips by id. Path-contained to the
// symptom-video root, nosniff, HTTP Range for scrubbing (serveRangedFile). NOT a
// public/share surface — by the #1224 strictest privacy tier, no share/export path
// ever links here. `?poster=1` serves the ingest-generated poster frame (the grid
// reads posters; the <video> loads the clip only on open).
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

  const row = db
    .prepare(
      `SELECT stored_path, poster_path, mime_type FROM symptom_videos
        WHERE id = ? AND profile_id = ?`
    )
    .get(id, session.profile.id) as
    | {
        stored_path: string;
        poster_path: string | null;
        mime_type: string | null;
      }
    | undefined;
  if (!row || !row.stored_path) return videoJsonError("not found", 404);

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
    target: `symptom-video:${id}${wantPoster ? ":poster" : ""}`,
  });

  const contentType = wantPoster
    ? "image/jpeg"
    : row.mime_type || "application/octet-stream";
  return serveRangedFile(req, abs, contentType, `symptom-video-${id}`);
}
