// Shared fixture builder for the query smoke tests (lib/__db_tests__). NOT a test
// file (the config only collects *.test.ts), so it's never executed on its own.
//
// It seeds a minimal but cross-domain set of rows for one profile via direct
// inserts (modeled on scripts/seed.ts) and returns the ids, so a test can call a
// representative read from each query module and assert the seeded shape comes
// back. Every value is tagged with a caller-supplied `tag` string so a two-profile
// scoping test can prove profile A's reads never surface profile B's rows.
//
// Importing this pulls in the `db` singleton — which is already redirected at the
// per-file temp DB by lib/__db_tests__/setup.ts (a setupFile that runs before any
// test module loads), so this touches only the throwaway database.

import { db, today } from "@/lib/db";

export interface SeededProfile {
  profileId: number;
  tag: string;
  todayStr: string;
  strengthActivityId: number;
  cardioActivityId: number;
  supplementId: number;
  supplementDoseId: number;
  medicationId: number;
  goalId: number;
  documentId: number;
  carePlanItemId: number;
  glucoseValueNum: number;
  weightKg: number;
  /** A vaccine code carrying a `declined` override, for the immunization read. */
  declinedVaccine: string;
  /** A vaccine code with a seeded dose. */
  dosedVaccine: string;
}

export interface SeedOpts {
  weightKg?: number;
  /** Glucose reading, seeded UNQUALIFIED (the document never stated a fasting
   *  state). That entry is deliberately band-less (#2337), so reconcileFlags derives
   *  NO flag from it at any value — a test that needs a derived out-of-range flag
   *  seeds `Glucose, Fasting` (70–99) instead. */
  glucoseValueNum?: number;
  /** Units on hand for the tracked supplement (default 8 → below the 10-day
   *  low-supply threshold, so the refill read reports "low"). */
  quantityOnHand?: number;
}

