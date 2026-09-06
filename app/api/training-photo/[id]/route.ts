import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { canAccessProfile, getCurrentSession } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import { photoDomainRoot } from "@/lib/photo/store";

// Serve a stored training photo (#3285 item 3). Session-gated (the Edge middleware
// only checks cookie presence), path-contained to the training-photo root, image-only,
// nosniff. `?thumb=1` serves the ingest-generated thumbnail (the grid reads thumbs;
// the lightbox reads the original). NOT a public/share surface — no share, printable
// or export path links here.
//
// ACCESS (#1696): the photo's OWNING profile is RESOLVED from the row and the session
// is then gated against THAT profile (canAccessProfile) — the activity-video posture,
// not the progress/lesion one. TrainingPhotoStrip mounts on the SAME activity page as
// ActivityMediaStrip and takes the same `subjectProfileId`, so on a household member's
// page the tiles name photos owned by the SUBJECT while the acting profile is someone
// else. Scoping the query by the acting profile 404'd every thumbnail there — the
// exact failure #1696 fixed for symptom photos — while the cross-profile WRITE on the
// same page landed. A profile the session has no grant on is refused identically to a
// nonexistent id.
//
// New-route error convention (#478): JSON `{ ok: false, error }`, generic on 500.

const UPLOAD_ROOT = path.resolve(photoDomainRoot("training"));

function jsonError(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status });
}

export async function GET(
  req: Request,
  props: { params: Promise<{ id: string }> }
) {
  const params = await props.params;
  const session = await getCurrentSession();
  if (!session) return jsonError("unauthorized", 401);

  const id = Number(params.id);
  if (!id) return jsonError("not found", 404);

  // Resolve the OWNER, then gate on it — filtering by profile_id here would
  // presuppose the answer, and the access check is the protection.
  const row = db
    .prepare(
      `SELECT profile_id, stored_path, thumb_path, mime_type FROM training_photos
        WHERE id = ?`
    )
    .get(id) as
    | {
        profile_id: number;
        stored_path: string;
        thumb_path: string | null;
        mime_type: string | null;
      }
    | undefined;
  if (!row || !row.stored_path || !canAccessProfile(session, row.profile_id))
    return jsonError("not found", 404);

  const wantThumb = new URL(req.url).searchParams.get("thumb") === "1";
  const rel = wantThumb ? (row.thumb_path ?? row.stored_path) : row.stored_path;
  const abs = path.resolve(process.cwd(), rel);
  if (abs !== UPLOAD_ROOT && !abs.startsWith(UPLOAD_ROOT + path.sep)) {
    return jsonError("not found", 404);
  }
  if (!fs.existsSync(abs)) return jsonError("file missing", 410);

  // `active_profile_id` keeps its meaning (the acting profile); the SUBJECT rides in
  // `detail`, so a cross-profile read still names whose photo it was.
  recordAudit({
    loginId: session.login.id,
    profileId: session.profile.id,
    action: AUDIT_ACTIONS.medicalFileView,
    target: `training-photo:${id}${wantThumb ? ":thumb" : ""}`,
    detail: `profile:${row.profile_id}`,
  });

  const data = fs.readFileSync(abs);
  return new Response(data, {
    headers: {
      // The pipeline only ever stores re-encoded JPEG; the row's mime is
      // server-derived at ingest.
      "Content-Type": row.mime_type || "image/jpeg",
      "Content-Disposition": `inline; filename="training-photo-${id}"`,
      "Content-Length": String(data.length),
      "X-Content-Type-Options": "nosniff",
    },
  });
}
