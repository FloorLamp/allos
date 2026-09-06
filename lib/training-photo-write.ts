// Auth-blind write core + readers for TRAINING photos (#3285 item 3), the fourth
// tenant of the shared photo core (#1119). profileId-first, never imports lib/auth —
// the Server Action owns the gate + revalidation. Bytes arrive here ALREADY processed
// by lib/photo/ingest.ts processPhoto() (magic-byte sniffed, EXIF-harvested-then-
// STRIPPED, auto-oriented, downscaled, thumbnailed), so this module owns only the
// domain row, the per-profile dedup on the PROCESSED content hash, and the file store.
// Every statement is profile-scoped.
//
// ONE DOMAIN, TWO OWNERS — the design call this issue forced, and the argument is the
// STORE's shape rather than the issue's wording:
//
//   * `DOMAIN_DIRS` maps a domain to ONE per-profile directory and `storeProcessedPhoto`
//     names files by content hash inside it, while the dedup is scoped to the TABLE. Two
//     domains would store the identical race photograph twice — once under the event,
//     once under the run that WAS the event — because neither dedup can see the other.
//     One domain makes it one row and one file, which is what it actually is.
//   * `PhotoGallery` renders ONE domain at a time and deliberately never co-mingles two
//     (the privacy-tier separation). The event page has to show its own uploads beside
//     its linked activities' in ONE grid, so two domains would force either a forbidden
//     co-mingle or two grids over one set of pictures.
//   * The three shipped domains are separate because their SUBJECTS and privacy tiers
//     differ — a physique, a mole, a rash. A bib photo and the race run's photos are
//     the same subject at the same tier; only the FK differs, and a foreign key is a
//     column, not a store.
//
// So the owner is `activity_id` XOR `endurance_plan_id`, enforced by a CHECK in the
// schema and by the `TrainingPhotoOwner` union here, so "no owner" and "two owners"
// are unrepresentable on both sides and no function needs to guard for them.
//
// PHI POSTURE (strictest tier, the symptom_photos/progress_photos precedent): training
// photos are excluded from share links, the printable and the emergency card
// STRUCTURALLY — none of those paths read this table or its files — and out of the
// default full export, joining the #1846 opt-in media bundle only.

import { db, writeTx } from "./db";
import type { ProcessedPhoto } from "./photo/ingest";
import { storeProcessedPhoto, unlinkPhotoFiles } from "./photo/store";

// WHAT A TRAINING PHOTO IS OF. A logged session, or an event — never both, never
// neither. The union is the schema CHECK in the type system, so every call site
// names one owner and no reader has to ask whether a row is well-formed.
export type TrainingPhotoOwner =
  { kind: "activity"; activityId: number } | { kind: "event"; planId: number };

export interface TrainingPhotoRow {
  id: number;
  // The owner's own date (`activities.date` / `endurance_plans.event_date`), derived
  // in the SELECT rather than stored — see the migration for why.
  date: string;
  activityId: number | null;
  planId: number | null;
  // What the photo is of, for the gallery's meta line and its series chip: the
  // session's title, or the event's name.
  ownerLabel: string;
  caption: string | null;
  created_at: string;
}

export type AddTrainingPhotoOutcome =
  | { kind: "added"; id: number }
  | { kind: "duplicate"; id: number }
  | { kind: "invalid"; error: string };

// The owner columns for one owner: exactly one is non-null, so the INSERT and every
// scoped read bind the same pair and neither can drift from the CHECK.
function ownerColumns(owner: TrainingPhotoOwner): {
  activityId: number | null;
  planId: number | null;
} {
  return owner.kind === "activity"
    ? { activityId: owner.activityId, planId: null }
    : { activityId: null, planId: owner.planId };
}

// Whether the owner row is THIS profile's. The FKs are enforced by SQLite, but a
// forged id from another profile would otherwise attach a photo to a stranger's
// session — profile scoping is the app's rule, not the schema's.
function ownerExists(profileId: number, owner: TrainingPhotoOwner): boolean {
  const row =
    owner.kind === "activity"
      ? db
          .prepare(`SELECT 1 FROM activities WHERE id = ? AND profile_id = ?`)
          .get(owner.activityId, profileId)
      : db
          .prepare(
            `SELECT 1 FROM endurance_plans WHERE id = ? AND profile_id = ?`
          )
          .get(owner.planId, profileId);
  return row !== undefined;
}