// Insert a profile plus a handful of rows across every domain module, returning
// their ids. `tag` is embedded in text columns (titles/names) so scoping asserts
// can distinguish two profiles' rows.
export function seedProfile(tag: string, opts: SeedOpts = {}): SeededProfile {
  const weightKg = opts.weightKg ?? 80;
  const glucoseValueNum = opts.glucoseValueNum ?? 130;
  const quantityOnHand = opts.quantityOnHand ?? 8;
  const declinedVaccine = "hpv";
  const dosedVaccine = "mmr";

  const seed = db.transaction((): SeededProfile => {
    const profileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES (?)").run(tag)
        .lastInsertRowid
    );
    const todayStr = today(profileId);

    // ---- training: a strength session (with sets) + a cardio session ----
    const strengthActivityId = Number(
      db
        .prepare(
          `INSERT INTO activities (profile_id, date, type, title, duration_min)
           VALUES (?, ?, 'strength', ?, 45)`
        )
        .run(profileId, todayStr, `${tag} Strength Day`).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
       VALUES (?, 'Back Squat', 1, 100, 5)`
    ).run(strengthActivityId);
    db.prepare(
      `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
       VALUES (?, 'Back Squat', 2, 100, 5)`
    ).run(strengthActivityId);

    const cardioActivityId = Number(
      db
        .prepare(
          `INSERT INTO activities (profile_id, date, type, title, duration_min, distance_km)
           VALUES (?, ?, 'cardio', ?, 30, 5)`
        )
        .run(profileId, todayStr, `${tag} Run`).lastInsertRowid
    );

    // ---- metrics: a weigh-in + an integration steps sample ----
    db.prepare(
      `INSERT INTO body_metrics (profile_id, date, weight_kg) VALUES (?, ?, ?)`
    ).run(profileId, todayStr, weightKg);
    db.prepare(
      `INSERT INTO metric_samples
         (profile_id, source, metric, date, started_at, ended_at, value)
       VALUES (?, 'health-connect', 'steps', ?, ?, ?, 8000)`
    ).run(profileId, todayStr, `${todayStr}T00:00`, `${todayStr}T23:59`);

    // ---- medical / biomarkers: a Glucose reading (canonical, chartable) +
    //      a star + a source document ----
    db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, value, unit, canonical_name, value_num, panel)
       VALUES (?, ?, 'lab', 'Glucose', ?, 'mg/dL', 'Glucose', ?, 'Metabolic')`
    ).run(profileId, todayStr, String(glucoseValueNum), glucoseValueNum);
    db.prepare(
      `INSERT INTO saved_items (profile_id, kind, key) VALUES (?, 'clinical-result', 'Glucose')`
    ).run(profileId);
    const documentId = Number(
      db
        .prepare(
          `INSERT INTO medical_documents
             (profile_id, filename, stored_path, extraction_status, doc_type)
           VALUES (?, ?, '', 'done', 'lab')`
        )
        .run(profileId, `${tag}-labs.pdf`).lastInsertRowid
    );

    // ---- immunizations: an MMR dose + a declined override on another vaccine ----
    db.prepare(
      `INSERT INTO immunizations (profile_id, date, vaccine, dose_label)
       VALUES (?, '2001-06-01', ?, '1')`
    ).run(profileId, dosedVaccine);
    db.prepare(
      `INSERT INTO immunization_overrides (profile_id, vaccine, kind, reason)
       VALUES (?, ?, 'declined', 'not tracking')`
    ).run(profileId, declinedVaccine);

    // ---- intake: a tracked supplement (with a dose + a taken log) + a medication ----
    const supplementId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, active, kind, condition, obligation, quantity_on_hand, qty_per_dose)
         VALUES (?, ?, 1, 'supplement', 'daily', 'should', ?, 1)`
        )
        .run(profileId, `${tag} Vitamin D`, quantityOnHand).lastInsertRowid
    );
    const supplementDoseId = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses
             (item_id, amount, time_of_day, food_timing, sort)
           VALUES (?, '1 cap', 'morning', 'any', 0)`
        )
        .run(supplementId).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date) VALUES (?, ?, ?)`
    ).run(supplementDoseId, supplementId, todayStr);

    const medicationId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, active, kind, condition, obligation, prescriber)
         VALUES (?, ?, 1, 'medication', 'daily', 'should', 'Dr Who')`
        )
        .run(profileId, `${tag} Lisinopril`).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_item_doses
         (item_id, amount, time_of_day, food_timing, sort)
       VALUES (?, '10 mg', 'morning', 'any', 0)`
    ).run(medicationId);

    // ---- goals: an active freeform goal ----
    const goalId = Number(
      db
        .prepare(
          `INSERT INTO goals (profile_id, title, category, status, archived)
           VALUES (?, ?, 'strength', 'active', 0)`
        )
        .run(profileId, `${tag} Squat 140`).lastInsertRowid
    );

    // ---- care plan: an open, dated care-plan item (issue #84) → a careplan
    //      Upcoming signal. planned_date = today so it lands in the Today band. ----
    const carePlanItemId = Number(
      db
        .prepare(
          `INSERT INTO care_plan_items
             (profile_id, description, category, planned_date, status)
           VALUES (?, ?, 'procedure', ?, 'planned')`
        )
        .run(profileId, `${tag} Colonoscopy`, todayStr).lastInsertRowid
    );

    return {
      profileId,
      tag,
      todayStr,
      strengthActivityId,
      cardioActivityId,
      supplementId,
      supplementDoseId,
      medicationId,
      goalId,
      documentId,
      carePlanItemId,
      glucoseValueNum,
      weightKg,
      declinedVaccine,
      dosedVaccine,
    };
  });

  return seed();
}

// Create a member login granted to `profileId` and point its LOGIN-scoped Telegram
// channel at `chatId` (issue #1072: the chat belongs to the login, and delivery to a
// profile fans out to the logins that manage it). Returns the login id. This is the
// new-model replacement for the old `setProfileTelegram(profileId, …)` fixture: a
// per-profile event now needs a MANAGING LOGIN with an enabled chat to be
// deliverable. `enabled` defaults true; pass false to seed a login whose channel is
// off. Direct SQL for logins/grants (login/global tables), setLoginSetting for the
// channel KV.
export function seedLoginTelegram(
  profileId: number,
  chatId: string,
  opts: { enabled?: boolean; username?: string; role?: "admin" | "member" } = {}
): number {
  const enabled = opts.enabled ?? true;
  const role = opts.role ?? "member";
  const username =
    opts.username ??
    `login_p${profileId}_${chatId}_${Math.random().toString(36).slice(2, 8)}`;
  const loginId = Number(
    db
      .prepare(
        "INSERT INTO logins (username, password_hash, role) VALUES (?, 'x', ?)"
      )
      .run(username, role).lastInsertRowid
  );
  db.prepare(
    "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write') ON CONFLICT(login_id, profile_id) DO NOTHING"
  ).run(loginId, profileId);
  db.prepare(
    "INSERT INTO login_settings (login_id, key, value) VALUES (?, 'telegram_enabled', ?) ON CONFLICT(login_id, key) DO UPDATE SET value = excluded.value"
  ).run(loginId, enabled ? "1" : "0");
  db.prepare(
    "INSERT INTO login_settings (login_id, key, value) VALUES (?, 'telegram_chat_id', ?) ON CONFLICT(login_id, key) DO UPDATE SET value = excluded.value"
  ).run(loginId, chatId);
  return loginId;
}

// One row in `table` belonging to `profileId`, with `values` set by name and every
// other required column filled from the schema (#5117). It exists so a guard over a
// LIST OF SQL ARMS can build its case from the arm itself — the arm names a table and
// a column, and nothing else about the table has to be written down beside the guard,
// so an arm added tomorrow arrives with its case already written.
//
// The fill order is the whole of it: `profile_id` gets the seeded profile, an FK
// column gets an id from its parent (the seeded profile's row, where the parent is
// itself profile-owned — that is how a CHILD table reaches profile_id at all), and
// any other NOT NULL column takes an existing row's value where the table has one,
// which is what satisfies CHECK'd columns such as activities.type, or a plain filler.
//
// Used by lib/__db_tests__/timeline.test.ts (the getTimelineDates UNION arms) and
// lib/__db_tests__/export.test.ts (the PROVIDER_LINK_SELECTS arms). It is a test
// fixture and nothing production reads it.
type SchemaCol = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};
type SchemaFk = { from: string; table: string; to: string };
const pragma = <T>(q: string) => db.pragma(q) as T[];

// The first value a `CHECK (<col> IN ('a','b'))` admits, for a required column with no
// precedent row to copy — the plain "x" filler is refused by those, and an empty table
// is exactly the case a seeder is called for (#5314: preventive_overrides.kind).
function checkedValue(table: string, column: string): string | undefined {
  const ddl =
    (
      db
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(table) as { sql: string } | undefined
    )?.sql ?? "";
  const clause = new RegExp(`\\b${column}\\b\\s+IN\\s*\\(([^)]*)\\)`, "i").exec(ddl);
  return clause ? /'([^']*)'/.exec(clause[1])?.[1] : undefined;
}

// A row of the FK's parent table that BELONGS TO this profile. Directly, when the
// parent carries profile_id; otherwise through the parent's OWN owned parent — a
// grandchild table (intake_dose_schedule_versions → intake_item_doses →
// intake_items) reaches the profile two hops up, and picking any parent row put the
// seeded grandchild under whichever profile happened to be first, so the dataset
// scoped it back out and the row was invisible to the guard it was seeded for
// (#5314). Where no hop reaches profile_id the table is global and any row will do.
function parentRow(
  fk: SchemaFk,
  profileId: number
): { id: number } | undefined {
  const has = (table: string) =>
    pragma<SchemaCol>(`table_info(${table})`).some(
      (c) => c.name === "profile_id"
    );
  if (has(fk.table))
    return db
      .prepare(`SELECT ${fk.to} AS id FROM ${fk.table} WHERE profile_id = ? LIMIT 1`)
      .get(profileId) as { id: number } | undefined;
  const up = pragma<SchemaFk>(`foreign_key_list(${fk.table})`).find((g) =>
    has(g.table)
  );
  if (up)
    return db
      .prepare(
        `SELECT p.${fk.to} AS id FROM ${fk.table} p
           JOIN ${up.table} g ON g.${up.to} = p.${up.from}
          WHERE g.profile_id = ? LIMIT 1`
      )
      .get(profileId) as { id: number } | undefined;
  return db.prepare(`SELECT ${fk.to} AS id FROM ${fk.table} LIMIT 1`).get() as
    | { id: number }
    | undefined;
}

export function seedSchemaRow(
  table: string,
  values: Record<string, unknown>,
  profileId: number
): void {
  const fks = new Map(
    pragma<SchemaFk>(`foreign_key_list(${table})`).map((f) => [f.from, f])
  );
  const row = new Map<string, unknown>(Object.entries(values));
  for (const c of pragma<SchemaCol>(`table_info(${table})`)) {
    if (row.has(c.name)) continue;
    // Before the pk skip: a composite-key table carries profile_id IN its key.
    if (c.name === "profile_id") {
      row.set(c.name, profileId);
      continue;
    }
    if (c.pk) continue;
    const required = c.notnull === 1 && c.dflt_value === null;
    const fk = fks.get(c.name);
    if (fk) {
      const parent = parentRow(fk, profileId);
      if (parent) row.set(c.name, parent.id);
      else if (required)
        throw new Error(`${table}.${c.name}: no ${fk.table} row to point at`);
      continue;
    }
    if (!required) continue;
    const seen = db
      .prepare(
        `SELECT ${c.name} AS v FROM ${table} WHERE ${c.name} IS NOT NULL LIMIT 1`
      )
      .get() as { v: unknown } | undefined;
    row.set(
      c.name,
      seen?.v ??
        checkedValue(table, c.name) ??
        (/INT|REAL|NUM|DOUB|FLOA/i.test(c.type) ? 1 : "x")
    );
  }
  const names = [...row.keys()];
  db.prepare(
    `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`
  ).run(...row.values());
}
