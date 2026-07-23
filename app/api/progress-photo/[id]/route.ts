import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { getCurrentSession } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import { photoDomainRoot } from "@/lib/photo/store";

// Serve a stored progress photo (#1119 phase 2). Session-gated (the Edge
// middleware only checks cookie presence) and scoped by `id AND profile_id`, so
// one profile can never fetch another's body photos by id. Path-contained to the
// progress-photo root, image-only, nosniff — the lesion/symptom-photo serve
// posture. `?thumb=1` serves the ingest-generated thumbnail (the grid reads
// thumbs; the lightbox reads the original). NOT a public/share surface — and by
// the #1119 privacy tier, no share/export path ever links here.
//
// New-route error convention (#478): JSON `{ ok: false, error }`, generic on 500.

const UPLOAD_ROOT = path.resolve(photoDomainRoot("progress"));

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

  const row = db
    .prepare(
      `SELECT stored_path, thumb_path, mime_type FROM progress_photos
        WHERE id = ? AND profile_id = ?`
    )
    .get(id, session.profile.id) as
    | {
        stored_path: string;
        thumb_path: string | null;
        mime_type: string | null;
      }
    | undefined;
  if (!row || !row.stored_path) return jsonError("not found", 404);

  const wantThumb = new URL(req.url).searchParams.get("thumb") === "1";
  const rel = wantThumb ? (row.thumb_path ?? row.stored_path) : row.stored_path;
  const abs = path.resolve(process.cwd(), rel);
  if (abs !== UPLOAD_ROOT && !abs.startsWith(UPLOAD_ROOT + path.sep)) {
    return jsonError("not found", 404);
  }
  if (!fs.existsSync(abs)) return jsonError("file missing", 410);

  recordAudit({
    loginId: session.login.id,
    profileId: session.profile.id,
    action: AUDIT_ACTIONS.medicalFileView,
    target: `progress-photo:${id}${wantThumb ? ":thumb" : ""}`,
  });

  const data = fs.readFileSync(abs);
  return new Response(data, {
    headers: {
      // The pipeline only ever stores re-encoded JPEG; the row's mime is
      // server-derived at ingest.
      "Content-Type": row.mime_type || "image/jpeg",
      "Content-Disposition": `inline; filename="progress-photo-${id}"`,
      "Content-Length": String(data.length),
      "X-Content-Type-Options": "nosniff",
    },
  });
}
