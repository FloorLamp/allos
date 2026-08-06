// ONE-TIME METADATA BACKFILL for the lesion + symptom photo domains (#1844,
// photo-core phase 3). Every photo those two domains stored BEFORE phase 3 was
// written to disk exactly as it arrived — so a dermatology close-up or a photo of a
// child's rash still carries the GPS coordinates, the capture timestamp and the
// device identity its camera wrote. Routing the WRITE path through processPhoto
// fixes every future photo; this pass fixes the ones already on disk.
//
// OWNER RULING (2026-08-01, issue #1844): STRIP IN PLACE. The pass re-encodes each
// stored file through the SAME processPhoto pipeline the write path now uses and
// replaces the bytes; the original bytes are NOT preserved. There is deliberately no
// archived-originals tier — an archive would just relocate the exposure, and the
// privacy guarantee is only worth stating if it is unconditional.
//
// WHY A BOOT TASK AND NOT A VERSIONED MIGRATION
//
//   1. It is FILESYSTEM work, and the migration runner's contract is transactional.
//      Each migration runs in an IMMEDIATE transaction keyed to PRAGMA user_version:
//      a crash rolls the DB back. Re-encoded image files do not roll back. A
//      half-finished pass inside a migration would leave the schema version claiming
//      work the disk had only partly done — with no way to tell which half.
//   2. sharp is ASYNC. The runner (and bootTasks itself) is synchronous by design
//      because better-sqlite3 is; processPhoto cannot be awaited from either. This
//      pass is therefore kicked as a detached async sweep AFTER boot, which a
//      migration slot cannot express at all.
//   3. It changes NO SCHEMA. It writes only mime_type / size_bytes / content_hash
//      on existing rows — the three facts that stop being true when bytes are
//      re-encoded — so there is nothing for a version gate to gate.
//   4. Per-boot, re-entrant work is exactly what boot-tasks.ts is for (the auth
//      bootstrap, the canonical-flag reconcile, the stuck-work reaper). Like the
//      flag reconcile, this one is marker-gated so it does a full pass once and
//      costs a single settings read on every boot after that.
//
// IDEMPOTENCE is per FILE, not only per marker: a stored JPEG that carries no Exif
// segment is already clean and is SKIPPED without re-encoding it, so re-running the
// pass (via `npm run photo:backfill`, or after a partial run) can never re-compress
// the same photo twice. That per-file test is also what makes the pass safe to run
// against a corpus the write path has already been filling with clean photos.
//
// The file keeps its NAME and its row keeps pointing at it. A content-addressed
// rename would be tidier, but two rows whose originals differ can re-encode to
// identical bytes, and a shared content-addressed filename would then let deleting
// one row unlink the other's photo. The name is opaque; the bytes are the point.

import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { createLogger } from "../log";
import { runBootTx } from "../migrations/schema-utils";
import { readJpegExif } from "./exif";
import { sniffImageMime } from "./policy";
import { photoDomainRoot, thumbSiblingPath, type PhotoDomain } from "./store";

const log = createLogger("photo-backfill");

// Bump when the pass itself must run again over an already-marked instance (a
// widened domain set, a stricter clean test). The marker records the version that
// completed, so an older stamp re-runs and an equal one skips.
export const PHOTO_BACKFILL_VERSION = 1;
export const PHOTO_BACKFILL_MARKER = "photo_metadata_backfill";

// A claim older than this is treated as abandoned (a process died mid-sweep), so the
// next boot picks the work back up instead of waiting forever.
const CLAIM_STALE_MINUTES = 60;

// The sync-accounting shape (inserted/updated/unchanged, one domain over):
//   processed — bytes carried metadata (or weren't JPEG) and were re-encoded clean
//   skipped   — nothing to do: already metadata-free, file missing, or out of root
//   failed    — the file could not be read/cleaned; it is left EXACTLY as it was
export interface PhotoBackfillTally {
  processed: number;
  skipped: number;
  failed: number;
}

// One stored photo as this pass sees it: where its bytes are, and the hash the row
// currently claims for them.
interface StoredRow {
  id: number;
  stored_path: string;
  content_hash: string | null;
}

// Each domain supplies its three statements as CALLS, not as SQL strings held in a
// field: every statement below is prepared from a literal the source scanners can
// read, and each one is profile-scoped. An instance-wide maintenance pass is not a licence to write
// an unscoped statement — which is exactly why the sweep walks profile by profile.
interface DomainSpec {
  domain: PhotoDomain;
  rows: (db: Database.Database, profileId: number) => StoredRow[];
  hashTakenBy: (
    db: Database.Database,
    profileId: number,
    hash: string,
    exceptId: number
  ) => boolean;
  applyBytes: (
    db: Database.Database,
    profileId: number,
    id: number,
    mime: string,
    sizeBytes: number,
    hash: string | null
  ) => void;
}

