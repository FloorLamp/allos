// File store for the shared photo core (#1119): per-profile dirs under
// data/uploads/<domain-dir>/<profileId>/, path-contained unlink — the
// medical-uploads / lesion-photos posture, generalized. The domain write core
// (e.g. lib/progress-photo-write.ts) calls storeProcessedPhoto inside its
// writeTx and records the returned repo-relative paths on the row; every later
// unlink (single delete, profile delete) re-contains the stored path before
// touching disk, so a corrupt/hostile stored_path can never rm outside the
// domain's root.
//
// Phase 3 (#1844) migrated the lesion + symptom photo domains onto this store.
// Their dir names are the ones those domains already used, so the migration moves
// no files: only the NAMING inside them becomes content-addressed.

import fs from "node:fs";
import path from "node:path";
import type { ProcessedPhoto } from "./ingest";

export type PhotoDomain = "progress" | "lesion" | "symptom";

const DOMAIN_DIRS: Record<PhotoDomain, string> = {
  progress: "progress-photos",
  // Unchanged from the pre-core layout (data/uploads/lesion-photos/<profileId>/,
  // data/uploads/symptom-photos/<profileId>/) — every stored_path already on disk
  // stays valid and every containment root keeps resolving to the same place.
  lesion: "lesion-photos",
  symptom: "symptom-photos",
};

// The thumbnail that belongs to a stored photo, derived from its path: drop the
// extension, add `.thumb.jpg`. ONE rule, used by the writer below and by every
// reader — because `lesion_photos`/`symptom_photos` (born before the core) carry
// no `thumb_path` column and phase 3 deliberately ships no schema change. The
// thumbnail is a DERIVED artifact of the stored file, not an independent fact, so
// a sibling name is a truthful encoding of it: the row keeps pointing at the
// photo, and the thumb is always where the photo is. Readers still `existsSync`
// before serving — a pre-phase-3 file has no thumbnail until the backfill writes
// one, and the honest fallback is the full image.
export function thumbSiblingPath(storedPath: string): string {
  return storedPath.replace(/\.[^./\\]*$/, "") + ".thumb.jpg";
}

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
  // Same rule the readers use, so the writer and the derivation cannot drift.
  const thumbName = thumbSiblingPath(fileName);
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
