import path from "node:path";

// Shared constants + helpers for profile avatars, used by both the upload/remove
// Server Actions and the serve route so the accepted types, size cap, storage
// location, and mime↔ext mapping never drift between them.

// The only directory profile photos are ever stored under. A served path must
// resolve to inside this directory (path-traversal guard, mirrored from the
// medical file route).
export const PHOTO_ROOT = path.resolve(
  process.cwd(),
  "data",
  "uploads",
  "profile-photos"
);

// 5 MB — avatars are small; anything larger is almost certainly a mistake. Named
// distinctly from the photo-capture domains' MAX_PHOTO_BYTES (lib/photo/policy.ts,
// 15 MB) so the two differently-scoped caps can never be confused (#1284).
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

// Accepted upload types → the on-disk extension we name the file with. The
// extension is derived from the (validated) mime, never from the client-supplied
// filename, so a mislabelled ".php.png" can't leak an arbitrary extension.
export const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

// The Content-Type the serve route returns for a stored file, keyed by its
// extension. Only the three accepted image types appear here.
const EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

// Resolve the served mime type from a stored file path's extension. Falls back to
// a generic octet-stream (with nosniff set at the route, this can't execute).
export function mimeForPhotoPath(storedPath: string): string {
  const ext = storedPath.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TO_MIME[ext] ?? "application/octet-stream";
}
