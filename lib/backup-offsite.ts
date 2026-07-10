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

// Which upload files must be copied to bring the destination into line with the
// source. Uploads are content-hashed and immutable (see the medical file-serve
// dedup), so a destination file at the same relative path is assumed identical and
// skipped — this keeps the per-backup mirror cheap even as the upload tree grows.
// A size mismatch (a truncated/partial earlier copy) forces a recopy. The mirror is
// APPEND-ONLY: files present only at the destination are left untouched, so a row
// deleted in the app (and its source file unlinked) never removes the durable copy.
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
