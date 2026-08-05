// The ONE representative-row selection (issue #2035), beside its latest-per-group
// sibling.
//
// "Collapse cross-document duplicates to one representative row" is asked by every
// clinical-list surface — the Conditions/Procedures/Family history/Allergies
// managers, Visits, Immunizations, the Biomarkers table, the Timeline, and Search.
// The SQL idiom is always the same window:
//
//   SELECT id FROM (
//     SELECT id, ROW_NUMBER() OVER (
//       PARTITION BY profile_id, <collapse identity>
//       ORDER BY <preference axis>, id DESC
//     ) AS rn
//     FROM <table> WHERE profile_id = ?
//   ) WHERE rn = 1
//
// It was hand-written seven times, and the seventh (immunizations) spelled the
// manual-beats-imported preference DIFFERENTLY — `(source IS NULL OR source NOT LIKE
// 'document:%') DESC` instead of `(document_id IS NULL) DESC`, because that table has
// no document_id column. That is the #2005 defect class exactly: one provenance rule
// spelled two ways. The reuse discipline already existed (lib/timeline.ts and
// lib/queries/search.ts import the constants rather than re-deriving them); only the
// CONSTRUCTION was copy-pasted, which is where an eighth copy drifts.
//
// So the construction is single-sourced here: a registry row per collapse site
// declaring its identity and its preference AXIS (a named variant, never a re-derived
// spelling), and one builder emitting the window. The immunizations divergence is now
// a NAMED axis with its reason attached, not an accident of the fifth copy-paste.
//
// PURE by construction — no `db` import, no query execution. It emits SQL TEXT that
// lib/queries/* interpolates into its own prepared-statement literals, so those
// statements stay literal to the profile-scoping scanner (lib/__tests__/sql-scan.ts
// reads prepared-statement arguments as source text, and every consumer's own literal
// still names `profile_id`). Same discipline as `profileIdsIn` and
// `biomarker_family()`: the helper builds a fragment, the caller keeps the statement.
//
// Its pure counterpart on the ORDERING half of the same question is
// lib/latest-per-group.ts (`latestByGroup` / `isLaterReading`, #944) — the JS
// realization of the `recency` axis below, which the derived-table merge needs
// because it cannot call SQL. The two must stay byte-identical on "who wins", which
// is now one edit rather than nine.

// Which of two rows carrying the SAME collapse identity survives as the
// representative. Every registered site declares exactly ONE of these; the builder
// always appends `id DESC` after it as the universal physical-row tie-break (a proxy
// for the newest upload, since a reprocess re-inserts).
export type PreferenceAxis = "document" | "source" | "recency";

// The SQL for each axis. This is the whole point of the module: the manual-beats-
// imported rule has exactly two legal spellings, and which one a table gets is
// decided by whether it HAS a document_id column — declared, not re-derived.
export const PREFERENCE_SQL: Record<PreferenceAxis, string> = {
  // Manual beats imported, keyed on document_id: a manual entry carries no document
  // (both import paths stamp one), so the user's own row and its edits win over an
  // imported twin. The spelling every table with a document_id column uses.
  document: "(document_id IS NULL) DESC",
  // Manual beats imported, keyed on `source` BECAUSE THIS TABLE HAS NO document_id:
  // immunizations record provenance as a `source` string ('document:<id>' for an
  // extracted row), so the same rule has to read that column instead. Named here so
  // the divergence is a declared variant with its reason attached rather than a
  // second spelling someone has to notice.
  source: "(source IS NULL OR source NOT LIKE 'document:%') DESC",
  // Newest reading wins — the latest-per-group ranking rather than a provenance
  // preference. Byte-identical to the pure `isLaterReading` (lib/latest-per-group.ts)
  // once the builder appends `id DESC`: later date wins, equal date breaks on the
  // higher id.
  recency: "date DESC",
};

