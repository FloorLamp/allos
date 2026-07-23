// File store for the shared video core (#1224): per-profile dirs under
// data/uploads/<domain-dir>/<profileId>/, path-contained unlink — the #1119
// photo-store posture, generalized to (video + poster) file pairs. The domain
// write core (lib/symptom-video-write.ts / lib/activity-video-write.ts) calls
// storeVideoFiles inside its writeTx and records the returned repo-relative paths
// on the row; every later unlink (single delete, profile delete) re-contains the
// stored path before touching disk, so a corrupt/hostile stored_path can never rm
// outside the domain's root.
//
// Unlike the photo core, the ORIGINAL video is stored AS-IS (no re-encode — the
// no-native-dependency line, #1224). The POSTER is a client-extracted JPEG run
// through the #1119 photo ingest, so it is EXIF-stripped like every other stored
// image; a clip whose frame couldn't be decoded client-side (CI, an audio clip)
// simply has no poster.

import fs from "node:fs";
import path from "node:path";

export type VideoDomain = "symptom" | "activity";

const DOMAIN_DIRS: Record<VideoDomain, string> = {
  symptom: "symptom-videos",
  activity: "activity-videos",
};

// File extension for a sniffed container MIME (the stored name carries it so the
// serve route can hand back a sensible download filename).
const EXT_FOR_MIME: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "audio/mp4": ".m4a",
  "audio/webm": ".weba",
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
};

export function videoExtForMime(mime: string): string {
  return EXT_FOR_MIME[mime] ?? ".bin";
}

// Absolute root a domain's videos live under. Exported for the serve route's and
// deleteProfile's containment checks.
export function videoDomainRoot(domain: VideoDomain): string {
  return path.join(process.cwd(), "data", "uploads", DOMAIN_DIRS[domain]);
}

export interface StoredVideoPaths {
  storedPath: string; // repo-relative, e.g. data/uploads/symptom-videos/3/ab12….mp4
  posterPath: string | null;
}

// Write the raw video (named by content hash + its container extension) and, when
// present, the poster JPEG, under the domain's per-profile dir. A re-store of
// identical content overwrites in place (idempotent). Returns repo-relative paths.
export function storeVideoFiles(
  domain: VideoDomain,
  profileId: number,
  input: {
    contentHash: string;
    mime: string;
    bytes: Buffer;
    poster: Buffer | null;
  }
): StoredVideoPaths {
  const dir = path.join(videoDomainRoot(domain), String(profileId));
  fs.mkdirSync(dir, { recursive: true });
  const base = input.contentHash.slice(0, 16);
  const videoName = `${base}${videoExtForMime(input.mime)}`;
  fs.writeFileSync(path.join(dir, videoName), input.bytes);
  const rel = (name: string) =>
    path.join("data", "uploads", DOMAIN_DIRS[domain], String(profileId), name);
  let posterPath: string | null = null;
  if (input.poster) {
    const posterName = `${base}.poster.jpg`;
    fs.writeFileSync(path.join(dir, posterName), input.poster);
    posterPath = rel(posterName);
  }
  return { storedPath: rel(videoName), posterPath };
}

// Best-effort, path-contained unlink of stored video files. A path resolving
// outside the domain root is skipped, never followed; a missing/locked file never
// throws (the DB row delete must not fail on fs state).
export function unlinkVideoFiles(
  domain: VideoDomain,
  relPaths: readonly (string | null | undefined)[]
): void {
  const root = path.resolve(videoDomainRoot(domain));
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
