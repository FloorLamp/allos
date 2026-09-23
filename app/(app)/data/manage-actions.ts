"use server";
import { requireWriteAccess } from "@/lib/auth";

import { revalidateRoute } from "@/lib/revalidate";
import { db, writeTx } from "@/lib/db";
import {
  DELETE_POLICY,
  type DatasetDeletePolicy,
  type DeletableDatasetKey,
} from "@/lib/export";
import type { OwnedTable } from "@/lib/owned-tables";
import {
  cleanupOrphanBiomarkerKeyedState,
  cleanupOrphanPrDismissals,
  sweepImmunizationDismissals,
} from "@/lib/queries";
import { DATASET_UNDO_KIND, undoKindForTable } from "@/lib/dataset-undo";
import {
  captureDelete,
  capturedFilesOf,
  deleteExplicitChildren,
  detachRepointedLinks,
  unlinkIntakeItemsFromRecord,
  unlinkProtocolsFromIntakeItem,
  unlinkPurgedFiles,
} from "@/lib/undo-delete-db";
import {
  PHOTO_FILE_TABLES,
  VIDEO_FILE_TABLES,
  getKindSpec,
  serializePayload,
  type Row,
} from "@/lib/undo-delete";
import { nullEncounterLinks } from "@/lib/queries/visit-links";
import { detachConditionIntakeLinks } from "@/lib/condition-delete";
import { unlinkProtocolsFromTargets } from "@/lib/frequency-target-delete";
import {
  unlinkFollowUpsForClinicalObservation,
  unlinkFollowUpsForImagingStudy,
  unlinkFollowUpsForMetricSample,
} from "@/lib/followup-write";
import {
  intakeItemDoseIds,
  sweepIntakeItemMarkers,
} from "@/lib/intake-marker-cleanup";
import { writeImportTombstoneForRow } from "@/lib/integrations/tombstones";
import { TOMBSTONE_TABLES } from "@/lib/integrations/tombstone-keys";

