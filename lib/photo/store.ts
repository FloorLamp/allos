// File store for the shared photo core (#1119): per-profile dirs under
// data/uploads/<domain-dir>/<profileId>/, path-contained unlink — the
// medical-uploads / lesion-photos posture, generalized. The domain write core
// (e.g. lib/progress-photo-write.ts) calls storeProcessedPhoto inside its
// writeTx and records the returned repo-relative paths on the row; every later
// unlink (single delete, profile delete) re-contains the stored path before
// touching disk, so a corrupt/hostile stored_path can never rm outside the
// domain's root.
//
// Phase 3 (#1119) migrates the lesion/symptom photo domains onto this store by
// adding their keys here; until then "progress" is the only core-managed domain.

import fs from "node:fs";
import path from "node:path";
import type { ProcessedPhoto } from "./ingest";

export type PhotoDomain = "progress";

const DOMAIN_DIRS: Record<PhotoDomain, string> = {
  progress: "progress-photos",
};

// Absolute root a domain's photos live under. Exported for the serve route's and
// deleteProfile's containment checks.
export function photoDomainRoot(domain: PhotoDomain): string {
  return path.join(process.cwd(), "data", "uploads", DOMAIN_DIRS[domain]);
}

export interface StoredPhotoPaths {
  storedPath: string; // repo-relative, e.g. data/uploads/progress-photos/3/ab12….jpg
  thumbPath: string;
}

// Write the processed photo + its thumbnail under the domain's per-profile dir,
// named by content hash (a re-store of identical content overwrites in place —
// idempotent). Returns repo-relative paths for the DB row.
export function storeProcessedPhoto(
  domain: PhotoDomain,
  profileId: number,
  photo: ProcessedPhoto
): StoredPhotoPaths {
  const dir = path.join(photoDomainRoot(domain), String(profileId));
  fs.mkdirSync(dir, { recursive: true });
  const base = photo.contentHash.slice(0, 16);
  const fileName = `${base}.jpg`;
  const thumbName = `${base}.thumb.jpg`;
  fs.writeFileSync(path.join(dir, fileName), photo.bytes);
  fs.writeFileSync(path.join(dir, thumbName), photo.thumbBytes);
  const rel = (name: string) =>
    path.join("data", "uploads", DOMAIN_DIRS[domain], String(profileId), name);
  return { storedPath: rel(fileName), thumbPath: rel(thumbName) };
}

// Best-effort, path-contained unlink of stored photo files. A path resolving
// outside the domain root is skipped, never followed; a missing/locked file
// never throws (the DB row delete must not fail on fs state).
export function unlinkPhotoFiles(
  domain: PhotoDomain,
  relPaths: readonly (string | null | undefined)[]
): void {
  const root = path.resolve(photoDomainRoot(domain));
  for (const rel of relPaths) {
    if (!rel) continue;
    const abs = path.resolve(process.cwd(), rel);
    if (abs === root || !abs.startsWith(root + path.sep)) continue;
    try {
      fs.rmSync(abs, { force: true });
    } catch {
      // best-effort — the row is authoritative
    }
  }
}
