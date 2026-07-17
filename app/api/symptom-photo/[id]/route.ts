import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { getCurrentSession } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import { SYMPTOM_PHOTO_DIR } from "@/lib/symptom-photo-write";

// Serve a stored symptom photo (issue #859 item 4). Session-gated (the Edge middleware
// only checks cookie presence) and scoped by `id AND profile_id`, so one profile can't
// fetch another's photos by id. Path-contained to SYMPTOM_PHOTO_DIR, image-only,
// nosniff — the same posture as the medical file-serve route. NOT a public/share
// surface: photos are excluded from shares by default (the PHI posture).

const UPLOAD_ROOT = path.resolve(SYMPTOM_PHOTO_DIR);

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
      "SELECT stored_path, mime_type FROM symptom_photos WHERE id = ? AND profile_id = ?"
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
    target: `symptom-photo:${id}`,
  });

  const mime = row.mime_type || "application/octet-stream";
  const disposition = INLINE_OK.has(mime) ? "inline" : "attachment";
  const data = fs.readFileSync(abs);
  return new Response(data, {
    headers: {
      "Content-Type": mime,
      "Content-Disposition": `${disposition}; filename="symptom-photo-${id}"`,
      "Content-Length": String(data.length),
      "X-Content-Type-Options": "nosniff",
    },
  });
}
