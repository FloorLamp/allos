// Auth-blind write cores + gather for SYMPTOM / episode video clips (#1224 phase
// 1). profileId-first, never imports lib/auth — the Server Action owns the gate +
// revalidation. The symptom_photos posture (#859 item 4) for VIDEO: its OWN table
// + files dir, so a seizure/tremor clip never enters the medical-document pipeline
// / passport. A clip binds to a symptom-DAY by `date` (membership-by-date, like
// every illness ingredient); `symptom` optionally pins a specific symptom-day.
// Every statement is profile-scoped.
//
// Bytes arrive here ALREADY validated by lib/video/ingest.ts ingestVideo()
// (container-sniffed, capped, hashed) and the poster ALREADY EXIF-stripped by the
// #1119 photo ingest — this module owns the domain row + per-profile dedup + the
// file store. The ORIGINAL clip is stored AS-IS (no re-encode — the no-native-
// dependency line); `has_location` records that an embedded GPS atom was DETECTED
// so the UI can show the privacy note (the coordinate is never stored).
//
// PHI POSTURE (strictest tier, the symptom_photos precedent): nothing here is read
// by the episode share/print path (assembleIllnessEpisode) or the export — the
// exclusion of clips from shares/printables/export is STRUCTURAL, not a flag.

import { db, writeTx } from "./db";
import { isRealIsoDate } from "./date";
import type { IngestedVideo } from "./video/ingest";
import { storeVideoFiles, unlinkVideoFiles } from "./video/store";

export interface SymptomVideoRow {
  id: number;
  date: string;
  symptom: string | null;
  caption: string | null;
  kind: string;
  duration_sec: number | null;
  has_location: number;
  poster_path: string | null;
  created_at: string;
}

export type SymptomVideoOutcome =
  | { kind: "attached"; id: number }
  | { kind: "duplicate"; id: number }
  | { kind: "invalid"; error: string };

// Attach a validated clip to a symptom-day. Validates the date, dedups per-profile
// on the clip's content hash, stores the clip + optional poster under
// data/uploads/symptom-videos/<profileId>/, and inserts the row. Returns a typed
// outcome so the caller never unconditionally confirms.
export function attachSymptomVideoCore(
  profileId: number,
  input: { date: string; symptom: string | null; caption: string | null },
  video: IngestedVideo,
  poster: Buffer | null
): SymptomVideoOutcome {
  if (!isRealIsoDate(input.date))
    return { kind: "invalid", error: "Enter a valid date." };
  const sym = input.symptom?.trim() ? input.symptom.trim() : null;
  const cap = input.caption?.trim() ? input.caption.trim().slice(0, 500) : null;

  return writeTx(() => {
    const existing = db
      .prepare(
        `SELECT id FROM symptom_videos WHERE profile_id = ? AND content_hash = ?`
      )
      .get(profileId, video.contentHash) as { id: number } | undefined;
    if (existing) return { kind: "duplicate" as const, id: existing.id };

    const { storedPath, posterPath } = storeVideoFiles("symptom", profileId, {
      contentHash: video.contentHash,
      mime: video.mime,
      bytes: video.bytes,
      poster,
    });
    const info = db
      .prepare(
        `INSERT INTO symptom_videos
           (profile_id, date, symptom, stored_path, poster_path, content_hash,
            mime_type, kind, duration_sec, size_bytes, has_location, caption)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        input.date,
        sym,
        storedPath,
        posterPath,
        video.contentHash,
        video.mime,
        video.kind,
        video.durationSec,
        video.sizeBytes,
        video.hasLocation ? 1 : 0,
        cap
      );
    return { kind: "attached" as const, id: Number(info.lastInsertRowid) };
  });
}

// The clips attached in a date window (episode strip). Newest first. Profile-scoped.
export function getSymptomVideosInRange(
  profileId: number,
  from: string,
  to: string
): SymptomVideoRow[] {
  return db
    .prepare(
      `SELECT id, date, symptom, caption, kind, duration_sec, has_location,
              poster_path, created_at
         FROM symptom_videos
        WHERE profile_id = ? AND date >= ? AND date <= ?
        ORDER BY date DESC, id DESC`
    )
    .all(profileId, from, to) as SymptomVideoRow[];
}

// Update only the user-authored caption. Empty text clears it; the 500-char
// ceiling matches upload. Profile-scoped by id.
export function updateSymptomVideoCaptionCore(
  profileId: number,
  id: number,
  caption: string | null
): boolean {
  const cap = caption?.trim() ? caption.trim().slice(0, 500) : null;
  return (
    db
      .prepare(
        `UPDATE symptom_videos SET caption = ? WHERE id = ? AND profile_id = ?`
      )
      .run(cap, id, profileId).changes > 0
  );
}

// Delete one symptom clip — the row AND its on-disk files (clip + poster), path-
// contained (row-op side-state #199). Idempotent; profile-scoped by id.
export function deleteSymptomVideoCore(profileId: number, id: number): boolean {
  return writeTx(() => {
    const row = db
      .prepare(
        `SELECT stored_path, poster_path FROM symptom_videos
          WHERE id = ? AND profile_id = ?`
      )
      .get(id, profileId) as
      { stored_path: string; poster_path: string | null } | undefined;
    if (!row) return false;
    db.prepare(
      `DELETE FROM symptom_videos WHERE id = ? AND profile_id = ?`
    ).run(id, profileId);
    unlinkVideoFiles("symptom", [row.stored_path, row.poster_path]);
    return true;
  });
}