const DOMAINS: DomainSpec[] = [
  {
    domain: "lesion",
    rows: (db, profileId) =>
      db
        .prepare(
          `SELECT id, stored_path, content_hash FROM lesion_photos
            WHERE profile_id = ? AND stored_path IS NOT NULL AND stored_path != ''
            ORDER BY id`
        )
        .all(profileId) as StoredRow[],
    hashTakenBy: (db, profileId, hash, exceptId) =>
      db
        .prepare(
          `SELECT id FROM lesion_photos
            WHERE profile_id = ? AND content_hash = ? AND id != ?`
        )
        .get(profileId, hash, exceptId) !== undefined,
    applyBytes: (db, profileId, id, mime, sizeBytes, hash) => {
      db.prepare(
        `UPDATE lesion_photos SET mime_type = ?, size_bytes = ?, content_hash = ?
          WHERE id = ? AND profile_id = ?`
      ).run(mime, sizeBytes, hash, id, profileId);
    },
  },
  {
    domain: "symptom",
    rows: (db, profileId) =>
      db
        .prepare(
          `SELECT id, stored_path, content_hash FROM symptom_photos
            WHERE profile_id = ? AND stored_path IS NOT NULL AND stored_path != ''
            ORDER BY id`
        )
        .all(profileId) as StoredRow[],
    hashTakenBy: (db, profileId, hash, exceptId) =>
      db
        .prepare(
          `SELECT id FROM symptom_photos
            WHERE profile_id = ? AND content_hash = ? AND id != ?`
        )
        .get(profileId, hash, exceptId) !== undefined,
    applyBytes: (db, profileId, id, mime, sizeBytes, hash) => {
      db.prepare(
        `UPDATE symptom_photos SET mime_type = ?, size_bytes = ?, content_hash = ?
          WHERE id = ? AND profile_id = ?`
      ).run(mime, sizeBytes, hash, id, profileId);
    },
  },
];

// Already clean? A JPEG with no Exif/GPS segment is exactly what the pipeline
// produces, so re-encoding it would only cost a generation of quality. Anything
// else — PNG/GIF/WEBP containers (their own metadata chunks are not parsed here),
// or a JPEG that still carries a segment — goes through the pipeline.
function alreadyClean(bytes: Buffer): boolean {
  if (sniffImageMime(bytes) !== "image/jpeg") return false;
  const exif = readJpegExif(bytes);
  return !exif.hasExif && !exif.hasGps;
}

// Replace a stored file atomically: write beside it, then rename over it. A crash
// mid-write leaves the original intact rather than a truncated photo.
function replaceFile(abs: string, bytes: Buffer): void {
  // Per-process temp name: two instances that both claimed the sweep (a lost CAS
  // race) must not write the same scratch file.
  const tmp = `${abs}.backfill-${process.pid}.tmp`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, abs);
}

// Re-encode one stored photo in place. Returns which tally bucket it landed in.
async function backfillOne(
  db: Database.Database,
  spec: DomainSpec,
  profileId: number,
  row: StoredRow
): Promise<keyof PhotoBackfillTally> {
  const root = path.resolve(photoDomainRoot(spec.domain));
  const abs = path.resolve(process.cwd(), row.stored_path);
  // Containment first, always: a corrupt/hostile stored_path is never followed,
  // let alone overwritten.
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    log.warn("stored photo outside its domain root — skipped", {
      domain: spec.domain,
      id: row.id,
    });
    return "skipped";
  }
  if (!fs.existsSync(abs)) return "skipped";

  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(abs);
  } catch (err) {
    log.warn("could not read stored photo", { domain: spec.domain, err });
    return "failed";
  }
  if (alreadyClean(bytes)) return "skipped";

  // Loaded here, not at module scope, so importing this module (which boot does on
  // EVERY process start, including the hourly notify tick) never pulls in the native
  // sharp codec for an instance with nothing left to clean.
  const { processPhoto } = await import("./ingest");
  const processed = await processPhoto(bytes);
  if (processed.kind === "invalid") {
    // Left untouched on purpose: a file we cannot re-encode (an unreadable or HEIC
    // image) must not be replaced by anything. It stays visible in the tally.
    log.warn("could not clean stored photo", {
      domain: spec.domain,
      id: row.id,
      reason: processed.error,
    });
    return "failed";
  }
  const photo = processed.photo;

  try {
    replaceFile(abs, photo.bytes);
    // The thumbnail the grid reads. Derived name, same rule as the writer.
    replaceFile(
      path.resolve(process.cwd(), thumbSiblingPath(row.stored_path)),
      photo.thumbBytes
    );
  } catch (err) {
    log.warn("could not replace stored photo", { domain: spec.domain, err });
    return "failed";
  }

  // The row's three byte-derived facts are now stale. content_hash is what the
  // per-profile dedup compares against, and the write path hashes PROCESSED bytes,
  // so adopting the processed hash is what makes "re-upload the same original"
  // recognise itself after the backfill. Two rows CAN converge on one hash (the same
  // photo saved twice with different metadata); the partial unique index would
  // refuse that, so the loser keeps its historical hash — its bytes are clean either
  // way, which is the whole point of the pass.
  const collision = spec.hashTakenBy(db, profileId, photo.contentHash, row.id);
  if (collision)
    log.info("kept historical content hash (another row now matches)", {
      domain: spec.domain,
      id: row.id,
    });
  const hash = collision ? row.content_hash : photo.contentHash;
  runBootTx(
    db.transaction(() => {
      spec.applyBytes(db, profileId, row.id, photo.mime, photo.sizeBytes, hash);
    })
  );
  return "processed";
}