// Attach a processed photo to a session or an event. Dedups per-profile on the
// PROCESSED content hash across the whole domain — a re-upload of the identical
// capture reuses the existing row wherever it already hangs, which is the honest
// answer here because the event page already shows its linked activities' photos, so
// the same bytes never need a second home. Returns a typed outcome so the caller
// never unconditionally confirms.
export function addTrainingPhotoCore(
  profileId: number,
  owner: TrainingPhotoOwner,
  photo: ProcessedPhoto,
  caption: string | null = null
): AddTrainingPhotoOutcome {
  if (!ownerExists(profileId, owner))
    return {
      kind: "invalid",
      error:
        owner.kind === "activity"
          ? "That session is no longer available."
          : "That event is no longer available.",
    };
  const cap = caption?.trim() ? caption.trim().slice(0, 500) : null;
  const { activityId, planId } = ownerColumns(owner);

  return writeTx(() => {
    const existing = db
      .prepare(
        `SELECT id FROM training_photos WHERE profile_id = ? AND content_hash = ?`
      )
      .get(profileId, photo.contentHash) as { id: number } | undefined;
    if (existing) return { kind: "duplicate" as const, id: existing.id };

    const { storedPath, thumbPath } = storeProcessedPhoto(
      "training",
      profileId,
      photo
    );
    const info = db
      .prepare(
        `INSERT INTO training_photos
           (profile_id, activity_id, endurance_plan_id, stored_path, thumb_path,
            content_hash, mime_type, size_bytes, caption)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        activityId,
        planId,
        storedPath,
        thumbPath,
        photo.contentHash,
        photo.mime,
        photo.sizeBytes,
        cap
      );
    return { kind: "added" as const, id: Number(info.lastInsertRowid) };
  });
}

// Correct one training photo's METADATA in place (#1934). The caption is the only
// field a human can get wrong here — the date is the owner's and is never stored, and
// the owner is what the photo is OF rather than a description of it — so the SET list
// is one column. `stored_path`, `thumb_path`, `content_hash`, `mime_type` and
// `size_bytes` are absent from it, which is the split the core requires: a correction
// can never re-point a row at different pixels, and the per-profile content-hash dedup
// keeps meaning exactly what it meant. Profile-scoped by id; the same 500-character
// ceiling as the upload.
export function updateTrainingPhotoCaptionCore(
  profileId: number,
  id: number,
  caption: string | null
): boolean {
  const cap = caption?.trim() ? caption.trim().slice(0, 500) : null;
  return (
    db
      .prepare(
        `UPDATE training_photos SET caption = ? WHERE id = ? AND profile_id = ?`
      )
      .run(cap, id, profileId).changes > 0
  );
}

// Delete one training photo — the row AND its on-disk files (row-op side-state
// #199/#203; path-contained by the core store). Idempotent; profile-scoped by id.
export function deleteTrainingPhotoCore(
  profileId: number,
  id: number
): boolean {
  return writeTx(() => {
    const row = db
      .prepare(
        `SELECT stored_path, thumb_path FROM training_photos
          WHERE id = ? AND profile_id = ?`
      )
      .get(id, profileId) as
      { stored_path: string; thumb_path: string | null } | undefined;
    if (!row) return false;
    db.prepare(
      `DELETE FROM training_photos WHERE id = ? AND profile_id = ?`
    ).run(id, profileId);
    unlinkPhotoFiles("training", [row.stored_path, row.thumb_path]);
    return true;
  });
}

// An EVENT's photos go with the event (both FKs cascade), and a plan delete is a
// plain delete with no undo capture behind it — so its files must be reclaimed in the
// same breath, before the rows are gone. Called from deleteEndurancePlanCore INSIDE
// its writeTx; the explicit DELETE means the sweep does not depend on the
// foreign_keys pragma, exactly as that core's activity unlink does not.
//
// An activity's photos are the other case and are deliberately NOT swept here: an
// activity delete is UNDOABLE, the `activity` undo kind captures these rows beside the
// clips, and their content-named files are reclaimed at PURGE (#1847) so a restore
// re-points at the same bytes.
export function deleteEventPhotosForPlan(
  profileId: number,
  planId: number
): void {
  const rows = db
    .prepare(
      `SELECT stored_path, thumb_path FROM training_photos
        WHERE profile_id = ? AND endurance_plan_id = ?`
    )
    .all(profileId, planId) as {
    stored_path: string;
    thumb_path: string | null;
  }[];
  if (rows.length === 0) return;
  db.prepare(
    `DELETE FROM training_photos WHERE profile_id = ? AND endurance_plan_id = ?`
  ).run(profileId, planId);
  unlinkPhotoFiles(
    "training",
    rows.flatMap((r) => [r.stored_path, r.thumb_path])
  );
}

// ── Readers ──────────────────────────────────────────────────────────────────────

// The date and label of a photo's owner, joined in so no reader stores or re-derives
// them. The CHECK makes exactly one side match, so the COALESCE is total.
const OWNER_JOIN = `
       LEFT JOIN activities a
              ON a.id = tp.activity_id AND a.profile_id = tp.profile_id
       LEFT JOIN endurance_plans ep
              ON ep.id = tp.endurance_plan_id AND ep.profile_id = tp.profile_id`;
const OWNER_COLUMNS = `
       COALESCE(a.date, ep.event_date) AS date,
       COALESCE(a.title, ep.event_name, ep.kind) AS owner_label`;

interface RawTrainingPhotoRow {
  id: number;
  date: string;
  activity_id: number | null;
  endurance_plan_id: number | null;
  owner_label: string;
  caption: string | null;
  created_at: string;
}

function toRow(r: RawTrainingPhotoRow): TrainingPhotoRow {
  return {
    id: r.id,
    date: r.date,
    activityId: r.activity_id,
    planId: r.endurance_plan_id,
    ownerLabel: r.owner_label,
    caption: r.caption,
    created_at: r.created_at,
  };
}

// One session's photos, newest first. Profile-scoped.
export function getActivityPhotos(
  profileId: number,
  activityId: number
): TrainingPhotoRow[] {
  return (
    db
      .prepare(
        `SELECT tp.id, tp.activity_id, tp.endurance_plan_id, tp.caption,
                tp.created_at,${OWNER_COLUMNS}
           FROM training_photos tp${OWNER_JOIN}
          WHERE tp.profile_id = ? AND tp.activity_id = ?
          ORDER BY tp.id DESC`
      )
      .all(profileId, activityId) as RawTrainingPhotoRow[]
  ).map(toRow);
}

// AN EVENT'S MEDIA IS ITS OWN UPLOADS PLUS ITS LINKED ACTIVITIES' (#3285 item 3's own
// sentence). One statement, not two reads stitched in JS: the event page shows one
// grid, so the union is the query. The linked set is read through
// `activities.endurance_plan_id` (item 2's link), so a photo follows its session into
// and out of the event as the link moves.
export function getEventPhotos(
  profileId: number,
  planId: number
): TrainingPhotoRow[] {
  return (
    db
      .prepare(
        `SELECT tp.id, tp.activity_id, tp.endurance_plan_id, tp.caption,
                tp.created_at,${OWNER_COLUMNS}
           FROM training_photos tp${OWNER_JOIN}
          WHERE tp.profile_id = ?
            AND (tp.endurance_plan_id = ? OR a.endurance_plan_id = ?)
          ORDER BY tp.endurance_plan_id IS NULL, tp.id DESC`
      )
      .all(profileId, planId, planId) as RawTrainingPhotoRow[]
  ).map(toRow);
}

// How many photos each session and each event carries — the media filter's predicate
// (#3283/#3958), read in ONE grouped statement rather than a probe per feed row. The
// table is a photo table: a profile's whole set is a few hundred rows at most.
export function trainingPhotoCounts(profileId: number): {
  byActivity: Map<number, number>;
  byEvent: Map<number, number>;
} {
  const byActivity = new Map<number, number>();
  const byEvent = new Map<number, number>();
  const rows = db
    .prepare(
      `SELECT activity_id, endurance_plan_id, COUNT(*) AS c
         FROM training_photos WHERE profile_id = ?
        GROUP BY activity_id, endurance_plan_id`
    )
    .all(profileId) as {
    activity_id: number | null;
    endurance_plan_id: number | null;
    c: number;
  }[];
  for (const r of rows) {
    if (r.activity_id != null) byActivity.set(r.activity_id, r.c);
    else if (r.endurance_plan_id != null) byEvent.set(r.endurance_plan_id, r.c);
  }
  return { byActivity, byEvent };
}
