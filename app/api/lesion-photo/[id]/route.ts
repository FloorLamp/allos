import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { getCurrentSession } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import { LESION_PHOTO_DIR } from "@/lib/skin-photo-write";
import { thumbSiblingPath } from "@/lib/photo/store";

// Serve a stored lesion photo (issue #715). Session-gated (the Edge middleware only
// checks cookie presence) and scoped by `id AND profile_id`, so one profile can't fetch
// another's photos by id. Path-contained to LESION_PHOTO_DIR, image-only, nosniff — the
// same posture as the medical + symptom-photo file-serve routes. NOT a public/share
// surface.
//
// `?thumb=1` serves the ingest-generated thumbnail (#1844 phase 3): the grid reads
// thumbs, the lightbox reads the original. `lesion_photos` predates the photo core and
// carries no thumb_path column, so the thumbnail is the DERIVED sibling of the stored
// file (thumbSiblingPath — one rule, shared with the writer). A photo stored before
// phase 3 that the metadata backfill has not reached yet has no sibling on disk; it
// falls back to the full image rather than 404ing.

const UPLOAD_ROOT = path.resolve(LESION_PHOTO_DIR);

const INLINE_OK = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/heic",
]);

export async function GET(
  req: Request,
  props: { params: Promise<{ id: string }> }
) {
  const params = await props.params;
  const session = await getCurrentSession();
  if (!session) return new Response("Unauthorized", { status: 401 });

  const id = Number(params.id);
  if (!id) return new Response("Not found", { status: 404 });

  const row = db
    .prepare(
      "SELECT stored_path, mime_type FROM lesion_photos WHERE id = ? AND profile_id = ?"
    )
    .get(id, session.profile.id) as
    { stored_path: string; mime_type: string | null } | undefined;
  if (!row || !row.stored_path)
    return new Response("Not found", { status: 404 });

  const wantThumb = new URL(req.url).searchParams.get("thumb") === "1";
  const abs = path.resolve(process.cwd(), row.stored_path);
  if (abs !== UPLOAD_ROOT && !abs.startsWith(UPLOAD_ROOT + path.sep)) {
    return new Response("Not found", { status: 404 });
  }
  if (!fs.existsSync(abs)) return new Response("File missing", { status: 410 });
  // The thumbnail is contained by construction (a sibling of an already-contained
  // path) and is always the core's re-encoded JPEG, whatever the row's mime says.
  const thumbAbs = wantThumb
    ? path.resolve(process.cwd(), thumbSiblingPath(row.stored_path))
    : null;
  const serveThumb = thumbAbs != null && fs.existsSync(thumbAbs);

  recordAudit({
    loginId: session.login.id,
    profileId: session.profile.id,
    action: AUDIT_ACTIONS.medicalFileView,
    target: `lesion-photo:${id}${serveThumb ? ":thumb" : ""}`,
  });

  const mime = serveThumb
    ? "image/jpeg"
    : row.mime_type || "application/octet-stream";
  const disposition = INLINE_OK.has(mime) ? "inline" : "attachment";
  const data = fs.readFileSync(serveThumb ? thumbAbs : abs);
  return new Response(data, {
    headers: {
      "Content-Type": mime,
      "Content-Disposition": `${disposition}; filename="lesion-photo-${id}"`,
      "Content-Length": String(data.length),
      "X-Content-Type-Options": "nosniff",
    },
  });
}