// Sweep every stored lesion/symptom photo on the instance, profile by profile.
// Auth-blind maintenance: it takes the DB handle, never lib/auth, and touches only
// bytes + the three byte-derived columns. Safe to run at any time.
export async function backfillPhotoMetadata(
  db: Database.Database
): Promise<PhotoBackfillTally> {
  const tally: PhotoBackfillTally = { processed: 0, skipped: 0, failed: 0 };
  const profiles = db.prepare(`SELECT id FROM profiles ORDER BY id`).all() as {
    id: number;
  }[];
  for (const spec of DOMAINS) {
    for (const profile of profiles) {
      const rows = spec.rows(db, profile.id);
      for (const row of rows) {
        tally[await backfillOne(db, spec, profile.id, row)] += 1;
      }
    }
  }
  return tally;
}

// ---------------------------------------------------------------------------
// The once-per-install gate.
//
// The pass itself is safe to repeat, but a full corpus read on every boot is not
// free, so a marker in the global `settings` records that it completed (the
// canonical-flags-signature pattern). The marker is claimed inside an IMMEDIATE
// transaction, so two processes booting together cannot both decide to sweep.

interface BackfillMarker {
  version: number;
  state: "running" | "done";
  claimedAt: string;
  finishedAt?: string;
  tally?: PhotoBackfillTally;
}

function readMarker(db: Database.Database): BackfillMarker | null {
  const row = db
    .prepare(`SELECT value FROM settings WHERE key = ?`)
    .get(PHOTO_BACKFILL_MARKER) as { value?: string } | undefined;
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value) as BackfillMarker;
  } catch {
    // An unreadable marker is treated as absent — the pass re-runs, which is safe.
    return null;
  }
}

function writeMarker(db: Database.Database, marker: BackfillMarker): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(PHOTO_BACKFILL_MARKER, JSON.stringify(marker));
}

// Does this instance still owe a pass? Exported so the DB-tier test can assert the
// gate directly instead of racing the detached sweep.
export function photoBackfillDue(
  marker: BackfillMarker | null,
  nowMs: number
): boolean {
  if (!marker || marker.version < PHOTO_BACKFILL_VERSION) return true;
  if (marker.state === "done") return false;
  // A claim from a process that died mid-sweep goes stale and is picked back up.
  const claimedMs = Date.parse(marker.claimedAt);
  if (!Number.isFinite(claimedMs)) return true;
  return nowMs - claimedMs > CLAIM_STALE_MINUTES * 60_000;
}

export function isPhotoBackfillDue(db: Database.Database, now = new Date()) {
  return photoBackfillDue(readMarker(db), now.getTime());
}

// Kick the one-time sweep if this instance still owes one. SYNCHRONOUS by contract
// (bootTasks is), so the sweep itself is detached: the claim is written before this
// returns, and the tally is logged when the pass finishes. A failure releases the
// claim rather than marking the instance clean.
export function runPhotoMetadataBackfill(db: Database.Database): void {
  const now = new Date();
  let claimed = false;
  runBootTx(
    db.transaction(() => {
      if (!photoBackfillDue(readMarker(db), now.getTime())) return;
      writeMarker(db, {
        version: PHOTO_BACKFILL_VERSION,
        state: "running",
        claimedAt: now.toISOString(),
      });
      claimed = true;
    })
  );
  if (!claimed) return;

  void backfillPhotoMetadata(db)
    .then((tally) => {
      runBootTx(
        db.transaction(() => {
          writeMarker(db, {
            version: PHOTO_BACKFILL_VERSION,
            state: "done",
            claimedAt: now.toISOString(),
            finishedAt: new Date().toISOString(),
            tally,
          });
        })
      );
      // The sync-accounting line (#1844): one record per pass, with its counts.
      if (tally.processed || tally.failed)
        log.info("stripped metadata from stored photos", { ...tally });
    })
    .catch((err) => {
      // Leave the marker in `running` with its original claim time: it goes stale
      // within the hour and the next boot retries. Never mark an incomplete pass
      // done — that would strand exposed files forever.
      log.error("photo metadata backfill failed", { err });
    });
}
