import { db } from "./db";
import { parseHealthRecord } from "./health-record-parse";
import { healthRecordToPersistInput, type PersistInput } from "./import-shape";
import {
  persistDocumentImport,
  applyImportFollowups,
  type PersistOutcome,
} from "./import-persist";
import { getCanonicalVocabulary } from "./queries";
import {
  buildCanonicalIndex,
  snapCanonicalName,
  distinguishVitaminDIsoform,
} from "./canonical-name";
import { createLogger } from "./log";

const log = createLogger("health-import");

// Deterministic (no-AI) ingestion of a portal health-record file — a MyChart
// "Download Summary" (IHE XDM .zip/.xdm or its C-CDA/CCD XML) or a SMART Health
// Card. Format sniffing + parsing is the pure lib/health-record-parse; the
// writes go through the shared persist core (lib/import-persist), the same one
// the AI document extractor uses — so the file is a first-class medical document
// (delete/reprocess just work) and the two paths can't drift.

export { detectHealthRecord } from "./health-record-parse";

const SOURCE_LABEL: Record<string, string> = {
  ccda: "MyChart export (CCD/XDM)",
  "smart-health-card": "SMART Health Card",
  fhir: "FHIR export",
};

export interface HealthImportOutcome {
  status: "done" | "failed";
  immCount: number;
  recCount: number;
  error?: string;
  adoptedBirthdate: string | null;
  adoptedSex: boolean;
}

// Parse the (already-stored) document's buffer and import its immunizations +
// records against the given document row, replacing any prior rows for that
// document so this doubles as the reprocess path. Never throws — parse failures
// are recorded on the row.
export function persistHealthRecordDoc(
  profileId: number,
  docId: number,
  buffer: Buffer
): HealthImportOutcome {
  // Parse + write in one guarded block: parseHealthRecord throws on a bad file,
  // and persistDocumentImport runs in a transaction that rolls back on any error
  // (leaving the doc un-finalized). Either way, mark the row 'failed' and return
  // — never let it escape the caller and strand the row on 'processing'.
  let input: PersistInput;
  let outcome: PersistOutcome;
  try {
    const { parsed, source } = parseHealthRecord(buffer);
    // Snap each parsed record's canonical name onto the app's existing biomarker
    // vocabulary — the same code-level reconciliation the AI path applies — so a
    // CCD/FHIR lab groups under the app's canonical series (and picks up its
    // reference band) instead of coining a duplicate from the portal's spelling.
    // The tiny LOINC map alone covers only a handful of vitals.
    const canonicalIndex = buildCanonicalIndex(getCanonicalVocabulary());
    for (const r of parsed.records) {
      r.canonical = snapCanonicalName(
        distinguishVitaminDIsoform(r.canonical, r.name),
        canonicalIndex
      );
    }
    input = healthRecordToPersistInput(
      parsed,
      source,
      SOURCE_LABEL[source] ?? "Health record"
    );
    outcome = persistDocumentImport(profileId, docId, input);
  } catch (e) {
    const error = e instanceof Error ? e.message : "Could not import the file.";
    db.prepare(
      "UPDATE medical_documents SET extraction_status = 'failed', extraction_error = ? WHERE id = ? AND profile_id = ?"
    ).run(error, docId, profileId);
    return {
      status: "failed",
      immCount: 0,
      recCount: 0,
      error,
      adoptedBirthdate: null,
      adoptedSex: false,
    };
  }

  // Post-commit follow-ups are best-effort: the document is already 'done', so a
  // throw here must NOT flip it back to 'failed' (mirrors the AI path). Log and
  // move on.
  let adoptedBirthdate: string | null = null;
  let adoptedSex = false;
  try {
    const adopted = applyImportFollowups(profileId, {
      demographics: input.demographics,
      canonicalNames: input.canonicalNamesToRegister,
      insertedRecordIds: outcome.insertedRecordIds,
    });
    adoptedBirthdate = adopted.birthdate;
    adoptedSex = adopted.sexAdopted;
  } catch (err) {
    log.error("post-import follow-ups failed (document already imported)", {
      docId,
      err,
    });
  }

  return {
    status: "done",
    immCount: outcome.immCount,
    recCount: outcome.recCount,
    adoptedBirthdate,
    adoptedSex,
  };
}
