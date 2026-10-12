// UPLOAD DRY RUN — what an upload of this file would do, with nothing written: no stored
// file, no medical_documents or import_jobs row, no model call, no notification.
//
// Runs the ingest engine's own screen (lib/medical-pipeline/screen.ts) and dedup probes,
// then reads — never persists — a health record's visits. AUTH-BLIND: the caller resolves
// the target and the profiles it may read; every statement filters on profile_id.

import { db } from "@/lib/db";
import { readZip } from "@/lib/zip";
import { extractFromCcda, looksLikeCda } from "@/lib/cda/parse";
import {
  parseHealthRecord,
  type HealthRecordKind,
} from "@/lib/health-record-parse";
import type { ImportResult } from "@/lib/health-import";
import { offeredClinicalKey } from "@/lib/medical-pipeline";
import { screenUpload } from "@/lib/medical-pipeline/screen";
import {
  findClinicalDuplicate,
  findDedupTarget,
  heldDocumentPredicate,
} from "@/lib/medical-pipeline/storage";
import { isDocumentTombstoned } from "@/lib/document-tombstones";
import { userErrorCopy } from "@/lib/user-error-copy";

export interface DryRunProfile {
  id: number;
  name: string;
}

// Where the upload would go, and why there.
export interface DryRunTarget extends DryRunProfile {
  decidedBy: string;
}

//   rejected      — refused before storing (size, type, contents); `note` says why
//   duplicate     — the target profile already holds these exact bytes
//   covered       — a health record whose records or visits the profile already has
//   would-import  — a health record with something new
//   would-extract — read by the model on upload; nothing was extracted now
export type DryRunVerdict =
  "rejected" | "duplicate" | "covered" | "would-import" | "would-extract";

export interface DryRunVisit {
  date: string;
  type: string | null;
  status: "covered" | "new";
}

// One clinical document: the file itself, or one CCDA inside an export zip.
export interface DryRunRecord {
  member: string;
  patient: string | null;
  birthdate: string | null;
  visits: DryRunVisit[];
}

export interface DryRunDocument {
  id: number;
  filename: string;
  profile: DryRunProfile;
}

export interface DryRunReport {
  name: string;
  profile: DryRunTarget;
  verdict: DryRunVerdict;
  note: string | null;
  // Held documents with the same bytes, in any profile the caller can read.
  duplicates: DryRunDocument[];
  records: DryRunRecord[];
}

function heldCopies(
  contentHash: string,
  readable: readonly DryRunProfile[]
): DryRunDocument[] {
  const stmt = db.prepare(
    `SELECT id, filename FROM medical_documents
      WHERE profile_id = ? AND content_hash = ? AND ${heldDocumentPredicate()}
      ORDER BY id`
  );
  return readable.flatMap((profile) =>
    (
      stmt.all(profile.id, contentHash) as { id: number; filename: string }[]
    ).map((r) => ({ ...r, profile }))
  );
}

// Each clinical document the file carries. An export zip is split into its CCDAs, so a
// report can say which of them is new; the import itself merges them.
function clinicalDocuments(
  name: string,
  buffer: Buffer,
  kind: HealthRecordKind
): { member: string; parsed: ImportResult }[] {
  if (kind === "xdm") {
    return readZip(buffer)
      .filter((e) => /\.xml$/i.test(e.name))
      .map((e) => ({ member: e.name, xml: e.data.toString("utf8") }))
      .filter((e) => looksLikeCda(e.xml))
      .map((e) => ({ member: e.member, parsed: extractFromCcda(e.xml) }));
  }
  return [{ member: name, parsed: parseHealthRecord(buffer).parsed }];
}

// A visit is covered when any earlier upload imported the same source encounter id. The
// stored id is namespaced per document (`document:<id>|ccda:encounter:…`), so match the
// suffix.
function visitCovered(profileId: number, externalId: string): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM encounters
        WHERE profile_id = ?
          AND (external_id = ? OR substr(external_id, -?) = ?)
        LIMIT 1`
    )
    .get(profileId, externalId, externalId.length + 1, `|${externalId}`);
}

function readRecords(
  profileId: number,
  name: string,
  buffer: Buffer,
  kind: HealthRecordKind
): DryRunRecord[] {
  return clinicalDocuments(name, buffer, kind).map(({ member, parsed }) => ({
    member,
    patient: parsed.demographics?.name ?? null,
    birthdate: parsed.demographics?.birthdate ?? null,
    visits: (parsed.encounters ?? [])
      .map((e) => ({
        date: e.date,
        type: e.type,
        status: visitCovered(profileId, e.external_id)
          ? ("covered" as const)
          : ("new" as const),
      }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  }));
}

export async function dryRunMedicalUpload(
  target: DryRunTarget,
  file: File,
  readable: readonly DryRunProfile[]
): Promise<DryRunReport> {
  const base = {
    name: file.name,
    profile: target,
    note: null,
    duplicates: [],
    records: [],
  };
  const screened = await screenUpload(file);
  if (!screened.ok) {
    return { ...base, verdict: "rejected", note: screened.reason };
  }
  const { buffer, healthKind, contentHash } = screened;
  const duplicates = heldCopies(contentHash, readable);
  const held = findDedupTarget(target.id, contentHash);
  if (held) {
    return {
      ...base,
      verdict: "duplicate",
      note: `Already uploaded as "${held.filename}".`,
      duplicates,
    };
  }
  const deletedNote = isDocumentTombstoned(target.id, contentHash)
    ? "Deleted before. Uploading here restores it; the API refuses it."
    : null;
  if (!healthKind) {
    return { ...base, verdict: "would-extract", note: deletedNote, duplicates };
  }

  let records: DryRunRecord[];
  try {
    records = readRecords(target.id, file.name, buffer, healthKind);
  } catch (err) {
    return {
      ...base,
      verdict: "would-import",
      note: userErrorCopy(err, { doing: "read this record" }),
      duplicates,
    };
  }
  const recordsHolder = findClinicalDuplicate(
    target.id,
    offeredClinicalKey(buffer)
  );
  const visits = records.flatMap((r) => r.visits);
  const covered =
    !!recordsHolder ||
    (visits.length > 0 && visits.every((v) => v.status === "covered"));
  return {
    ...base,
    verdict: covered ? "covered" : "would-import",
    note: recordsHolder
      ? `Every record is already imported from "${recordsHolder.filename}".`
      : deletedNote,
    duplicates,
    records,
  };
}
