import crypto from "node:crypto";
import type { PersistInput } from "./import-shape";

// THE CLINICAL IDENTITY OF A HEALTH-RECORD FILE (issue #1780) — "these are the same
// records, arriving in different packaging."
//
// ── THE HOLE THIS FILLS ──────────────────────────────────────────────────────
//
// Document dedup keys on the CONTENT HASH of the uploaded bytes
// (lib/medical-pipeline/storage.ts::findDedupTarget). That is exactly right for a file a
// person picked twice, and it is structurally incapable of catching the portal case:
//
//   • a portal REGENERATES its export container on every request, so two collections of
//     the identical visit list differ byte for byte (packaging metadata plus a rendered
//     PDF) while every clinical XML document inside is byte-identical;
//   • one person can legitimately be reachable through two portal LOGINS — the account
//     holder on one and a proxy patient on another — and both patient labels bind to one
//     profile, which is correct: they are one person (#1739).
//
// Collect through both and the profile ends up with every encounter, every result and
// every problem attested twice, from two `stored` documents with different hashes. No
// hash over the file can ever collapse them, because the packaging is guaranteed to
// differ and the clinical payload is guaranteed to match.
//
// ── WHY THE ENTRY IDS ARE THE RIGHT KEY ──────────────────────────────────────
//
// The information needed to recognise the two as one set of records is ALREADY stored.
// Every deterministically-imported row carries an `external_id` minted from the source
// record's own id — `ccda:encounter:354198588` — and the same visit exported through two
// different logins carries the same one. Strip the `document:<id>|` namespace
// import-persist adds and the two documents agree exactly, table by table.
//
// That is the idempotency doctrine the rest of the codebase already follows: dedupe on
// NATURAL SOURCE KEYS, not on a digest of the transport. The per-document namespace was
// the only thing preventing the comparison, and it exists for a good reason (see
// import-persist's `scopedExternalId`) — so this module does not remove it. It compares
// the UNNAMESPACED id SET of an OFFERED file against the id sets of documents this
// profile already holds, before anything is stored.
//
// ── WHY A SET HASH, AND WHY EXACT EQUALITY ───────────────────────────────────
//
// One TEXT column (`medical_documents.clinical_key`, migration 136) holding a digest of
// the sorted, de-duplicated id set turns "are these the same records" into the same cheap
// indexed lookup `content_hash` already gets, on the same table, with the same
// per-profile scope. Nothing new to keep consistent.
//
// Equality of the WHOLE set — not overlap, not subset — is deliberate. Refusing an upload
// DISCARDS an offer, so the decision must never be a judgement call: two files match only
// when every clinical entry in one is an entry in the other and vice versa. A partly
// overlapping pair (one export covering a visit the other does not) is NOT a duplicate
// here and is stored, which leaves today's behaviour exactly as it was for that case
// rather than guessing. The issue's own evidence is exact equality (6/6 encounters,
// 36/36 records, 6/6 conditions), and a false positive would lose records.
//
// ── THE MINIMUM-SIZE GUARD ───────────────────────────────────────────────────
//
// A file that yields ONE entry id, or none, has no clinical identity worth trusting: an
// AI-extracted document sets no external_id at all (its rows dedupe by document_id), and
// a near-empty parse would otherwise collapse with every other near-empty parse for the
// profile. Below the floor the key is NULL, which means "not eligible for clinical
// dedup" — never "matches everything". Every consumer treats NULL as no-match.
//
// PURE: no DB, no fs, no network. The DB side (store, look up) lives in
// lib/medical-pipeline/storage.ts; the ingest decision lives in lib/medical-pipeline.ts.

// Fewest distinct entry ids a file must carry before its id set is allowed to stand for
// its clinical identity. Three is the smallest number that cannot be reached by a stray
// singleton section, and every real portal export is orders of magnitude above it.
export const CLINICAL_KEY_MIN_IDS = 3;

// The entity lists of a PersistInput that carry a source-minted `external_id`, paired
// with the prefix their ids are recorded under. The prefix keeps two DIFFERENT kinds of
// entry that happen to share a raw id from colliding — the CCDA namespaces already do
// this (`ccda:encounter:` vs `ccda:obs:`) but a FHIR/SHC parse need not, and the key must
// not depend on a source's naming discipline.
//
// bodyMetrics / heights / headCircs are absent on purpose: they are PROJECTIONS of rows
// that already appear in `records`, they carry no external_id, and counting them would
// add nothing the records list does not already say.
const KEYED_ENTITIES: readonly {
  prefix: string;
  pick: (input: PersistInput) => readonly { external_id: string | null }[];
}[] = [
  { prefix: "rec", pick: (i) => i.records },
  { prefix: "imm", pick: (i) => i.immunizations },
  { prefix: "alg", pick: (i) => i.allergies },
  { prefix: "cnd", pick: (i) => i.conditions },
  { prefix: "enc", pick: (i) => i.encounters },
  { prefix: "prc", pick: (i) => i.procedures },
  { prefix: "fhx", pick: (i) => i.familyHistory },
  { prefix: "cpi", pick: (i) => i.carePlanItems },
  { prefix: "cgl", pick: (i) => i.careGoals },
  { prefix: "gen", pick: (i) => i.genomicVariants ?? [] },
  { prefix: "img", pick: (i) => i.imagingStudies ?? [] },
  { prefix: "opt", pick: (i) => i.opticalPrescriptions ?? [] },
  { prefix: "dnt", pick: (i) => i.dentalProcedures ?? [] },
  { prefix: "apt", pick: (i) => i.appointments },
];

// Every source-minted entry id in a parsed health record, kind-prefixed, de-duplicated
// and sorted — the file's clinical identity as a stable list.
//
// Sorted + de-duplicated so the key depends only on WHICH entries a file carries, never
// on the order a parser walked its sections or on a section repeating an entry. Two
// exports of one visit list therefore agree even if the portal reshuffled them.
export function collectClinicalEntryIds(input: PersistInput): string[] {
  const ids = new Set<string>();
  for (const { prefix, pick } of KEYED_ENTITIES) {
    for (const row of pick(input)) {
      const raw = row.external_id;
      if (raw != null && raw !== "") ids.add(`${prefix}:${raw}`);
    }
  }
  return [...ids].sort();
}

// The digest that stands for that id set, or NULL when the file carries too few entry
// ids to have a trustworthy clinical identity (see the minimum-size guard above).
//
// Callers must treat NULL as "no clinical dedup for this file" — never as a key that can
// match another NULL.
export function clinicalContentKey(ids: readonly string[]): string | null {
  if (ids.length < CLINICAL_KEY_MIN_IDS) return null;
  return crypto.createHash("sha256").update(ids.join("\n")).digest("hex");
}

// Convenience for the two callers that hold a PersistInput: parse → key in one step.
export function clinicalKeyForInput(input: PersistInput): string | null {
  return clinicalContentKey(collectClinicalEntryIds(input));
}

// The reason line a records-duplicate marker carries, and the wording the API hands an
// automated client. Owned here so the Review row, the JSON outcome and the tests quote
// ONE sentence — and phrased to name the DOCUMENT that already holds the records, so a
// person reading Review knows nothing was lost and where the records went.
export function clinicalDuplicateMessage(originalName: string): string {
  return `Duplicate records — every clinical entry in this file was already imported from "${originalName}". Nothing new was stored.`;
}
