import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 123 (issue #1505): collapse `priority` + `as_needed` into ONE
// user-owned field, `obligation` — the storage half of the intake obligation model.
//
// WHY a rename and not an in-place widening. The old model smeared one question —
// "what does the user owe this item?" — across three proxies. `priority`
// (mandatory/high/low) was a within-day SORT ORDER that quietly grew push meaning;
// `as_needed` was a second, orthogonal boolean that ALSO meant "never scheduled-due";
// and `kind` was doing duty for pushability on top of its real job (clinical
// identity). A `low` item that still accrued misses was should-math wearing
// may-semantics, which is incoherent — and no amount of new code on top of the old
// column names would have stopped the old intuition transferring. So the columns are
// RENAMED as the semantics change, simultaneously and deliberately:
//
//     must   — a miss is an incident        (remind + missed-dose escalation)
//     should — a miss is a tracked shortfall (remind, never escalate)
//     may    — there is no expectation       (never pushed; no dueness, no misses)
//
// THE MAPPING, and why each arm is the honest one:
//
//     as_needed = 1  →  may      PRN is definitionally "no expectation on any day".
//                                It is the ORIGINAL may, so it absorbs into the level
//                                rather than surviving beside it. Its amount-only dose
//                                shape (#851), redose interval/max (#798) and prn-max
//                                findings (#1027) now key off `obligation = 'may'`.
//     mandatory      →  must     A miss was already an incident (this is the tier the
//                                `critical` escalation opt-in has always sat inside).
//     high           →  should   The default. A miss is a shortfall worth counting.
//     low            →  may      The user's own "this is optional" — which is exactly
//                                "no expectation". The consequence (may items stop
//                                accruing misses at all) is the point: an item you
//                                declared optional should not be able to fail.
//
// The as_needed arm WINS over the priority arm: a PRN item's priority tag was never
// load-bearing (nothing was ever scheduled-due to prioritize), so `as_needed = 1 AND
// priority = 'mandatory'` is a PRN aspirin, not a must. Ordering the CASE that way is
// the whole reason this is a CASE and not two UPDATEs.
//
// SLOT SURVIVES ON `may` AS AN ACCESS HINT. Nothing about the dose rows changes here:
// a may item keeps whatever `time_of_day` its doses carry, and that string stops
// meaning "due then" and starts meaning "offer it here" — the digest tail, the
// keyboards and quick log scope by it. Magnesium keeps its bedtime hint; aspirin has
// none and is simply always available. That is a READ-side reinterpretation, so there
// is deliberately no dose-row write in this migration.
//
// WHY A REBUILD. SQLite can rename a column in place (ALTER TABLE … RENAME COLUMN),
// but it cannot attach a CHECK to it, cannot drop `as_needed`'s NOT NULL DEFAULT in
// the same breath, and cannot do either atomically with the value remap. The enum is
// worth a real CHECK — this field now decides whether a person gets contacted — so
// the table is rebuilt to its final shape by the standard create → copy → drop →
// rename, exactly like migrations 006 / 090 / 106.
//
// FK / CASCADE SAFETY. `intake_items` is a FK PARENT (intake_item_doses,
// intake_item_logs, intake_item_pairs, medication_courses, administration rows…) and
// a FK CHILD (providers, medical_documents, encounters, medical_records, conditions,
// situations, shared_supplies). The runner applies migrations with foreign_keys
// DISABLED, so the DROP doesn't cascade-wipe the children; they reference the table by
// NAME and follow the RENAME. Ids are preserved by the INSERT…SELECT, so every child
// FK stays resolved. Every nullable link is nulled pre-copy so the re-enabled FK check
// meets a clean graph.
//
// REPLAY SAFETY (the non-version-gated migrate() test wrapper replays up()
// unconditionally): the rebuild short-circuits when the live table already carries the
// `obligation` column. Production runs it exactly once behind the user_version gate.
//
// Profile-AGNOSTIC by design (allowlisted in lib/__tests__/profile-scoping.test.ts):
// a one-shot schema rebuild that copies every column verbatim, never reading one
// profile's data into another's.

// The rebuilt table's FINAL shape: migration 112's shape with `priority` and
// `as_needed` replaced by `obligation`. Every other column/default is unchanged.
// `should` is the DEFAULT — a newly added item is a tracked commitment, not an
// incident-grade one and not an unlogged nice-to-have. (Medications default to `must`
// at the FORM layer, not here: the storage default has to serve both surfaces, and the
// med guardrail is a write-path decision the user can see and confirm.)
const CREATE = `
  CREATE TABLE intake_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL REFERENCES profiles(id),
    name TEXT NOT NULL,
    notes TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    critical INTEGER NOT NULL DEFAULT 0,
    escalate_after_min INTEGER,
    escalate_chat_id TEXT,
    quantity_on_hand REAL,
    qty_per_dose REAL NOT NULL DEFAULT 1,
    kind TEXT NOT NULL DEFAULT 'supplement',
    prescriber TEXT,
    pharmacy TEXT,
    rx_number TEXT,
    document_id INTEGER REFERENCES medical_documents(id),
    source TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    provider_id INTEGER REFERENCES providers(id),
    condition TEXT NOT NULL DEFAULT 'daily',
    obligation TEXT NOT NULL DEFAULT 'should' CHECK (obligation IN ('must','should','may')),
    brand TEXT,
    product TEXT,
    situation TEXT,
    stack TEXT,
    rxcui TEXT,
    rxcui_ingredients TEXT,
    situation_id INTEGER REFERENCES situations(id),
    min_interval_hours REAL CHECK (min_interval_hours IS NULL OR min_interval_hours > 0),
    max_daily_count INTEGER CHECK (max_daily_count IS NULL OR max_daily_count > 0),
    redose_notice INTEGER NOT NULL DEFAULT 0,
    rx INTEGER NOT NULL DEFAULT 0,
    last_fill_size REAL,
    encounter_id INTEGER REFERENCES encounters(id),
    source_record_id INTEGER REFERENCES medical_records(id),
    indication_condition_id INTEGER REFERENCES conditions(id),
    import_key TEXT,
    pause_situation_id INTEGER REFERENCES situations(id),
    supply_id INTEGER REFERENCES shared_supplies(id)
  );`;

const INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_intake_items_document ON intake_items(profile_id, document_id);",
  "CREATE INDEX IF NOT EXISTS idx_intake_items_encounter ON intake_items(profile_id, encounter_id);",
  "CREATE INDEX IF NOT EXISTS idx_intake_items_import_key ON intake_items(profile_id, import_key);",
  "CREATE INDEX IF NOT EXISTS idx_intake_items_indication_condition ON intake_items(profile_id, indication_condition_id);",
  "CREATE INDEX IF NOT EXISTS idx_intake_items_source_record ON intake_items(profile_id, source_record_id);",
  "CREATE INDEX IF NOT EXISTS idx_intake_items_supply ON intake_items(supply_id);",
];

