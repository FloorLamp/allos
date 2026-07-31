import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { getCurrentSession, canAccessProfile } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import { SYMPTOM_PHOTO_DIR } from "@/lib/symptom-photo-write";

// Serve a stored symptom photo (issue #859 item 4). Session-gated (the Edge middleware
// only checks cookie presence) and scoped by `id AND an ACCESSIBLE profile`.
// Path-contained to SYMPTOM_PHOTO_DIR, image-only, nosniff. NOT a public/share
// surface: photos are excluded from shares by default (the PHI posture).
//
// ACCESS (#1696): the photo's OWNING profile is RESOLVED from the row and the session is
// then gated against THAT profile (canAccessProfile). SymptomPhotoStrip renders on the
// SAME episode page as the video strip, which resolves the episode across the viewer's
// ACCESSIBLE profiles (#879) — so active-profile scoping 404'd every thumbnail on a
// household member's episode for exactly the same reason. A profile the session has no
// grant on is refused identically to a nonexistent id.

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

  // Resolve the OWNER, then gate on it — filtering by profile_id here would presuppose
  // the answer, and the access check is the protection.
  const row = db
    .prepare(
      "SELECT profile_id, stored_path, mime_type FROM symptom_photos WHERE id = ?"
    )
    .get(id) as
    | { profile_id: number; stored_path: string; mime_type: string | null }
    | undefined;
  if (!row || !row.stored_path || !canAccessProfile(session, row.profile_id))
    return new Response("Not found", { status: 404 });

  const abs = path.resolve(process.cwd(), row.stored_path);
  if (abs !== UPLOAD_ROOT && !abs.startsWith(UPLOAD_ROOT + path.sep)) {
    return new Response("Not found", { status: 404 });
  }
  if (!fs.existsSync(abs)) return new Response("File missing", { status: 410 });

  // `active_profile_id` keeps its meaning (the acting profile); the SUBJECT rides in
  // `detail` as a bare identifier, so a cross-profile read still names whose photo it was.
  recordAudit({
    loginId: session.login.id,
    profileId: session.profile.id,
    action: AUDIT_ACTIONS.medicalFileView,
    target: `symptom-photo:${id}`,
    detail: `profile:${row.profile_id}`,
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
