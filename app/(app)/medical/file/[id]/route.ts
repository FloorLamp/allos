import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { getCurrentSession } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import type { MedicalDocument } from "@/lib/types";

// The only directory uploaded medical files are ever stored under. A served path
// must resolve to inside this directory (path-traversal guard).
const UPLOAD_ROOT = path.resolve(process.cwd(), "data", "uploads", "medical");

// MIME types that are safe to render inline (they can't execute script in our
// origin). Everything else — notably text/html and image/svg+xml — is forced to
// download so a stored HTML/SVG file can't run in-origin.
const INLINE_OK = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
]);

// Streams an uploaded medical document back to the browser so the user can
// open/download the original file from the documents list.
export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  // Serves raw lab PDFs/scans by id — cookie-authoritative gate (the Edge
  // middleware only checks cookie presence).
  const session = getCurrentSession();
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const id = Number(params.id);
  if (!id) return new Response("Not found", { status: 404 });

  // Scope to the active profile so one profile can't fetch another's files by id.
  const doc = db
    .prepare("SELECT * FROM medical_documents WHERE id = ? AND profile_id = ?")
    .get(id, session.profile.id) as MedicalDocument | undefined;
  if (!doc || !doc.stored_path) {
    return new Response("Not found", { status: 404 });
  }

  // Resolve and confine the path to the upload directory before touching disk, so
  // a tampered stored_path can't escape it via `..` or an absolute path.
  const abs = path.resolve(process.cwd(), doc.stored_path);
  if (abs !== UPLOAD_ROOT && !abs.startsWith(UPLOAD_ROOT + path.sep)) {
    return new Response("Not found", { status: 404 });
  }
  if (!fs.existsSync(abs)) {
    return new Response("File missing", { status: 410 });
  }

  // Audit the PHI access (the file id only — never its contents).
  recordAudit({
    loginId: session.login.id,
    profileId: session.profile.id,
    action: AUDIT_ACTIONS.medicalFileView,
    target: String(id),
  });

  const mime = doc.mime_type || "application/octet-stream";
  const disposition = INLINE_OK.has(mime) ? "inline" : "attachment";
  const data = fs.readFileSync(abs);
  return new Response(data, {
    headers: {
      "Content-Type": mime,
      "Content-Disposition": `${disposition}; filename="${encodeURIComponent(doc.filename)}"`,
      "Content-Length": String(data.length),
      // Don't let the browser MIME-sniff a served file into an executable type.
      "X-Content-Type-Options": "nosniff",
    },
  });
}