// Nullable link columns → their parent; a dangling value is nulled before the FK'd copy.
const LINKS: { column: string; parent: string }[] = [
  { column: "document_id", parent: "medical_documents" },
  { column: "provider_id", parent: "providers" },
  { column: "situation_id", parent: "situations" },
  { column: "pause_situation_id", parent: "situations" },
  { column: "encounter_id", parent: "encounters" },
  { column: "source_record_id", parent: "medical_records" },
  { column: "indication_condition_id", parent: "conditions" },
  { column: "supply_id", parent: "shared_supplies" },
];

function columnNames(db: Database.Database, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).map((r) => r.name);
}

function rebuildIntakeItems(db: Database.Database): void {
  const cols = new Set(columnNames(db, "intake_items"));
  if (cols.size === 0) return; // partial handle — nothing to converge
  if (cols.has("obligation")) return; // already collapsed — replay no-op

  // Null any dangling nullable link so the deferred FK check at commit can't fail.
  for (const { column, parent } of LINKS) {
    if (!cols.has(column)) continue;
    db.exec(
      `UPDATE intake_items SET ${column} = NULL
         WHERE ${column} IS NOT NULL
           AND ${column} NOT IN (SELECT id FROM ${parent});`
    );
  }

  const scratch = "intake_items__new123";
  db.exec(
    CREATE.replace("CREATE TABLE intake_items (", `CREATE TABLE ${scratch} (`)
  );

  // Every carried-over column except the two being collapsed, in the rebuilt table's
  // order; `obligation` is appended and computed by the CASE.
  const carried = columnNames(db, scratch).filter(
    (c) => c !== "obligation" && cols.has(c)
  );
  const colList = carried.join(", ");
  // The as_needed arm is FIRST on purpose (see the header): PRN wins over whatever
  // priority tag a PRN item happened to carry. An unrecognized legacy priority falls
  // through to `should`, the safe middle — never silently to `may` (which would drop
  // an item off every push surface) and never to `must` (which would start escalating
  // something that never did).
  const obligationExpr = cols.has("as_needed")
    ? `CASE
         WHEN as_needed = 1 THEN 'may'
         WHEN priority = 'mandatory' THEN 'must'
         WHEN priority = 'low' THEN 'may'
         ELSE 'should'
       END`
    : `CASE
         WHEN priority = 'mandatory' THEN 'must'
         WHEN priority = 'low' THEN 'may'
         ELSE 'should'
       END`;

  db.exec(
    `INSERT INTO ${scratch} (${colList}, obligation)
       SELECT ${colList}, ${obligationExpr} FROM intake_items;`
  );
  db.exec(`DROP TABLE intake_items;`);
  db.exec(`ALTER TABLE ${scratch} RENAME TO intake_items;`);
  for (const idx of INDEXES) db.exec(idx);
}

// The AI suggestion queue proposes an obligation for an item that does not exist yet,
// so its column moves in lock-step or an accepted suggestion would write a value the
// rebuilt `intake_items` CHECK rejects. No `as_needed` here (a suggestion never
// proposed a PRN), so the mapping is the priority arm alone. RENAME COLUMN + UPDATE
// rather than a rebuild: this table is neither an FK parent nor CHECK-constrained on
// this column, so there is nothing a rebuild would buy.
function renameSuggestionColumn(db: Database.Database): void {
  const cols = new Set(columnNames(db, "intake_item_suggestions"));
  if (cols.size === 0 || cols.has("obligation")) return;
  if (!cols.has("priority")) return;
  db.exec(
    `ALTER TABLE intake_item_suggestions RENAME COLUMN priority TO obligation;`
  );
  db.exec(
    `UPDATE intake_item_suggestions
        SET obligation = CASE obligation
              WHEN 'mandatory' THEN 'must'
              WHEN 'low' THEN 'may'
              ELSE 'should'
            END;`
  );
}

export function up(db: Database.Database): void {
  // MUST be applied with foreign_keys disabled — the runner and the migrate() test
  // wrapper both toggle it off around migration application (issue #95) so this
  // FK-parent rebuild can drop its table without its children being wiped. Wrapped in
  // one (possibly nested) transaction for atomicity.
  const run = db.transaction(() => {
    rebuildIntakeItems(db);
    renameSuggestionColumn(db);
  });
  run.immediate();
}

export const migration: Migration = {
  id: 123,
  name: "123-intake-obligation",
  up,
};
