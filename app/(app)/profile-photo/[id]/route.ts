import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { getCurrentSession, canAccessProfile } from "@/lib/auth";
import { PHOTO_ROOT, mimeForPhotoPath } from "@/lib/profile-photo";

// Serves a profile's avatar. Access mirrors the switcher: admins may fetch any
// profile's photo, members only the profiles they're granted. The URL carries a
// ?v= version so a replaced photo defeats the short private cache.
export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  // Cookie-authoritative gate (the Edge middleware only checks cookie presence).
  const session = getCurrentSession();
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const id = Number(params.id);
  if (!id) return new Response("Not found", { status: 404 });

  // Access check first, so a member can't even probe another profile's photo.
  if (!canAccessProfile(session, id)) {
    return new Response("Forbidden", { status: 403 });
  }

  const row = db
    .prepare("SELECT photo_path FROM profiles WHERE id = ?")
    .get(id) as { photo_path: string | null } | undefined;
  if (!row || !row.photo_path) {
    return new Response("Not found", { status: 404 });
  }

  // Resolve and confine the path to the photos directory before touching disk, so
  // a tampered photo_path can't escape it via `..` or an absolute path.
  const abs = path.resolve(process.cwd(), row.photo_path);
  if (abs !== PHOTO_ROOT && !abs.startsWith(PHOTO_ROOT + path.sep)) {
    return new Response("Not found", { status: 404 });
  }
  if (!fs.existsSync(abs)) {
    return new Response("File missing", { status: 410 });
  }

  const data = fs.readFileSync(abs);
  return new Response(data, {
    headers: {
      "Content-Type": mimeForPhotoPath(row.photo_path),
      "Content-Length": String(data.length),
      // Photos change rarely, but access is authorized per-session — keep the
      // cache private and short so it never leaks across users or lingers after
      // a swap (the ?v= version already busts it immediately on change).
      "Cache-Control": "private, max-age=60",
      // Don't let the browser MIME-sniff a served file into an executable type.
      "X-Content-Type-Options": "nosniff",
    },
  });
}
