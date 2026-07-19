import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { getCurrentSession } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import { LESION_PHOTO_DIR } from "@/lib/skin-photo-write";

// Serve a stored lesion photo (issue #715). Session-gated (the Edge middleware only
// checks cookie presence) and scoped by `id AND profile_id`, so one profile can't fetch
// another's photos by id. Path-contained to LESION_PHOTO_DIR, image-only, nosniff — the
// same posture as the medical + symptom-photo file-serve routes. NOT a public/share
// surface.

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
  _req: Request,
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

  const abs = path.resolve(process.cwd(), row.stored_path);
  if (abs !== UPLOAD_ROOT && !abs.startsWith(UPLOAD_ROOT + path.sep)) {
    return new Response("Not found", { status: 404 });
  }
  if (!fs.existsSync(abs)) return new Response("File missing", { status: 410 });

  recordAudit({
    loginId: session.login.id,
    profileId: session.profile.id,
    action: AUDIT_ACTIONS.medicalFileView,
    target: `lesion-photo:${id}`,
  });

  const mime = row.mime_type || "application/octet-stream";
  const disposition = INLINE_OK.has(mime) ? "inline" : "attachment";
  const data = fs.readFileSync(abs);
  return new Response(data, {
    headers: {
      "Content-Type": mime,
      "Content-Disposition": `${disposition}; filename="lesion-photo-${id}"`,
      "Content-Length": String(data.length),
      "X-Content-Type-Options": "nosniff",
    },
  });
}