export interface RepresentativeSpec {
  // The table the window ranks over.
  table: string;
  // The COLLAPSE IDENTITY: the expressions that, together with profile_id, decide
  // which rows are "the same thing". Copied verbatim from the site that owned them,
  // so the emitted SQL is textually the pre-#2035 statement modulo whitespace.
  partition: readonly string[];
  // The preference axis — exactly one per site.
  prefer: PreferenceAxis;
  // Ranking terms ordered BEFORE the preference axis. Only conditions uses this: an
  // ACTIVE-status row must win the representative slot before the manual/newest
  // tiebreakers (#193), so a resolved same-name twin can never hide an active one.
  // This is a ranking PRECEDENCE, not a second preference axis.
  precede?: readonly string[];
}

// The registry. One row per collapse site, each naming its identity and its axis.
//
// medical_records is absent on purpose and built by the two functions below: its
// partition embeds the runtime `biomarker_family(...)` expression, which lives behind
// lib/queries/medical.ts (a db-importing module). Same builder, same axes — one
// parameter instead of a static row, so this file stays pure.
export const REPRESENTATIVE_SPECS = {
  // Allergies collapse on (substance, reaction, status), all normalized — the same
  // entry stored once per uploaded document (two overlapping CCDs each carrying
  // "Penicillin — hives") collapses to one representative, while a genuinely
  // different reaction or a status change (active vs resolved) stays visible as its
  // own row (conservative identity, like its siblings). The 'sub:'/'rxn:'/'st:'
  // prefixes keep the three namespaces from colliding (#384).
  allergies: {
    table: "allergies",
    partition: [
      "'sub:' || LOWER(TRIM(substance))",
      "'rxn:' || LOWER(TRIM(COALESCE(reaction, '')))",
      "'st:' || COALESCE(status, '')",
    ],
    prefer: "document",
  },
  // Conditions collapse on coded-or-named identity plus LATERALITY, which is
  // IDENTITY, not decoration (#1403/#482): left-knee and right-knee osteoarthritis
  // share a name AND an unspecified ICD-10 code, so without it the two collapse and
  // one side vanishes from the problem list. An unstated side ('') groups with other
  // unstated rows.
  //
  // The active-first `precede` (#193) means that when a same-name twin pair (e.g. a
  // resolved 2015 entry + an active 2023 recurrence of the same uncoded condition)
  // collapses, the SURVIVING representative is the active one — the unfiltered list,
  // Timeline, and Search all show the live problem.
  conditions: {
    table: "conditions",
    partition: [
      `COALESCE(
          'code:' || NULLIF(TRIM(code), ''),
          'name:' || LOWER(TRIM(name))
        )`,
      "'lat:' || COALESCE(laterality, '')",
    ],
    prefer: "document",
    precede: ["(status = 'active') DESC"],
  },
  // Visits collapse on the source system's own encounter id when there is one
  // (stripped of its portal prefix), else on the content tuple (#71).
  encounters: {
    table: "encounters",
    partition: [
      `COALESCE(
          CASE WHEN external_id IS NOT NULL
               THEN substr(external_id, instr(external_id, '|') + 1) END,
          date || '|' || COALESCE(end_date, '') || '|' || COALESCE(type, '')
               || '|' || COALESCE(class_code, '') || '|' || COALESCE(reason, '')
        )`,
    ],
    prefer: "document",
  },
  // Family history collapses on (relative, condition), both normalized. An unknown
  // relation (NULL) groups with other unknown-relation rows for the same condition.
  // The genetic discriminator and the family side join the key (#1407): a maternal
  // grandmother and a paternal one both labeled "Grandmother", or a biological and an
  // adopted parent both labeled "Father", are DIFFERENT relatives with different
  // hereditary weight — collapsing them would silently drop one. Unstated ('') groups
  // with other unstated rows, so nothing that used to collapse stops collapsing.
  family_history: {
    table: "family_history",
    partition: [
      "'rel:' || LOWER(TRIM(COALESCE(relation, '')))",
      "'cond:' || LOWER(TRIM(condition))",
      "'type:' || COALESCE(relation_type, '')",
      "'line:' || COALESCE(lineage, '')",
    ],
    prefer: "document",
  },
  // Immunizations collapse on (vaccine, date, dose label). The `source` axis — not
  // `document` — because this table records provenance as a string and has no
  // document_id column; see PREFERENCE_SQL.source.
  immunizations: {
    table: "immunizations",
    partition: ["vaccine", "date", "COALESCE(dose_label, '')"],
    prefer: "source",
  },
  // Procedures collapse on (coded-or-named identity, performed date). Two procedures
  // with the same name on different dates stay distinct; an undated pair groups
  // together (COALESCE(date,'') treats NULLs as equal).
  procedures: {
    table: "procedures",
    partition: [
      "COALESCE('code:' || NULLIF(TRIM(code), ''), 'name:' || LOWER(TRIM(name)))",
      "COALESCE(date, '')",
    ],
    prefer: "document",
  },
} as const satisfies Record<string, RepresentativeSpec>;