// A plain (non-undo) bulk delete of a tombstone-tracked table must leave a
// re-import tombstone so the next rolling-window sync can't resurrect the removed
// rows (#653). The undoable datasets' row-wise deletes tombstone via captureDelete
// instead (which the undo path removes again on restore) — but BOTH helpers here
// serve only plain-delete paths: deleteDatasetRows reaches tombstonePreImages only
// after the undo branch returned, and deleteAllDatasetRows is intentionally never
// undoable, so it must take pre-images even for a table that HAS an undo kind
// (#2125 — the old undo-kind guard here silently dropped delete-all tombstones for
// every undoable root). The row pre-images are captured BEFORE the delete so their
// natural keys survive it.
function tombstonePreImages(
  table: OwnedTable,
  ids: number[],
  profileId: number
): Record<string, unknown>[] {
  if (!(TOMBSTONE_TABLES as readonly OwnedTable[]).includes(table)) return [];
  const placeholders = ids.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT * FROM ${table} WHERE id IN (${placeholders}) AND profile_id = ?`
    )
    .all(...ids, profileId) as Record<string, unknown>[];
}

function tombstoneAllPreImages(
  table: OwnedTable,
  profileId: number
): Record<string, unknown>[] {
  if (!(TOMBSTONE_TABLES as readonly OwnedTable[]).includes(table)) return [];
  return db
    .prepare(`SELECT * FROM ${table} WHERE profile_id = ?`)
    .all(profileId) as Record<string, unknown>[];
}

// ---- Freeing a care-plan follow-up's link before a raw delete ----------------

// `care_plan_items` is polymorphic over several `source_*` / `resolved_by_*` column
// pairs, one per domain. The seams in lib/followup-write.ts null BOTH halves of a
// link — `source_kind` together with the source id, and the resolved-by id alone.
// That asymmetry is the one migration 184 repairs: a discriminator left standing
// over an all-null source is the dangling state, and a resolution keeps its outcome
// text while losing the dead link.
//
// This map binds a deletable dataset's table to its pair and its seam. A table
// absent from it runs no seam here, and what becomes of its links is then whatever
// the schema declares ON DELETE (#5966 is what that costs when the declaration is
// NO ACTION: the delete raises SQLITE_CONSTRAINT_FOREIGNKEY and rolls back, so the
// person cannot delete their own data at all). The columns and the seam are
// hardcoded constants, never client input, so interpolating the column names into
// the SQL below is injection-safe — the same finite-preimage argument
// RESOLVE_TARGET_BY_KIND makes in lib/followup-write.ts.
interface FollowUpSourceLink {
  readonly sourceColumn: string;
  readonly resolvedByColumn: string;
  readonly unlink: (profileId: number, rowId: number) => void;
}

const FOLLOWUP_SOURCE_LINKS: Partial<
  Record<DeletableDatasetKey, FollowUpSourceLink>
> = {
  // Labs and intraocular pressure are both `medical_records` readings (#698), so the
  // two adapters share this one pair and this one seam.
  medical_records: {
    sourceColumn: "source_medical_record_id",
    resolvedByColumn: "resolved_by_medical_record_id",
    unlink: unlinkFollowUpsForClinicalObservation,
  },
  imaging_studies: {
    sourceColumn: "source_imaging_study_id",
    resolvedByColumn: "resolved_by_imaging_study_id",
    unlink: unlinkFollowUpsForImagingStudy,
  },
  metric_samples: {
    sourceColumn: "source_metric_sample_id",
    resolvedByColumn: "resolved_by_metric_sample_id",
    unlink: unlinkFollowUpsForMetricSample,
  },
};

// Run the domain's seam over the rows a delete is about to remove: `ids` for the
// selected-rows delete, every one of this profile's rows when it is null.
//
// ANCHORED ON THE TABLE BEING DELETED, never on `care_plan_items` (#5880's shape).
// Each seam frees by row id within the profile it is handed, so an id set read off
// the follow-ups could carry the id of ANOTHER profile's row and free this profile's
// link to a row the delete is not removing. Read off this profile's own rows, every
// id the seam is handed is a row the delete removes.
//
// Delete all runs it inside the wipe's transaction. The selected-rows delete does not,
// so a delete that failed afterwards would leave these links already freed.
function freeFollowUpLinks(
  table: DeletableDatasetKey,
  profileId: number,
  ids: number[] | null
): void {
  const link = FOLLOWUP_SOURCE_LINKS[table];
  if (!link) return;
  const selected = ids ? ` AND t.id IN (${ids.map(() => "?").join(",")})` : "";
  const linked = db
    .prepare(
      `SELECT DISTINCT t.id AS id
         FROM ${table} t
         JOIN care_plan_items c
           ON c.profile_id = t.profile_id
          AND (c.${link.sourceColumn} = t.id
               OR c.${link.resolvedByColumn} = t.id)
        WHERE t.profile_id = ?${selected}`
    )
    .all(profileId, ...(ids ?? [])) as { id: number }[];
  for (const { id } of linked) link.unlink(profileId, id);
}

// ---- Freeing every other blocking link before Delete all (#5990) -------------

// A dataset with an undo kind deletes selected rows through captureDelete, which
// frees each row's inbound links first: the linked records stay and lose the link.
// Delete all takes no capture, so it runs the same per-row seam over every row it
// removes (owner ruling on #5990: Delete all does what deleting each row does; no
// cascade, no refusal). Keyed on DATASET_UNDO_KIND so an entry can only name a
// dataset whose per-row path is that capture, plus frequency_targets, whose per-row
// path is deleteFrequencyTargetRow.
//
// A dataset absent here runs no seam, and a NO ACTION inbound link still blocks its
// wipe.
type RowUnlinkSeam = (profileId: number, rowId: number) => void;

const ROW_UNLINK_SEAMS: Partial<Record<DeletableDatasetKey, RowUnlinkSeam>> = {
  // Appointments, the nine record domains, lab/vital readings and episode links.
  encounters: nullEncounterLinks,
  // Sets, sessions, protocols and goals keep their history; the gear link goes.
  equipment: (profileId, rowId) =>
    detachRepointedLinks(DATASET_UNDO_KIND.equipment, profileId, rowId),
  // A med's indication is nulled; its condition-purpose rows go.
  conditions: detachConditionIntakeLinks,
  intake_items: unlinkProtocolsFromIntakeItem,
  frequency_targets: (profileId, rowId) =>
    unlinkProtocolsFromTargets(profileId, [rowId]),
  // The follow-up pairs are freeFollowUpLinks'; this is the projected-med link.
  medical_records: unlinkIntakeItemsFromRecord,
  // Not an unlink: a symptom-day's photos are its own rows, deleted with it as the
  // per-row delete does. Delete all then removes their files (wipedMediaFiles).
  symptom_logs: (profileId, rowId) =>
    deleteExplicitChildren(DATASET_UNDO_KIND.symptom_logs, profileId, rowId),
} satisfies Partial<
  Record<keyof typeof DATASET_UNDO_KIND | "frequency_targets", RowUnlinkSeam>
>;

// Run the dataset's seam over every one of this profile's rows, read off the table
// being deleted — the same anchoring freeFollowUpLinks keeps.
function freeRowLinks(table: DeletableDatasetKey, profileId: number): void {
  const seam = ROW_UNLINK_SEAMS[table];
  if (!seam) return;
  const rows = db
    .prepare(`SELECT id FROM ${table} WHERE profile_id = ?`)
    .all(profileId) as { id: number }[];
  for (const { id } of rows) seam(profileId, id);
}

// The media files Delete all leaves without a row (owner ruling on #5990), collected
// the way the Trash purge collects a capture's: capturedFilesOf over a payload of the
// kind's media entities (a symptom day's photos, an activity's clips and training
// photos). Only those rows are read, never the rest of a capture (an activity's
// telemetry and route), which is why Delete all takes no capture at all. Read before
// the wipe; unlinked only after it commits.
function wipedMediaFiles(table: DeletableDatasetKey, profileId: number) {
  const kind = undoKindForTable(table);
  const entities = kind ? getKindSpec(kind).entities : [];
  const media = entities.filter(
    (e) => e.table in PHOTO_FILE_TABLES || e.table in VIDEO_FILE_TABLES
  );
  if (!kind || media.length === 0) return capturedFilesOf([]);
  const ids = db
    .prepare(`SELECT id FROM ${table} WHERE profile_id = ?`)
    .all(profileId) as { id: number }[];
  const rows: Record<string, Row[]> = {};
  for (const e of media) {
    const isRoot = e === entities[0];
    const read = db.prepare(
      `SELECT * FROM ${e.table}
        WHERE (${isRoot ? "id = ?" : e.childWhere}) AND profile_id = ?`
    );
    const binds = isRoot ? 1 : (e.childBinds ?? 1);
    rows[e.entity] = ids.flatMap(
      ({ id }) =>
        read.all(...Array<number>(binds).fill(id), profileId) as Row[]
    );
  }
  return capturedFilesOf([
    { profile_id: profileId, payload: serializePayload(kind, rows) },
  ]);
}

// The per-dataset deletion policy (which pages to revalidate, whether to clean up
// orphaned biomarker stars) lives beside DATASETS in lib/export as pure data —
// this "use server" module may only export async functions, and co-locating it
// there lets a test assert the delete-button UI and the policy stay in sync.
// Child rows are removed by the schema's ON DELETE CASCADE (exercise_sets,
// supplement doses/logs/pairs). A path containing "[" is revalidated as a dynamic
// page (the revalidateRoute scope argument).

// Resolve a posted dataset key to its table + policy. The key IS the table — every
// DELETE_POLICY key equals its dataset's physical table, pinned at runtime by
// lib/__db_tests__/dataset-undo.test.ts — and every one is profile-owned, said by the
// `satisfies` rather than by a test: the `${resolved.table}` statements below can only
// ever name a table that carries profile_id (#5274).
const isDeletable = (key: string): key is DeletableDatasetKey =>
  Object.hasOwn(DELETE_POLICY, key);

function resolve(
  key: string
): { table: DeletableDatasetKey; policy: DatasetDeletePolicy } | null {
  if (!isDeletable(key)) return null;
  return { table: key satisfies OwnedTable, policy: DELETE_POLICY[key] };
}

function afterDelete(
  key: string,
  policy: DatasetDeletePolicy,
  profileId: number,
  removedVaccines: string[] = []
) {
  if (policy.cleanupStars) {
    // The same subject-delete that can orphan a star can orphan a biomarker
    // retest/flag dismissal — sweep both name-keyed side-stores so a bulk delete of
    // every reading doesn't leave a stale pin/snooze to silence a later re-add
    // (issues #203/#327).
    cleanupOrphanBiomarkerKeyedState(profileId);
  }
  if (policy.cleanupImmunizations) {
    // Bulk-deleting immunization doses un-backs their component codes exactly as the
    // per-dose delete does — sweep any orphaned `immunization:<code>` due-nudge
    // dismissal so a clean re-import re-surfaces previously-dismissed nudges (#376).
    // removedVaccines is captured BEFORE the delete (the rows are gone by now); the
    // sweep reads the post-delete remaining doses to decide which codes lost backing.
    sweepImmunizationDismissals(profileId, removedVaccines);
  }
  if (policy.cleanupPersonalRecords) {
    // Bulk-deleting activities (or equipment) un-backs a personal-record celebration
    // key exactly as the per-row delete does — sweep any orphaned `pr:` dismissal so
    // a later re-log under the same movement/activity name isn't pre-silenced
    // (#1931, the #203/#327 name-recycling class).
    cleanupOrphanPrDismissals(profileId);
  }
  // Always refresh the Data page (the management table lives there).
  revalidateRoute("/data");
  // A "[param]" path is a dynamic route and must be revalidated with the "page"
  // type; plain paths use the default.
  for (const p of policy.revalidate)
    p.includes("[") ? revalidateRoute(p, "page") : revalidateRoute(p);
}

// Delete the selected rows (by id) from a dataset's table. Ids are coerced to
// positive integers and parameterized, and the table name comes from the
// whitelisted dataset — never from the client — so this can't touch other
// tables. Returns the number of rows removed.
export async function deleteDatasetRows(
  key: string,
  ids: number[]
): Promise<
  | { ok: true; deleted: number; undoIds: number[] }
  | { ok: false; error: string }
> {
  const { profile } = await requireWriteAccess();
  const resolved = resolve(key);
  if (!resolved) return { ok: false, error: "Unknown dataset." };

  const clean = [
    ...new Set(
      (Array.isArray(ids) ? ids : [])
        .map((n) => Number(n))
        .filter((n) => Number.isInteger(n) && n > 0)
    ),
  ];
  if (clean.length === 0) return { ok: false, error: "No rows selected." };

  // Datasets whose table is an undoable root (activities, body metrics, biomarker
  // records, supplements/meds, practice sessions, substance history — #2125)
  // capture EACH row into the undo holding table so the whole batch is restorable
  // from one "Deleted N · Undo" toast (issue #29/#30). captureDelete already
  // scopes to this profile and cascades children; a row that isn't this profile's
  // returns null and is skipped.
  const kind = undoKindForTable(resolved.table);
  if (kind) {
    // Same pre-image the plain path takes below (#376): the vaccine codes about to be
    // un-backed have to be read BEFORE the rows go, and afterDelete's sweep decides
    // which of them lost their last backing dose. Undoable-kind datasets reach this
    // branch since #1847 mapped `immunizations`, so an empty list here would have
    // silently dropped the dismissal sweep for the bulk path.
    const removedVaccines = resolved.policy.cleanupImmunizations
      ? (
          db
            .prepare(
              `SELECT DISTINCT vaccine FROM ${resolved.table}
                 WHERE id IN (${clean.map(() => "?").join(",")}) AND profile_id = ?`
            )
            .all(...clean, profile.id) as { vaccine: string }[]
        ).map((r) => r.vaccine)
      : [];
    // Intake items (supplements/meds) leave notification dedup markers behind on
    // delete; capture each item's dose ids BEFORE its cascade delete removes them, so
    // we can sweep the per-dose escalation markers + the refill marker afterward —
    // the SAME sweep deleteIntakeItem runs, so the two delete paths stay consistent
    // (#328 parity; without this the bulk path stranded escalation markers).
    const isIntakeItem = kind === "intake-item";
    const undoIds: number[] = [];
    const sweeps: { id: number; doseIds: number[] }[] = [];
    for (const id of clean) {
      const doseIds = isIntakeItem ? intakeItemDoseIds(profile.id, id) : [];
      const token = captureDelete(kind, profile.id, id);
      if (token != null) {
        undoIds.push(token);
        if (isIntakeItem) sweeps.push({ id, doseIds });
      }
    }
    for (const { id, doseIds } of sweeps) {
      sweepIntakeItemMarkers(profile.id, id, doseIds);
    }
    afterDelete(key, resolved.policy, profile.id, removedVaccines);
    return { ok: true, deleted: undoIds.length, undoIds };
  }

  const placeholders = clean.map(() => "?").join(",");
  // Capture the vaccine codes about to be un-backed BEFORE the delete — the rows are
  // gone afterward and the sweep needs their pre-images (issue #376). Empty for every
  // non-immunizations dataset.
  const removedVaccines = resolved.policy.cleanupImmunizations
    ? (
        db
          .prepare(
            `SELECT DISTINCT vaccine FROM ${resolved.table} WHERE id IN (${placeholders}) AND profile_id = ?`
          )
          .all(...clean, profile.id) as { vaccine: string }[]
      ).map((r) => r.vaccine)
    : [];
  // Capture the natural-key pre-images of any tombstone-tracked rows BEFORE the
  // delete removes them, so the next rolling-window sync can't resurrect them (#653).
  const tombstoneRows = tombstonePreImages(resolved.table, clean, profile.id);
  // A selected row can be named by a care-plan follow-up too. A dataset whose table
  // has an undo kind returned above, through captureDelete; one that reaches this
  // statement has nothing ahead of it, so the seam runs here. On a NO ACTION pair a
  // missing one is the same rollback "Delete all" hit (#5966), over the checked rows
  // instead of the whole table.
  freeFollowUpLinks(resolved.table, profile.id, clean);
  // Scope the delete to this profile's rows — the whitelisted tables are all
  // profile-owned, so an id belonging to another profile must not be touched.
  const info = db
    .prepare(
      `DELETE FROM ${resolved.table} WHERE id IN (${placeholders}) AND profile_id = ?`
    )
    .run(...clean, profile.id);
  for (const row of tombstoneRows)
    writeImportTombstoneForRow(profile.id, resolved.table, row);

  afterDelete(key, resolved.policy, profile.id, removedVaccines);
  return { ok: true, deleted: info.changes, undoIds: [] };
}

// Delete every row in a dataset's table (the "delete all" action). Same table
// whitelisting as above.
export async function deleteAllDatasetRows(
  key: string
): Promise<
  | { ok: true; deleted: number; undoIds: number[] }
  | { ok: false; error: string }
> {
  const { profile } = await requireWriteAccess();
  const resolved = resolve(key);
  if (!resolved) return { ok: false, error: "Unknown dataset." };

  // One transaction from the first pre-image to the last tombstone: a seam that
  // freed links for a wipe that then failed would otherwise leave them freed.
  const { deleted, removedVaccines, files } = writeTx(() => {
    // Capture the vaccine codes about to be un-backed before wiping the table (#376).
    const removedVaccines = resolved.policy.cleanupImmunizations
      ? (
          db
            .prepare(
              `SELECT DISTINCT vaccine FROM ${resolved.table} WHERE profile_id = ?`
            )
            .all(profile.id) as { vaccine: string }[]
        ).map((r) => r.vaccine)
      : [];
    // Tombstone-tracked rows must survive a wipe as tombstones too, so a re-sync can't
    // resurrect the whole set (#653). Captured before the delete.
    const tombstoneRows = tombstoneAllPreImages(resolved.table, profile.id);
    // A row this wipe removes can be named by a care-plan follow-up (#5409, #5966), and
    // this wipe takes no capture, so captureDelete's seam does not run for it. Run the
    // domain's seam here instead, over this profile's linked rows.
    //
    // WHAT THE SCHEMA DOES INSTEAD DIFFERS BY PAIR, and only one of the two outcomes is
    // survivable. `metric_samples` is ON DELETE SET NULL: the wipe would not throw, it
    // would null the id and leave `source_kind` standing over an all-null source.
    // `medical_records` and `imaging_studies` are NO ACTION, so with foreign keys on the
    // wipe raises SQLITE_CONSTRAINT_FOREIGNKEY and rolls back — a person who tracked one
    // follow-up could not bulk-delete the dataset at all (#5966).
    freeFollowUpLinks(resolved.table, profile.id, null);
    const files = wipedMediaFiles(resolved.table, profile.id);
    // Every other blocking link captureDelete frees per row (#5990).
    freeRowLinks(resolved.table, profile.id);
    // "Delete all" is still scoped to this profile — never wipe another profile's
    // rows from the shared table. It is intentionally NOT undoable (the confirm
    // says so): capturing an entire table into the holding store could be huge.
    const info = db
      .prepare(`DELETE FROM ${resolved.table} WHERE profile_id = ?`)
      .run(profile.id);
    for (const row of tombstoneRows)
      writeImportTombstoneForRow(profile.id, resolved.table, row);
    return { deleted: info.changes, removedVaccines, files };
  });
  // After the commit, as the Trash purge does: a wipe that rolled back keeps its files.
  unlinkPurgedFiles(files);

  afterDelete(key, resolved.policy, profile.id, removedVaccines);
  return { ok: true, deleted, undoIds: [] };
}
