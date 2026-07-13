import path from "node:path";

// Pure decision logic for OFF-VOLUME backup replication (issue #130). The primary
// backup pipeline (lib/backup.ts) writes verified `VACUUM INTO` snapshots under
// data/backups — the SAME bind mount as the live DB, so a volume loss destroys the
// database and every snapshot together; medical uploads (data/uploads/**) aren't in
// a snapshot at all. This module owns the *pure* parts of the durability fix:
// resolving the operator-configured secondary destination and planning the
// incremental uploads mirror. No fs/DB/network here — the copy side effects live in
// lib/backup.ts (replicateToOffsite). Unit-tested in lib/__tests__/backup-offsite.test.ts.

// One file in the uploads tree: its path RELATIVE to the uploads root, plus size.
// Both the source list and the destination list are produced by the same walker
// (lib/backup.ts listUploadFiles), so their `rel` strings are directly comparable.
export interface MirrorEntry {
  rel: string;
  size: number;
}

// Resolve the operator-configured secondary backup directory from a raw env value
// (BACKUP_DEST_DIR). Trims surrounding whitespace; an unset or blank value means
// "no off-volume destination configured" (null), which disables replication. Kept
// deliberately dumb — a plain second directory the operator mounts (a NAS, another
// disk, a synced folder) is the whole feature; rclone/S3 stay out of scope.
export function resolveOffsiteDir(
  raw: string | undefined | null
): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// A sentinel file written ONCE into the mounted off-volume destination (via the
// admin "Verify destination" action). Its presence is how we tell a real mounted
// volume from a bare, unmounted mount point — see checkOffsiteReadiness (#463).
export const OFFSITE_SENTINEL = ".allos-backup-destination";

// Whether the configured off-volume destination is actually MOUNTED and ready to
// receive a replica, or must be SKIPPED (recording an error) rather than silently
// mkdir'd (#463). The disaster this prevents: BACKUP_DEST_DIR points at a mount
// that isn't present (forgotten second mount, or a NAS that unmounted), so the old
// `mkdir -p` created the destination inside the container's ephemeral writable
// layer and reported a healthy off-volume backup every night — into a directory
// destroyed on the next `compose up`. We NEVER create the destination ROOT: it
// must pre-exist as a directory AND carry the sentinel file (subdirectories under a
// verified root are still created freely). Pure — the caller does the fs stats.
export type OffsiteReadiness =
  { ready: true } | { ready: false; reason: string };

export function checkOffsiteReadiness(opts: {
  rootExists: boolean;
  rootIsDir: boolean;
  sentinelPresent: boolean;
}): OffsiteReadiness {
  if (!opts.rootExists || !opts.rootIsDir) {
    return {
      ready: false,
      reason:
        "destination not mounted: BACKUP_DEST_DIR does not exist (the second mount is missing or the volume unmounted)",
    };
  }
  if (!opts.sentinelPresent) {
    return {
      ready: false,
      reason:
        "destination not verified: missing .allos-backup-destination sentinel (the mount may be gone, or it was never initialized — use Settings → Server → Verify destination)",
    };
  }
  return { ready: true };
}

// Which upload files must be copied to bring the destination into line with the
// source. Uploads are content-hashed and immutable (see the medical file-serve
// dedup), so a destination file at the same relative path is assumed identical and
// skipped — this keeps the per-backup mirror cheap even as the upload tree grows.
// A size mismatch (a truncated/partial earlier copy) forces a recopy. The mirror is
// APPEND-ONLY: files present only at the destination are left untouched, so a row
// deleted in the app (and its source file unlinked) never removes the durable copy.
// APPEND-ONLY EXCEPTION — profile deletion (#625). The append-only contract above
// is right for single-row deletes (a hand-corrected/re-synced row shouldn't drop
// its durable copy), but deleteProfile is a deliberate "right to delete": it unlinks
// the person's medical files + profile photo locally, and their DB traces age out of
// snapshots via retention — while the off-volume uploads mirror was pruned by
// NOTHING, leaving a deleted person's complete medical document set readable on the
// NAS forever. This maps each locally-unlinked upload path to its mirror path and
// returns the mirror paths to remove, so the profile-delete file sweep reaches the
// mirror too and the two stay in step.
export function planUploadMirror(
  src: MirrorEntry[],
  dest: MirrorEntry[]
): string[] {
  const destSizeByRel = new Map<string, number>();
  for (const d of dest) destSizeByRel.set(d.rel, d.size);
  const out: string[] = [];
  for (const s of src) {
    const destSize = destSizeByRel.get(s.rel);
    if (destSize === undefined || destSize !== s.size) out.push(s.rel);
  }
  return out;
}

// Where the uploads mirror lives inside the off-volume destination root: the copy
// side (replicateToOffsite) writes files under `<dest>/uploads/<rel>`, so the sweep
// removes from the same subtree.
export function offsiteUploadsRoot(destDir: string): string {
  return path.join(destDir, "uploads");
}

// Map local upload files (absolute paths under the local uploads root) to the
// absolute mirror paths that must be removed to purge them off-volume (#625). Each
// result is CONTAINED under `<destDir>/uploads` — a local path that isn't actually
// under `uploadsRoot` (a hostile/corrupt stored_path, e.g. "../../etc/passwd") maps
// to a rel that escapes the tree and is SKIPPED, never followed — the same
// path-containment discipline as the local unlink (deleteFilesUnderRoot). Pure: the
// caller resolves the roots + local paths and does the fs unlink on the results.
export function planOffsiteMirrorRemovals(
  uploadsRoot: string,
  destDir: string,
  localAbsPaths: readonly string[]
): string[] {
  const destUploads = offsiteUploadsRoot(destDir);
  const out: string[] = [];
  for (const abs of localAbsPaths) {
    if (!abs) continue;
    const rel = path.relative(uploadsRoot, abs);
    // rel must stay INSIDE uploadsRoot: an empty rel (== root), a "..", or an
    // absolute rel means the local path escapes the uploads tree — skip it.
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    const target = path.join(destUploads, rel);
    // Double-guard the destination side: the mirror target must resolve inside
    // <dest>/uploads, never at or above it.
    if (target !== destUploads && !target.startsWith(destUploads + path.sep)) {
      continue;
    }
    out.push(target);
  }
  return out;
}