export type RepresentativeSite = keyof typeof REPRESENTATIVE_SPECS;

// medical_records, CONTENT identity (#482/#394): a reading is the SAME reading when
// its family, date, value, value_num and unit all match, so two uploads of one lab
// report collapse — while any difference (most importantly a DIFFERENT value for the
// same date+family, a genuine conflict rather than a dup) puts rows in different
// groups so BOTH stay visible and are never silently merged. value/value_num/unit
// NULLs group together (window PARTITION BY treats NULLs as equal), so a numeric-only
// reading dedups correctly too.
//
// `familyKey` is the caller's `biomarkerFamilyKey()` expression.
export function medicalDedupSpec(familyKey: string): RepresentativeSpec {
  return {
    table: "medical_records",
    partition: [
      `${familyKey} COLLATE NOCASE,
                   date, value, value_num, unit`,
    ],
    prefer: "document",
  };
}

// medical_records, LATEST-per-family: ranks every reading within its biomarker group
// (the #482 family identity, case-insensitively — so the vitamin-D 25-OH variants
// share one current reading) newest-first and keeps rn = 1, the current reading. The
// `recency` axis, i.e. the SQL half of `isLaterReading`.
//
// The caller ranks this over the DE-DUPED id set (passing that membership test as
// `where`), so the "current value" filter and the is_latest marker agree with the
// de-duplicated list: whichever representative dedup kept is the one ranked here.
export function medicalLatestSpec(familyKey: string): RepresentativeSpec {
  return {
    table: "medical_records",
    partition: [`${familyKey} COLLATE NOCASE`],
    prefer: "recency",
  };
}

// The ORDER BY of the representative window: any precedence terms, then the site's
// declared preference axis, then the universal `id DESC` tie-break.
export function representativeOrderBy(spec: RepresentativeSpec): string {
  return [...(spec.precede ?? []), PREFERENCE_SQL[spec.prefer], "id DESC"].join(
    ", "
  );
}

// The representative-id subquery for a site: `SELECT id FROM (…) WHERE rn = 1`, one
// row per collapse identity. Binds ONE `?` (profile_id), plus whatever `where` adds.
//
// `where` is an extra AND-ed condition pushed INTO the inner FROM, so the
// representative is chosen from ONLY the matching rows. Two callers use it, both for
// reasons that must not be moved outside the window:
//   • getConditions' status filter (#193, option (c)) — a filtered view then can't be
//     emptied by a representative the filter would exclude while a matching twin
//     exists.
//   • the medical LATEST CTE ranking over the deduped id set.
// It is SQL text, never user input: callers pass a constant or a `?` placeholder.
export function representativeIds(
  spec: RepresentativeSpec,
  opts: { where?: string } = {}
): string {
  const where = opts.where ? ` AND ${opts.where}` : "";
  return `
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY profile_id,
        ${spec.partition.join(",\n        ")}
      ORDER BY ${representativeOrderBy(spec)}
    ) AS rn
    FROM ${spec.table} WHERE profile_id = ?${where}
  ) WHERE rn = 1`;
}

// The same subquery as a named CTE, for the callers that reference it more than once
// in a statement (`WITH deduped AS (…)`, then `id IN (SELECT id FROM deduped)`).
export function representativeCte(
  name: string,
  spec: RepresentativeSpec,
  opts: { where?: string } = {}
): string {
  return `${name} AS (${representativeIds(spec, opts)}
)`;
}

// The membership test against a named representative CTE: "this row is the surviving
// representative of its identity".
export function inRepresentativeCte(name: string): string {
  return `id IN (SELECT id FROM ${name})`;
}
