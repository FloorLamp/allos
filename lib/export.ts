import { db } from "./db";
import { revalidateTarget, type RevalidateTarget } from "./revalidate";
import { summarizeExercise, type SetRow } from "./training-log-format";
import { baseLiftName } from "./lifts";
import { toCsv } from "./csv";

// Re-exported so existing importers (`@/lib/export`) keep working; the pure
// implementation lives in lib/csv.ts for isolated unit testing.
export { toCsv };

// Datasets exposed on the Data → Export tab. Each is a flat table with a stable
// column order used for both the on-screen preview and the CSV download. Every
// row also carries an `id` (the primary key of `table`) — not shown in `columns`
// or the CSV, but used by the management UI to select and delete rows.
//
// WHAT MAKES A COLUMN EXPORTABLE (#5117). Every column of a table that has a
// dataset here is exported, unless it is named in COLUMN_EXPORT_ALLOWLIST in
// lib/__db_tests__/export-completeness.test.ts with the reason a migrating family
// is not losing health data by its absence. That is the rule `bundle_id` was
// missing for four datasets — the export CARRIES provenance, and precedent is not
// a decision.
//
// THERE IS A THIRD CASE AND IT IS NOT ONE YOU ARGUE FOR (#5342): a table that ALSO
// feeds the FHIR passport is carved out of the column guard, which reads flat
// SELECTs and cannot read what a FHIR builder emits. Neither option above applies
// there — an allowlist entry for its column is what reds, telling its author to
// remove the entry they just added. Membership is FHIR_INPUT_TABLES, derived where
// the passport input is declared, not a second list.
// The Data page shows PAGE_SIZE rows per dataset table; the same size drives the
// bounded `page()` reads below so a visit ships one page, not the whole table
// (issue #113 — /data used to serialize every dataset in full).
export const PAGE_SIZE = 25;

// A CSV cell no SELECT produces: built after the read by the function itself.
export type JsBuiltCell = {
  column: string;
  // THE function that puts the cell on the row — the reference, not its name
  // (#5324). A name could answer to nothing, which cost two guards: a source-text
  // read of this file for a matching declaration, and a regex over the stringified
  // reader. A reference cannot, so both are gone and the behavioural claim is what
  // remains (lib/__db_tests__/export.test.ts): the cell is on every row, not
  // `undefined`.
  by: (...args: never[]) => unknown;
  why: string;
};

// The token above. `unique symbol`, module-private, and minted in exactly one place
// (tableDataset, below) — that is the whole of the brand.
const SELECT_BOUND: unique symbol = Symbol("export-dataset-reads-select");

export interface ExportDataset {
  key: string;
  label: string;
  // Underlying table whose primary key `id` identifies each row for deletion.
  table: string;
  columns: string[];
  // The profile-scoped SELECT this dataset's rows come from, complete through its
  // ORDER BY. It is here so the column-completeness guard
  // (lib/__db_tests__/export-completeness.test.ts) can prepare it and let SQLite
  // attribute every emitted column back to its origin table + column, instead of
  // reading this file's source text. A dataset that folds a CHILD table into a
  // summary cell gives the PARENT select here; the child's coverage is argued
  // against its own dataset (or the guard's column allowlist).
  //
  // WHAT `page()` DOES TO IT, exactly — the earlier wording ("page only appends
  // LIMIT/OFFSET") was not true of all three hand-authored datasets:
  //   - tableDataset() datasets, `activities` and `intake_items`: page() prepares
  //     `<select> LIMIT ? OFFSET ?` and nothing else.
  //   - `providers`: the declared select carries ONE `?` standing in for the
  //     runtime `IN (…)` id list, and page() slices the ordered rows in JS rather
  //     than running a bounded statement.
  // A declaration is not a binding, so it is not left as one: the seeded key
  // comparison in lib/__db_tests__/export.test.ts asserts that what rows() and
  // page() actually emit is exactly what this statement selects.
  select: string;
  // STAMPED BY tableDataset() AND BY NOTHING ELSE (#5341): this dataset's
  // rows()/page() ARE q(select)/qPage(select), so the export runs the declared
  // statement by construction. It used to be `readsSelect?: true`, a property a
  // dataset could assert about ITSELF — which deleted it from the guard watching
  // it. The key is a module-private `unique symbol` now, unspellable outside this
  // file. A dataset that hand-writes its reads (`providers`) cannot carry it and is
  // proven bound by the seeded key comparison instead.
  readonly [SELECT_BOUND]?: true;
  // Cells this dataset's rows()/page() BUILD IN JS after the read — a child-table
  // roll-up the parent select cannot fold into a column. They are in `columns` (so
  // the CSV ships them) and in no `select`, which is otherwise exactly the shape of a
  // header column with an empty cell on every row.
  //
  // Declaring one is a claim with two halves, and both are checked:
  // lib/__db_tests__/export-completeness.test.ts asserts the column really is absent
  // from the select; lib/__db_tests__/export.test.ts asserts the cell is EMITTED,
  // non-undefined, on a seeded row. A third half was a guard until tableDataset's
  // parameter type took it: `shape` and `jsBuilt` arrive together or not at all.
  jsBuilt?: JsBuiltCell[];
  // FULL dataset — every row, unbounded. Used ONLY by the export routes
  // (/api/export/*), which stream/serialize the complete table. The Data page
  // must NOT call this (it's the 22.5 MB / 2.1 s stall in #113); it reads the
  // bounded `count` + `page` below instead.
  rows: (profileId: number) => Record<string, unknown>[];
  // Total row count for the on-screen pager (a cheap COUNT(*), no materialization).
  count: (profileId: number) => number;
  // One bounded page (LIMIT/OFFSET) for the on-screen table — the only per-row
  // data the /data render ships.
  page: (
    profileId: number,
    limit: number,
    offset: number
  ) => Record<string, unknown>[];
  // Whether the manage UI offers row deletion. Defaults to true. Set false for
  // datasets that are export/browse-only because they don't fit the id + profile_id
  // delete model: child tables reached through a parent (intake dose schedule and
  // adherence log — the parent supplement/medication is the deletable unit) and
  // rows with a composite key rather than a single `id` (hr_minutes). These still
  // count, browse, and download as CSV — only the delete affordance is hidden, and
  // they are intentionally absent from the manage-actions delete policy.
  deletable?: boolean;
}

// Whether tableDataset() built this dataset, for the guards that used to read a
// hand-writable boolean off it.
export const readsSelect = (ds: ExportDataset): boolean => SELECT_BOUND in ds;

// Each dataset query is scoped to the caller's profile; the export route passes
// the session's active profile id.
const q =
  (sql: string) =>
  (profileId: number): Record<string, unknown>[] =>
    db.prepare(sql).all(profileId) as Record<string, unknown>[];

// Bounded page reader for a plain q() SELECT: `sql` must be complete through its
// ORDER BY, and LIMIT/OFFSET are appended so the Data page fetches only the page
// it displays. The profile filter is identical to q()'s, so the same scoping
// guarantee holds (the interpolated `${sql}` carries the WHERE profile_id = ?).
const qPage =
  (sql: string) =>
  (
    profileId: number,
    limit: number,
    offset: number
  ): Record<string, unknown>[] =>
    db
      .prepare(`${sql} LIMIT ? OFFSET ?`)
      .all(profileId, limit, offset) as Record<string, unknown>[];

// COUNT(*) for the pager. `sql` is a full COUNT statement taking the profile id;
// it is passed to db.prepare through the same `sql` param (source-scan allowlisted)
// and the literal count SQL each caller supplies filters profile_id.
const qCount =
  (sql: string) =>
  (profileId: number): number =>
    Number((db.prepare(sql).get(profileId) as { n: number }).n);

// Assemble a dataset backed by a single profile-scoped SELECT (complete through
// ORDER BY): full export via rows(), bounded display via page(), total via
// count(). `countSql` is a COUNT over the same FROM/WHERE (child datasets pass a
// JOINed COUNT so it still filters the parent's profile_id).
//
// `shape` is the JS step a dataset that folds a CHILD table needs (#5324). It runs
// on whatever the declared statement returned — full read and bounded page alike,
// so the two shape identically by construction — and it is the ONLY way to get one,
// which is why `activities` and `intake_items` no longer hand-write their readers.
//
// `shape` AND `jsBuilt` TRAVEL TOGETHER, in the type: a dataset with no JS step
// declaring a JS-built cell is not a claim that turned out false but one that could
// never be true, shipping an empty CSV column. That was a guard; it is now
// unrepresentable.
type ShapeHook<T> = (rows: T[], profileId: number) => Record<string, unknown>[];

function tableDataset<
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  cfg: {
    key: string;
    label: string;
    table: string;
    columns: string[];
    select: string;
    countSql: string;
    deletable?: boolean;
  } & (
    | { shape: ShapeHook<T>; jsBuilt: JsBuiltCell[] }
    | { shape?: never; jsBuilt?: never }
  )
): ExportDataset {
  const read = q(cfg.select);
  const readPage = qPage(cfg.select);
  const shape = cfg.shape;
  return {
    key: cfg.key,
    label: cfg.label,
    table: cfg.table,
    columns: cfg.columns,
    select: cfg.select,
    jsBuilt: cfg.jsBuilt,
    [SELECT_BOUND]: true,
    deletable: cfg.deletable,
    rows: shape
      ? (profileId) => shape(read(profileId) as T[], profileId)
      : read,
    page: shape
      ? (profileId, limit, offset) =>
          shape(readPage(profileId, limit, offset) as T[], profileId)
      : readPage,
    count: qCount(cfg.countSql),
  };
}

type ActivityRow = {
  id: number;
  date: string;
  type: string;
  title: string;
  duration_min: number | null;
  distance_km: number | null;
  intensity: string | null;
  // Telemetry the display projection used to drop (#466) — Strava/device numerics.
  start_time: string | null;
  end_time: string | null;
  avg_hr: number | null;
  max_hr: number | null;
  elevation_m: number | null;
  avg_power_w: number | null;
  avg_cadence: number | null;
  kilojoules: number | null;
  est_calories: number | null;
  workout_type: string | null;
  source: string | null;
  external_id: string | null;
  notes: string | null;
};
type ActivitySet = SetRow & { activity_id: number; exercise: string };

// The activities read, carrying the full device/Strava telemetry rather than the
// display projection (#466). One statement, run by q()/qPage() through
// tableDataset like every other dataset's.
const ACTIVITIES_SELECT = `SELECT id, date, type, title, duration_min, distance_km, intensity,
          start_time, end_time, avg_hr, max_hr, elevation_m, avg_power_w, avg_cadence,
          kilojoules, est_calories, workout_type, source, external_id, notes
     FROM activities WHERE profile_id = ? ORDER BY date DESC, id DESC`;

// The exercise sets of the given activities, scoped to the profile through the
// activities JOIN. ONE statement for both readers — the full export passes every
// activity's id, the Data page passes the 25 it is showing — and the id list rides a
// single bound parameter as JSON, so this is a complete literal the profile-scoping
// scan reads directly. It used to be a const plus two interpolations, which that
// scan cannot see through and silently skipped (#5323).
const activitySets = (
  profileId: number,
  activityIds: number[]
): ActivitySet[] =>
  db
    .prepare(
      `SELECT s.activity_id, s.exercise, s.set_number, s.weight_kg, s.reps,
              s.weight_kg_right, s.reps_right, s.duration_sec, s.duration_sec_right
         FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
        WHERE a.profile_id = ? AND s.activity_id IN (SELECT value FROM json_each(?))
        ORDER BY s.activity_id, s.exercise, s.set_number`
    )
    .all(profileId, JSON.stringify(activityIds)) as ActivitySet[];

// Fold each activity's exercise_sets into a compact `exercises` summary using the
// shortened (base) lift name. Shared by the full export (rows) and the bounded page
// reader so both shape rows identically.
function shapeActivities(
  acts: ActivityRow[],
  sets: ActivitySet[]
): Record<string, unknown>[] {
  const byAct = new Map<number, ActivitySet[]>();
  for (const s of sets) {
    const list = byAct.get(s.activity_id);
    if (list) list.push(s);
    else byAct.set(s.activity_id, [s]);
  }

  return acts.map((a) => {
    const aSets = byAct.get(a.id) ?? [];
    // Group by exercise, preserving first-seen order.
    const order: string[] = [];
    const groups = new Map<string, SetRow[]>();
    for (const s of aSets) {
      let g = groups.get(s.exercise);
      if (!g) {
        g = [];
        groups.set(s.exercise, g);
        order.push(s.exercise);
      }
      g.push(s);
    }
    const exercises = order
      .map(
        (name) =>
          `${baseLiftName(name)} ${summarizeExercise(groups.get(name)!, "kg").text}`
      )
      .join("; ");
    return {
      id: a.id,
      date: a.date,
      type: a.type,
      title: a.title,
      exercises,
      duration_min: a.duration_min,
      distance_km: a.distance_km,
      intensity: a.intensity,
      start_time: a.start_time,
      end_time: a.end_time,
      avg_hr: a.avg_hr,
      max_hr: a.max_hr,
      elevation_m: a.elevation_m,
      avg_power_w: a.avg_power_w,
      avg_cadence: a.avg_cadence,
      kilojoules: a.kilojoules,
      est_calories: a.est_calories,
      workout_type: a.workout_type,
      source: a.source,
      external_id: a.external_id,
      notes: a.notes,
    };
  });
}

type DoseRow = {
  item_id: number;
  amount: string | null;
  time_of_day: string | null;
  food_timing: string | null;
};

// Parent intake_items read (supplements + medications), complete through its ORDER
// BY: q()/qPage() run it for the full export and the bounded page alike.
//
// `, id` is what makes that sentence true. `ORDER BY name` alone is not a TOTAL
// order — two items a family named the same way (two brands of one supplement) tie —
// and LIMIT/OFFSET slices whatever permutation the engine chose for that call, so the
// Data page can show one row on two pages and never show another. A total order
// removes the question rather than adding a test for it; nothing local can falsify
// the old spelling, because SQLite happens to return rowid order for this plan.
const ITEMS_SELECT = `SELECT id, name, kind, brand, product, condition, obligation, situation,
          stack, active, critical, prescriber, pharmacy, rx_number,
          quantity_on_hand, notes
   FROM intake_items WHERE profile_id = ? ORDER BY name, id`;
// The dose rows of the given items, scoped to the profile through the intake_items
// JOIN — the activities/exercise_sets shape one domain over, and one literal
// statement for the same reason.
const itemDoses = (profileId: number, itemIds: number[]): DoseRow[] =>
  db
    .prepare(
      `SELECT d.item_id, d.amount, d.time_of_day, d.food_timing
         FROM intake_item_doses d JOIN intake_items ii ON ii.id = d.item_id
        WHERE ii.profile_id = ? AND d.item_id IN (SELECT value FROM json_each(?))
        ORDER BY ii.name, d.sort, d.id`
    )
    .all(profileId, JSON.stringify(itemIds)) as DoseRow[];

// Fold each item's dose rows into a readable `schedule` summary. Shared by the
// full export (rows) and the bounded page reader.
function shapeSupplements(
  items: Record<string, unknown>[],
  doses: DoseRow[]
): Record<string, unknown>[] {
  const byItem = new Map<number, string[]>();
  for (const d of doses) {
    const time = (d.time_of_day ?? "").trim();
    const amount = (d.amount ?? "").trim();
    // 'any' is the schema default and carries no information — omit it.
    const food =
      d.food_timing && d.food_timing !== "any" ? d.food_timing.trim() : "";
    let piece = time && amount ? `${time} × ${amount}` : time || amount;
    if (food) piece = piece ? `${piece} (${food})` : food;
    if (!piece) continue; // fully empty dose row contributes nothing
    const list = byItem.get(d.item_id);
    if (list) list.push(piece);
    else byItem.set(d.item_id, [piece]);
  }

  return items.map((it) => ({
    ...it,
    schedule: (byItem.get(it.id as number) ?? []).join("; "),
  }));
}

// The `providers` registry is a GLOBAL (instance-shared) table, not profile-owned —
// but every exported clinical row's `provider_id`/`location_provider_id` dangles
// without it (#465). So this dataset exports exactly the providers REFERENCED by the
// active profile's rows: the id-gathering SELECTs are each profile-scoped (owned
// tables), and the final providers read is by id only. Browse/export-only (deleting a
// shared provider would affect other profiles), so no DELETE_POLICY entry.
//
// Exported because these arms ARE the profile filter on a global table, and the
// profile-scoping scan cannot read them — `referencedProviderIds` prepares a loop
// variable. lib/__db_tests__/export.test.ts builds one case per arm out of this very
// array, so an arm cannot enter the walk without entering the guard (#5117).
export const PROVIDER_LINK_SELECTS = [
  `SELECT provider_id AS pid FROM encounters WHERE profile_id = ? AND provider_id IS NOT NULL`,
  `SELECT location_provider_id AS pid FROM encounters WHERE profile_id = ? AND location_provider_id IS NOT NULL`,
  `SELECT provider_id AS pid FROM procedures WHERE profile_id = ? AND provider_id IS NOT NULL`,
  `SELECT provider_id AS pid FROM appointments WHERE profile_id = ? AND provider_id IS NOT NULL`,
  `SELECT provider_id AS pid FROM care_plan_items WHERE profile_id = ? AND provider_id IS NOT NULL`,
  `SELECT provider_id AS pid FROM immunizations WHERE profile_id = ? AND provider_id IS NOT NULL`,
  `SELECT provider_id AS pid FROM medical_records WHERE profile_id = ? AND provider_id IS NOT NULL`,
  `SELECT provider_id AS pid FROM intake_items WHERE profile_id = ? AND provider_id IS NOT NULL`,
  `SELECT provider_id AS pid FROM dental_procedures WHERE profile_id = ? AND provider_id IS NOT NULL`,
  `SELECT provider_id AS pid FROM skin_lesions WHERE profile_id = ? AND provider_id IS NOT NULL`,
];

function referencedProviderIds(profileId: number): number[] {
  const ids = new Set<number>();
  for (const sql of PROVIDER_LINK_SELECTS) {
    for (const row of db.prepare(sql).all(profileId) as { pid: number }[]) {
      if (row.pid != null) ids.add(row.pid);
    }
  }
  return [...ids].sort((a, b) => a - b);
}

const PROVIDER_COLUMNS = [
  "name",
  "type",
  "npi",
  "identifier",
  "phone",
  "address",
];

// The providers read, parameterised by its `IN (...)` placeholder list: one row per
// provider some exported record actually references. `providersSelect("?")` is the
// dataset's `select` — the same statement with ONE placeholder standing for the
// runtime id list — so the guard reads the columns this function emits rather than a
// copy that can drift from it. This dataset's page() slices those ordered rows in JS
// (the id list, not a LIMIT, is what bounds the read), which is why it does not carry
// the `readsSelect` marker and is proven bound by export.test.ts instead.
const providersSelect = (placeholders: string) =>
  `SELECT id, name, type, npi, identifier, phone, address
         FROM providers WHERE id IN (${placeholders}) ORDER BY name, id`;

function providerRows(profileId: number): Record<string, unknown>[] {
  const ids = referencedProviderIds(profileId);
  if (ids.length === 0) return [];
  const ph = ids.map(() => "?").join(",");
  return db.prepare(providersSelect(ph)).all(...ids) as Record<
    string,
    unknown
  >[];
}

const providersDataset: ExportDataset = {
  key: "providers",
  label: "Providers",
  table: "providers",
  deletable: false,
  columns: PROVIDER_COLUMNS,
  select: providersSelect("?"),
  rows: providerRows,
  count: (profileId) => referencedProviderIds(profileId).length,
  page: (profileId, limit, offset) =>
    providerRows(profileId).slice(offset, offset + limit),
};

export const DATASETS: ExportDataset[] = [
  tableDataset<ActivityRow>({
    // Activities and their exercise sets combined: one row per activity, with an
    // `exercises` summary that folds in the sets using the shortened (base) lift
    // name (e.g. "Barbell Bench Press" -> "Bench Press") and a compact per-set
    // summary. Cardio/sport rows simply have an empty `exercises` cell.
    key: "activities",
    label: "Activities",
    table: "activities",
    select: ACTIVITIES_SELECT,
    countSql: `SELECT COUNT(*) AS n FROM activities WHERE profile_id = ?`,
    shape: (acts, profileId) =>
      shapeActivities(
        acts,
        activitySets(
          profileId,
          acts.map((a) => a.id)
        )
      ),
    jsBuilt: [
      {
        column: "exercises",
        by: shapeActivities,
        why: "the activity's exercise_sets folded into one prose summary — a child-table roll-up, not a column of activities. The sets themselves export in full via the exercise_sets dataset.",
      },
    ],
    columns: [
      "date",
      "type",
      "title",
      "exercises",
      "duration_min",
      "distance_km",
      "intensity",
      "start_time",
      "end_time",
      "avg_hr",
      "max_hr",
      "elevation_m",
      "avg_power_w",
      "avg_cadence",
      "kilojoules",
      "est_calories",
      "workout_type",
      "source",
      "external_id",
      "notes",
    ],
  }),
  tableDataset({
    // Per-set strength numerics (weight/reps/target/to-failure/equipment) — the raw
    // data behind the activities `exercises` prose summary, which existed NOWHERE in
    // any export before (#466). A child of activities (JOINed via a.profile_id), so
    // browse/export-only.
    key: "exercise_sets",
    label: "Exercise sets",
    table: "exercise_sets",
    deletable: false,
    columns: [
      "date",
      "activity",
      "exercise",
      "set_number",
      "weight_kg",
      "reps",
      "weight_kg_right",
      "reps_right",
      "duration_sec",
      "duration_sec_right",
      "target_reps",
      "to_failure",
      "equipment_id",
    ],
    select: `SELECT s.id, a.date, a.title AS activity, s.exercise, s.set_number,
              s.weight_kg, s.reps, s.weight_kg_right, s.reps_right, s.duration_sec,
              s.duration_sec_right, s.target_reps, s.to_failure, s.equipment_id
       FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
       WHERE a.profile_id = ?
       ORDER BY a.date DESC, s.activity_id DESC, s.exercise, s.set_number`,
    countSql: `SELECT COUNT(*) AS n
       FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
       WHERE a.profile_id = ?`,
  }),
  tableDataset({
    // GPS route polylines (#569) — the encoded shape behind an activity's route
    // card. A child of activities (JOINed via a.profile_id), so browse/export-only.
    key: "activity_routes",
    label: "Activity routes",
    table: "activity_routes",
    deletable: false,
    columns: [
      "date",
      "activity",
      "polyline",
      "start_lat",
      "start_lng",
      "end_lat",
      "end_lng",
      "source",
    ],
    select: `SELECT r.id, a.date, a.title AS activity, r.polyline,
              r.start_lat, r.start_lng, r.end_lat, r.end_lng, r.source
       FROM activity_routes r JOIN activities a ON a.id = r.activity_id
       WHERE a.profile_id = ?
       ORDER BY a.date DESC, r.activity_id DESC`,
    countSql: `SELECT COUNT(*) AS n
       FROM activity_routes r JOIN activities a ON a.id = r.activity_id
       WHERE a.profile_id = ?`,
  }),
  tableDataset({
    key: "activity_telemetry",
    label: "Activity telemetry",
    table: "activity_telemetry",
    deletable: false,
    columns: [
      "activity_id",
      "source",
      "streams_json",
      "ftp_w",
      "heart_rate_zones_json",
      "power_zones_json",
      "snapshot_at",
    ],
    select: `SELECT id, activity_id, source, streams_json, ftp_w,
                    heart_rate_zones_json, power_zones_json, snapshot_at
               FROM activity_telemetry
              WHERE profile_id = ? ORDER BY activity_id DESC`,
    countSql:
      "SELECT COUNT(*) AS n FROM activity_telemetry WHERE profile_id = ?",
  }),
  tableDataset({
    key: "activity_laps",
    label: "Activity laps",
    table: "activity_laps",
    deletable: false,
    columns: [
      "activity_id",
      "source",
      "external_id",
      "lap_index",
      "name",
      "distance_m",
      "moving_time_sec",
      "elapsed_time_sec",
      "start_index",
      "end_index",
      "elevation_gain_m",
      "average_speed_mps",
      "max_speed_mps",
      "average_cadence",
      "average_watts",
      "average_heartrate",
      "max_heartrate",
    ],
    select: `SELECT id, activity_id, source, external_id, lap_index, name,
                    distance_m, moving_time_sec, elapsed_time_sec, start_index,
                    end_index, elevation_gain_m, average_speed_mps, max_speed_mps,
                    average_cadence, average_watts, average_heartrate, max_heartrate
               FROM activity_laps
              WHERE profile_id = ? ORDER BY activity_id DESC, lap_index`,
    countSql: "SELECT COUNT(*) AS n FROM activity_laps WHERE profile_id = ?",
  }),
  tableDataset({
    key: "activity_segment_efforts",
    label: "Activity segment efforts",
    table: "activity_segment_efforts",
    deletable: false,
    columns: [
      "activity_id",
      "source",
      "external_id",
      "segment_id",
      "name",
      "distance_m",
      "moving_time_sec",
      "elapsed_time_sec",
      "start_index",
      "end_index",
      "average_cadence",
      "average_watts",
      "average_heartrate",
      "max_heartrate",
      "pr_rank",
      "kom_rank",
    ],
    select: `SELECT id, activity_id, source, external_id, segment_id, name,
                    distance_m, moving_time_sec, elapsed_time_sec, start_index,
                    end_index, average_cadence, average_watts,
                    average_heartrate, max_heartrate, pr_rank, kom_rank
               FROM activity_segment_efforts
              WHERE profile_id = ? ORDER BY activity_id DESC, start_index`,
    countSql:
      "SELECT COUNT(*) AS n FROM activity_segment_efforts WHERE profile_id = ?",
  }),
  tableDataset({
    key: "body_metrics",
    label: "Body metrics",
    table: "body_metrics",
    // source + edited carry provenance (which integration wrote it, whether a hand
    // edit locked it) that the export used to drop (#466); bundle_id says which rows
    // one act wrote (#5117). Nothing writes body_metrics.bundle_id yet, so it is
    // empty on every row until one does — manifest.json says so (#5273).
    columns: [
      "date",
      "weight_kg",
      "body_fat_pct",
      "resting_hr",
      "source",
      "edited",
      "notes",
      "bundle_id",
    ],
    select: `SELECT id, date, weight_kg, body_fat_pct, resting_hr, source, edited, notes,
              bundle_id
       FROM body_metrics WHERE profile_id = ? ORDER BY date DESC`,
    countSql: `SELECT COUNT(*) AS n FROM body_metrics WHERE profile_id = ?`,
  }),
  tableDataset({
    key: "medical_records",
    label: "Clinical results & records",
    table: "medical_records",
    columns: [
      "date",
      "category",
      "name",
      "canonical_name",
      "value",
      "value_num",
      "unit",
      "reference_range",
      "flag",
      "panel",
      "source",
      "document_id",
      "edited",
      "notes",
    ],
    select: `SELECT id, date, category, name, canonical_name, value, value_num,
              unit, reference_range, flag, panel, source, document_id, edited, notes
       FROM medical_records WHERE profile_id = ? ORDER BY date DESC, id DESC`,
    countSql: `SELECT COUNT(*) AS n FROM medical_records WHERE profile_id = ?`,
  }),
  tableDataset({
    // Correction lineage (#1404): a reading's prior values as they stood before a
    // re-import overwrote them ('corrected'/'amended' results). History undo
    // already preserves; export must not silently drop (#2129). A child of
    // medical_records (JOINed via mr.profile_id), so browse/export-only — the
    // parent reading is the deletable unit.
    key: "medical_record_revisions",
    label: "Record revisions",
    table: "medical_record_revisions",
    deletable: false,
    columns: [
      "record",
      "date",
      "value",
      "value_num",
      "unit",
      "reference_range",
      "flag",
      "result_status",
      "superseded_by_status",
      "source",
      "superseded_at",
    ],
    select: `SELECT rv.id, mr.name AS record, rv.date, rv.value, rv.value_num,
              rv.unit, rv.reference_range, rv.flag, rv.result_status,
              rv.superseded_by_status, rv.source, rv.superseded_at
       FROM medical_record_revisions rv JOIN medical_records mr ON mr.id = rv.record_id
       WHERE mr.profile_id = ? ORDER BY rv.superseded_at DESC, rv.id DESC`,
    countSql: `SELECT COUNT(*) AS n
       FROM medical_record_revisions rv JOIN medical_records mr ON mr.id = rv.record_id
       WHERE mr.profile_id = ?`,
  }),
  tableDataset({
    key: "immunizations",
    label: "Immunizations",
    table: "immunizations",
    columns: [
      "date",
      "vaccine",
      "dose_label",
      "notes",
      // Administration attributes (#1406) — exactly the fields a school / travel /
      // camp / employer form asks for, so a portable export must carry them.
      "lot_number",
      "route",
      "site",
      "reaction",
    ],
    select: `SELECT id, date, vaccine, dose_label, notes,
              lot_number, route, site, reaction
       FROM immunizations WHERE profile_id = ? ORDER BY date DESC, id DESC`,
    countSql: `SELECT COUNT(*) AS n FROM immunizations WHERE profile_id = ?`,
  }),
  tableDataset({
    key: "goals",
    label: "Goals",
    table: "goals",
    columns: [
      "title",
      "description",
      "category",
      "target_value",
      "current_value",
      "unit",
      "target_date",
      "status",
      "created_at",
    ],
    select: `SELECT id, title, description, category, target_value, current_value,
              unit, target_date, status, created_at
       FROM goals WHERE profile_id = ? ORDER BY created_at DESC`,
    countSql: `SELECT COUNT(*) AS n FROM goals WHERE profile_id = ?`,
  }),
  tableDataset({
    // User-declared injuries (#838) — user-entered training-context data a migrating
    // family keeps (affected regions, status, dates, notes).
    key: "injuries",
    label: "Injuries",
    table: "injuries",
    columns: [
      "label",
      "regions",
      "muscles",
      "status",
      "since",
      "resolved_date",
      "notes",
      "created_at",
    ],
    select: `SELECT id, label, regions, muscles, status, since, resolved_date, notes, created_at
       FROM injuries WHERE profile_id = ? ORDER BY COALESCE(since, substr(created_at, 1, 10)) DESC, id DESC`,
    countSql: `SELECT COUNT(*) AS n FROM injuries WHERE profile_id = ?`,
  }),
  tableDataset({
    // Niggles (#2948) — the self-expiring tier below injury, one row per body region +
    // side the person confirmed was bothering them. User-entered (the confirm chip's tap
    // IS the write), so it leaves with a migrating family like the injuries above.
    // EXPIRED rows are exported too: expiry is a read-time derivation over
    // `last_reported_at`, never a delete, so the table IS the history.
    key: "niggles",
    label: "Niggles",
    table: "niggles",
    columns: [
      "region",
      "laterality",
      "body_term",
      "source_activity_id",
      "source_exercise",
      "reported_at",
      "last_reported_at",
    ],
    select: `SELECT id, region, laterality, body_term, source_activity_id,
                    source_exercise, reported_at, last_reported_at
       FROM niggles WHERE profile_id = ? ORDER BY last_reported_at DESC, id DESC`,
    countSql: `SELECT COUNT(*) AS n FROM niggles WHERE profile_id = ?`,
  }),
  tableDataset({
    // Events (#839, generalized by #3285) — user-entered events a migrating family
    // keeps (kind, name, date, the optional cardio target, status). The weekly
    // trajectory is derived, never stored, so nothing but the goal is exported here.
    // `kind` leads because it is what the row IS; without it a re-imported meet and a
    // re-imported marathon are one indistinguishable shape.
    key: "endurance_plans",
    label: "Events",
    table: "endurance_plans",
    columns: [
      "kind",
      "event_name",
      "discipline",
      "event_date",
      "target_distance_km",
      "target_time_sec",
      "status",
      "notes",
      "completed_on",
      "created_at",
    ],
    select: `SELECT id, kind, event_name, discipline, event_date, target_distance_km, target_time_sec,
              status, notes, completed_on, created_at
       FROM endurance_plans WHERE profile_id = ? ORDER BY event_date DESC, id DESC`,
    countSql: `SELECT COUNT(*) AS n FROM endurance_plans WHERE profile_id = ?`,
  }),
  tableDataset({
    // Menstrual cycle log (#714) — the user-entered periods (start/inclusive end, flow,
    // note). The derived phase + length trends recompute from these on import, so only the
    // recorded periods round-trip. Per-day cycle symptoms export via symptom_logs.
    key: "cycles",
    label: "Cycle log",
    table: "cycles",
    columns: ["period_start", "period_end", "flow", "note", "created_at"],
    select: `SELECT id, period_start, period_end, flow, note, created_at
       FROM cycles WHERE profile_id = ? ORDER BY period_start DESC, id DESC`,
    countSql: `SELECT COUNT(*) AS n FROM cycles WHERE profile_id = ?`,
  }),
  tableDataset({
    // Daily wellbeing check-ins (#992) — one row per day: valence 1–5 plus the
    // optional energy/anxiety scales, factor chips (a JSON slug array), and note.
    // Exported verbatim; the coaching observations recompute from these on read.
    key: "mood_logs",
    label: "Mood check-ins",
    table: "mood_logs",
    columns: [
      "date",
      "valence",
      "energy",
      "anxiety",
      "factors",
      "notes",
      "created_at",
    ],
    select: `SELECT id, date, valence, energy, anxiety, factors, notes, created_at
       FROM mood_logs WHERE profile_id = ? ORDER BY date DESC, id DESC`,
    countSql: `SELECT COUNT(*) AS n FROM mood_logs WHERE profile_id = ?`,
  }),
  tableDataset({
    // Wellness-practice session log (#1259): one row per logged session (red light,
    // sauna, meditation, …) with an optional session window and duration. User-entered
    // health data, so it's in the portable export; id-keyed + owned, deletable like the
    // other logged datasets.
    key: "practice_logs",
    label: "Practice sessions",
    table: "practice_logs",
    // bundle_id says which rows one act wrote (#5117). Nothing writes
    // practice_logs.bundle_id yet, so it is empty on every row until one does —
    // manifest.json says so (#5273).
    columns: [
      "practice",
      "date",
      "start_time",
      "end_time",
      "duration_min",
      "notes",
      "created_at",
      "bundle_id",
    ],
    select: `SELECT id, practice, date, start_time, end_time, duration_min, notes,
              created_at, bundle_id
       FROM practice_logs WHERE profile_id = ? ORDER BY date DESC, id DESC`,
    countSql: `SELECT COUNT(*) AS n FROM practice_logs WHERE profile_id = ?`,
  }),
  tableDataset({
    // Supplements + medications (the parent intake_items rows), one per row, with
    // each item's dose SCHEDULE folded into a readable `schedule` summary (built
    // in JS from its intake_item_doses children, ordered by sort — e.g.
    // "morning × 1 cap; evening × 2 tab (with food)"). Keeping the row at the
    // item level preserves the edit/delete model: deleting a row removes the
    // parent intake_items (its doses/logs cascade). The dose schedule is
    // read-only here — dose editing lives on the intake surfaces.
    key: "intake_items",
    label: "Supplements & Medications",
    table: "intake_items",
    select: ITEMS_SELECT,
    countSql: `SELECT COUNT(*) AS n FROM intake_items WHERE profile_id = ?`,
    shape: (items, profileId) =>
      shapeSupplements(
        items,
        itemDoses(
          profileId,
          items.map((it) => it.id as number)
        )
      ),
    jsBuilt: [
      {
        column: "schedule",
        by: shapeSupplements,
        why: "the item's intake_item_doses folded into one readable dose summary — a child-table roll-up, not a column of intake_items. The doses themselves export in full via the intake_doses dataset.",
      },
    ],
    columns: [
      "name",
      "kind",
      "brand",
      "product",
      "condition",
      "obligation",
      "situation",
      "stack",
      "active",
      "critical",
      "prescriber",
      "pharmacy",
      "rx_number",
      "quantity_on_hand",
      "notes",
      "schedule",
    ],
  }),
  tableDataset({
    // Adherence log: one row per confirmed dose on a date. A child of
    // intake_items (joined via item_id), so browse/export-only.
    key: "intake_log",
    label: "Supplement & medication log",
    table: "intake_item_logs",
    deletable: false,
    // status + skip_reason distinguish a SKIPPED dose from a taken one (a skipped
    // dose used to export with a timestamp indistinguishable from a confirmed one —
    // an actively-wrong adherence history); amount is the #280 dose snapshot (#466).
    columns: [
      "date",
      "item",
      "status",
      "occurred_at",
      "recorded_at",
      "amount",
      "skip_reason",
      "bundle_id",
    ],
    select: `SELECT l.id, l.date, ii.name AS item, l.status, l.occurred_at,
              l.recorded_at, l.amount, l.skip_reason, l.bundle_id
       FROM intake_item_logs l JOIN intake_items ii ON ii.id = l.item_id
       WHERE ii.profile_id = ? ORDER BY l.date DESC, ii.name`,
    countSql: `SELECT COUNT(*) AS n
       FROM intake_item_logs l JOIN intake_items ii ON ii.id = l.item_id
       WHERE ii.profile_id = ?`,
  }),
  tableDataset({
    // Dose schedule HISTORY (#1973/#2000): the dueness-relevant schedule of each
    // dose as of every effective_from day, so past adherence keeps being judged by
    // the rule that held then. Undo already preserves these rows; export must not
    // silently drop them (#2129) — the intake_items dataset carries only the
    // CURRENT derived schedule string. A grandchild of intake_items (JOINed
    // through intake_item_doses via ii.profile_id), so browse/export-only.
    key: "dose_schedule_versions",
    label: "Dose schedule history",
    table: "intake_dose_schedule_versions",
    deletable: false,
    columns: [
      "item",
      "dose_amount",
      "effective_from",
      "time_of_day",
      "weekdays",
      "start_date",
      "end_date",
      "created_at",
    ],
    select: `SELECT v.id, ii.name AS item, d.amount AS dose_amount, v.effective_from,
              v.time_of_day, v.weekdays, v.start_date, v.end_date, v.created_at
       FROM intake_dose_schedule_versions v
       JOIN intake_item_doses d ON d.id = v.dose_id
       JOIN intake_items ii ON ii.id = d.item_id
       WHERE ii.profile_id = ?
       ORDER BY ii.name, v.dose_id, v.effective_from DESC, v.id DESC`,
    countSql: `SELECT COUNT(*) AS n
       FROM intake_dose_schedule_versions v
       JOIN intake_item_doses d ON d.id = v.dose_id
       JOIN intake_items ii ON ii.id = d.item_id
       WHERE ii.profile_id = ?`,
  }),
  tableDataset({
    key: "allergies",
    label: "Allergies",
    table: "allergies",
    columns: [
      "substance",
      "reaction",
      "severity",
      "status",
      // Safety attributes (#1405). `reaction`/`severity` above stay the CACHED first
      // manifestation; the full graded list rides the FHIR passport's
      // AllergyIntolerance.reaction[] rather than being flattened into a CSV cell.
      "criticality",
      "verification_status",
      "onset_date",
      "notes",
    ],
    select: `SELECT id, substance, reaction, severity, status,
              criticality, verification_status, onset_date, notes
       FROM allergies WHERE profile_id = ? ORDER BY substance`,
    countSql: `SELECT COUNT(*) AS n FROM allergies WHERE profile_id = ?`,
  }),
  tableDataset({
    key: "conditions",
    label: "Conditions",
    table: "conditions",
    // `edited` is the #2137 user-edit lock — exported like body_metrics' and
    // medical_records' flags above: whether a hand correction locks the row against
    // its derivation is user-meaningful state, not internal bookkeeping.
    columns: [
      "name",
      "code",
      "code_system",
      "status",
      "laterality",
      "severity",
      "stage",
      "onset_date",
      "resolved_date",
      "edited",
      "notes",
    ],
    select: `SELECT id, name, code, code_system, status, laterality, severity, stage,
              onset_date, resolved_date, edited, notes
       FROM conditions WHERE profile_id = ? ORDER BY name`,
    countSql: `SELECT COUNT(*) AS n FROM conditions WHERE profile_id = ?`,
  }),
  tableDataset({
    key: "encounters",
    label: "Encounters",
    table: "encounters",
    columns: [
      "date",
      "end_date",
      "type",
      "class_code",
      "reason",
      "diagnoses",
      "notes",
    ],
    select: `SELECT id, date, end_date, type, class_code, reason, diagnoses, notes
       FROM encounters WHERE profile_id = ? ORDER BY date DESC, id DESC`,
    countSql: `SELECT COUNT(*) AS n FROM encounters WHERE profile_id = ?`,
  }),
  tableDataset({
    // Integration-synced daily/scalar samples (steps, distance, calories, HRV,
    // and the projected height / head- and waist-circumference points). Each carries id +
    // profile_id, so it's fully deletable like the other logged datasets.
    key: "metric_samples",
    label: "Metric samples",
    table: "metric_samples",
    columns: [
      "date",
      "metric",
      "value",
      "started_at",
      "ended_at",
      "source",
      "origin",
    ],
    select: `SELECT id, date, metric, value, started_at, ended_at, source, origin
       FROM metric_samples WHERE profile_id = ?
       ORDER BY date DESC, metric, started_at DESC`,
    countSql: `SELECT COUNT(*) AS n FROM metric_samples WHERE profile_id = ?`,
  }),
  tableDataset({
    // Per-minute heart-rate buckets (integration-synced). Keyed by
    // (profile_id, ts) with no single `id`, so browse/export-only. This is the
    // dataset that dominated the #113 payload (1,440 rows/day/profile), so the
    // bounded page read matters most here.
    key: "hr_minutes",
    label: "Heart rate (per-minute)",
    table: "hr_minutes",
    deletable: false,
    columns: ["ts", "bpm", "bpm_min", "bpm_max", "n", "source"],
    select: `SELECT ts, bpm, bpm_min, bpm_max, n, source
       FROM hr_minutes WHERE profile_id = ? ORDER BY ts DESC`,
    countSql: `SELECT COUNT(*) AS n FROM hr_minutes WHERE profile_id = ?`,
  }),
  tableDataset({
    // The continuous-glucose trace (#2810). Same posture as hr_minutes one row
    // above, for the same two reasons: the key is (profile_id, ts, source) with no
    // single `id`, and a continuously worn sensor writes ~105k rows a year, so the
    // bounded page read is what keeps the browse affordable. Browse/export-only —
    // a trace point has no per-row delete path, so it is absent from the manage
    // delete policy and from TOMBSTONE_TABLES alike. The DAILY derivations are
    // exported by the metric_samples dataset, where they live.
    key: "glucose_trace",
    label: "Glucose (continuous trace)",
    table: "glucose_trace",
    deletable: false,
    columns: ["ts", "mgdl", "source"],
    select: `SELECT ts, mgdl, source
       FROM glucose_trace WHERE profile_id = ? ORDER BY ts DESC`,
    countSql: `SELECT COUNT(*) AS n FROM glucose_trace WHERE profile_id = ?`,
  }),
  // ── Clinical passport domains that used to be absent from the full export (#465).
  // Each was in OWNED_TABLES with a dedicated page but no dataset/FHIR resource, so a
  // family migrating off an instance silently lost the whole domain. The binding test
  // (export-completeness.test.ts) now forces every owned table into a dataset, the
  // FHIR input, or a justified allowlist.
  tableDataset({
    key: "procedures",
    label: "Procedures",
    table: "procedures",
    columns: ["date", "name", "code", "code_system", "notes"],
    select: `SELECT id, date, name, code, code_system, notes
       FROM procedures WHERE profile_id = ? ORDER BY date DESC, id DESC`,
    countSql: `SELECT COUNT(*) AS n FROM procedures WHERE profile_id = ?`,
  }),
  tableDataset({
    key: "genomic_variants",
    label: "Genomic variants",
    table: "genomic_variants",
    columns: [
      "gene",
      "variant",
      "genotype",
      "star_allele",
      "zygosity",
      "significance",
      "result_type",
      "interpretation",
      "source_lab",
      "report_date",
      "notes",
    ],
    select: `SELECT id, gene, variant, genotype, star_allele, zygosity, significance,
              result_type, interpretation, source_lab, report_date, notes
       FROM genomic_variants WHERE profile_id = ?
       ORDER BY COALESCE(report_date, '') DESC, gene, id DESC`,
    countSql: `SELECT COUNT(*) AS n FROM genomic_variants WHERE profile_id = ?`,
  }),
  tableDataset({
    key: "imaging_studies",
    label: "Imaging studies",
    table: "imaging_studies",
    columns: [
      "modality",
      "body_region",
      "laterality",
      "contrast",
      "contrast_agent",
      "study_date",
      "impression",
      "report_narrative",
      "indication",
      "status",
      "notes",
    ],
    select: `SELECT id, modality, body_region, laterality, contrast, contrast_agent,
              study_date, impression, report_narrative, indication, status, notes
       FROM imaging_studies WHERE profile_id = ?
       ORDER BY COALESCE(study_date, '') DESC, id DESC`,
    countSql: `SELECT COUNT(*) AS n FROM imaging_studies WHERE profile_id = ?`,
  }),
  // ── The two specialty record types that shipped in NO bundle (#1846) ──────────
  // Both were export-allowlisted on the argument that they have no FHIR builder —
  // which conflated two different things. Portability does not wait for a FHIR
  // resource: imaging_studies has no FHIR export builder either and has been a flat
  // dataset since #465. These two are the LAST manually-created clinical record
  // types with a page, a finding→follow-up loop, and no way out of the app.
  //
  // Column discipline for both: every field a person TYPED or a document extraction
  // filled, plus the state a reader needs to interpret it (`status`) — the #2200
  // precedent for exporting a state flag rather than treating it as bookkeeping.
  // Left out on purpose: `external_id` (an importer's source-system key, meaningless
  // off the instance that synced it) and `encounter_id` (an instance-local row id no
  // other dataset exports). `provider` is RESOLVED to the provider's NAME rather
  // than exported as a raw id — for a domain with no FHIR resource to carry the
  // reference, "which dentist/dermatologist" is the portable fact, and the full
  // provider entry (NPI, phone, address) still ships in the providers dataset
  // because both tables are now in PROVIDER_LINK_SELECTS above.
  tableDataset({
    // Structured dental procedures/findings (#705). `source` + `document_id` are the
    // provenance pair the medical_records dataset already exports: manual vs
    // AI-extracted, and the cross-reference into the bundle's own medical_documents
    // dataset. Trendable periodontal MEASUREMENTS keep round-tripping via
    // medical_records — these are the procedure/finding rows themselves.
    // deletable: false — a dental row is not a plain id + profile_id delete: the
    // care_plan_items follow-up chain references it
    // (source_dental_procedure_id / resolved_by_dental_procedure_id), so delete
    // lives on the dental page, which handles that side-state.
    key: "dental_procedures",
    label: "Dental procedures",
    table: "dental_procedures",
    deletable: false,
    columns: [
      "procedure_date",
      "name",
      "status",
      "tooth",
      "tooth_system",
      "surface",
      "cdt_code",
      "finding",
      "follow_up_interval_days",
      "provider",
      "source",
      "document_id",
      "notes",
    ],
    select: `SELECT dp.id, dp.procedure_date, dp.name, dp.status, dp.tooth,
              dp.tooth_system, dp.surface, dp.cdt_code, dp.finding,
              dp.follow_up_interval_days, p.name AS provider, dp.source,
              dp.document_id, dp.notes
       FROM dental_procedures dp LEFT JOIN providers p ON p.id = dp.provider_id
       WHERE dp.profile_id = ?
       ORDER BY COALESCE(dp.procedure_date, '') DESC, dp.id DESC`,
    countSql: `SELECT COUNT(*) AS n FROM dental_procedures WHERE profile_id = ?`,
  }),
  tableDataset({
    // Structured skin-lesion records (#715) — the same shape one specialty over, and
    // the worse gap of the two: the lesion row carries no analyte that round-trips
    // through another dataset, so this dataset is the ONLY egress for the record
    // type. The five ABCDE columns are the user-recorded 0/1 observations; `size_mm`
    // is the measurement a serial comparison turns on. The serial lesion PHOTOS ride
    // the opt-in media bundle (media/lesion-photos/), not a dataset.
    // deletable: false — lesion delete must clear its lesion_photos children
    // (rows + files) and the care_plan_items follow-up links first; that lives on
    // the skin page.
    key: "skin_lesions",
    label: "Skin lesions",
    table: "skin_lesions",
    deletable: false,
    columns: [
      "label",
      "body_region",
      "body_side",
      "status",
      "observed_date",
      "size_mm",
      "asymmetry",
      "border",
      "color",
      "diameter",
      "evolving",
      "finding",
      "follow_up_interval_days",
      "provider",
      "source",
      "document_id",
      "notes",
    ],
    select: `SELECT sl.id, sl.label, sl.body_region, sl.body_side, sl.status,
              sl.observed_date, sl.size_mm, sl.asymmetry, sl.border, sl.color,
              sl.diameter, sl.evolving, sl.finding, sl.follow_up_interval_days,
              p.name AS provider, sl.source, sl.document_id, sl.notes
       FROM skin_lesions sl LEFT JOIN providers p ON p.id = sl.provider_id
       WHERE sl.profile_id = ?
       ORDER BY COALESCE(sl.observed_date, '') DESC, sl.id DESC`,
    countSql: `SELECT COUNT(*) AS n FROM skin_lesions WHERE profile_id = ?`,
  }),
  tableDataset({
    key: "optical_prescriptions",
    label: "Optical prescriptions",
    table: "optical_prescriptions",
    columns: [
      "kind",
      "od_sphere",
      "od_cylinder",
      "od_axis",
      "od_add",
      "os_sphere",
      "os_cylinder",
      "os_axis",
      "os_add",
      "pd",
      "base_curve",
      "diameter",
      "brand",
      "issued_date",
      "expiry_date",
      "notes",
    ],
    select: `SELECT id, kind, od_sphere, od_cylinder, od_axis, od_add,
              os_sphere, os_cylinder, os_axis, os_add, pd,
              base_curve, diameter, brand, issued_date, expiry_date, notes
       FROM optical_prescriptions WHERE profile_id = ?
       ORDER BY COALESCE(issued_date, '') DESC, id DESC`,
    countSql: `SELECT COUNT(*) AS n FROM optical_prescriptions WHERE profile_id = ?`,
  }),
  tableDataset({
    key: "family_history",
    label: "Family history",
    table: "family_history",
    columns: [
      "relation",
      "relation_type",
      "lineage",
      "condition",
      "code",
      "code_system",
      "onset_age",
      "deceased",
      "age_at_death",
      "cause_of_death",
      "notes",
    ],
    select: `SELECT id, relation, relation_type, lineage, condition, code, code_system,
              onset_age, deceased, age_at_death, cause_of_death, notes
       FROM family_history WHERE profile_id = ? ORDER BY condition, id`,
    countSql: `SELECT COUNT(*) AS n FROM family_history WHERE profile_id = ?`,
  }),
  tableDataset({
    key: "care_plan_items",
    label: "Care plan",
    table: "care_plan_items",
    columns: [
      "description",
      "category",
      "code",
      "code_system",
      "planned_date",
      "status",
      "notes",
    ],
    select: `SELECT id, description, category, code, code_system, planned_date, status, notes
       FROM care_plan_items WHERE profile_id = ? ORDER BY planned_date DESC, id DESC`,
    countSql: `SELECT COUNT(*) AS n FROM care_plan_items WHERE profile_id = ?`,
  }),
  tableDataset({
    key: "care_goals",
    label: "Care goals",
    table: "care_goals",
    columns: [
      "description",
      "code",
      "code_system",
      "target_date",
      "status",
      "notes",
    ],
    select: `SELECT id, description, code, code_system, target_date, status, notes
       FROM care_goals WHERE profile_id = ? ORDER BY target_date DESC, id DESC`,
    countSql: `SELECT COUNT(*) AS n FROM care_goals WHERE profile_id = ?`,
  }),
  tableDataset({
    key: "appointments",
    label: "Appointments",
    table: "appointments",
    columns: ["date", "time_of_day", "title", "location", "status", "notes"],
    select: `SELECT id, date, time_of_day, title, location, status, notes
       FROM appointments WHERE profile_id = ?
       ORDER BY date DESC, time_of_day DESC, id DESC`,
    countSql: `SELECT COUNT(*) AS n FROM appointments WHERE profile_id = ?`,
  }),
  tableDataset({
    key: "immunization_overrides",
    label: "Immunization overrides",
    table: "immunization_overrides",
    columns: ["vaccine", "kind", "reason", "exemption_type", "note"],
    select: `SELECT id, vaccine, kind, reason, exemption_type, note
       FROM immunization_overrides WHERE profile_id = ? ORDER BY vaccine`,
    countSql: `SELECT COUNT(*) AS n FROM immunization_overrides WHERE profile_id = ?`,
  }),
  tableDataset({
    key: "preventive_events",
    label: "Screening history",
    table: "preventive_events",
    columns: ["rule_key", "date", "source"],
    select: `SELECT id, rule_key, date, source
       FROM preventive_events WHERE profile_id = ? ORDER BY date DESC, id DESC`,
    countSql: `SELECT COUNT(*) AS n FROM preventive_events WHERE profile_id = ?`,
  }),
  tableDataset({
    key: "preventive_overrides",
    label: "Screening overrides",
    table: "preventive_overrides",
    columns: ["rule_key", "kind", "note"],
    select: `SELECT id, rule_key, kind, note
       FROM preventive_overrides WHERE profile_id = ? ORDER BY rule_key`,
    countSql: `SELECT COUNT(*) AS n FROM preventive_overrides WHERE profile_id = ?`,
  }),
  tableDataset({
    key: "preventive_record_decisions",
    label: "Screening review decisions",
    table: "preventive_record_decisions",
    columns: ["medical_record_id", "rule_key", "decision", "confirmed_date"],
    select: `SELECT id, medical_record_id, rule_key, decision, confirmed_date
       FROM preventive_record_decisions WHERE profile_id = ?
       ORDER BY rule_key, medical_record_id`,
    countSql: `SELECT COUNT(*) AS n FROM preventive_record_decisions WHERE profile_id = ?`,
  }),
  tableDataset({
    key: "protocols",
    label: "Protocols",
    table: "protocols",
    columns: [
      "name",
      "start_date",
      "end_date",
      "situation",
      "outcome_keys",
      "notes",
    ],
    select: `SELECT id, name, start_date, end_date, situation, outcome_keys, notes
       FROM protocols WHERE profile_id = ? ORDER BY start_date DESC, id DESC`,
    countSql: `SELECT COUNT(*) AS n FROM protocols WHERE profile_id = ?`,
  }),
  tableDataset({
    key: "milestones",
    label: "Milestones",
    table: "milestones",
    columns: ["kind", "threshold", "title", "detail", "achieved_on"],
    select: `SELECT id, key, kind, threshold, title, detail, achieved_on
       FROM milestones WHERE profile_id = ? ORDER BY achieved_on DESC, id DESC`,
    countSql: `SELECT COUNT(*) AS n FROM milestones WHERE profile_id = ?`,
  }),
  tableDataset({
    key: "equipment",
    label: "Equipment",
    table: "equipment",
    columns: ["name", "weight_kg", "category"],
    select: `SELECT id, name, weight_kg, category
       FROM equipment WHERE profile_id = ? ORDER BY name`,
    countSql: `SELECT COUNT(*) AS n FROM equipment WHERE profile_id = ?`,
  }),
  tableDataset({
    key: "frequency_targets",
    label: "Training frequency targets",
    table: "frequency_targets",
    columns: ["scope_kind", "scope_value", "per_week"],
    select: `SELECT id, scope_kind, scope_value, per_week
       FROM frequency_targets WHERE profile_id = ? ORDER BY scope_kind, scope_value`,
    countSql: `SELECT COUNT(*) AS n FROM frequency_targets WHERE profile_id = ?`,
  }),
  // Situations vocabulary (#560): the profile's situational-context labels + active
  // state. Not deletable as a set — intake_items.situation_id links reference these
  // rows, so a bulk wipe would strand them (row-ops rule).
  tableDataset({
    // Food-group serving log (#579): one row per (date, group) with a servings count.
    // Fully profile-owned + id-keyed, so it's deletable like the other logged datasets.
    key: "food_daily_totals",
    label: "Food log",
    table: "food_daily_totals",
    columns: ["date", "group_key", "servings", "notes"],
    select: `SELECT id, date, group_key, servings, notes
       FROM food_daily_totals WHERE profile_id = ? ORDER BY date DESC, group_key`,
    countSql: `SELECT COUNT(*) AS n FROM food_daily_totals WHERE profile_id = ?`,
  }),
  tableDataset({
    // Food-log EVENT ledger (#950): one append-only row per serving TAP, carrying the
    // tap `recorded_at` (a UTC instant) beside the food day. It's the timing layer behind
    // slot-aware button ranking; the food_daily_totals counter stays the day's data of record.
    // User-entered health data, so it's in the portable export; id-keyed + owned, so
    // deletable like the other logged datasets (a wipe just degrades ranking to overall
    // frecency — the food_daily_totals counter is untouched).
    key: "food_log_events",
    label: "Food log events",
    table: "food_log_events",
    columns: ["date", "group_key", "recorded_at", "meal_slot", "bundle_id"],
    select: `SELECT id, date, group_key, recorded_at, meal_slot, bundle_id
       FROM food_log_events WHERE profile_id = ? ORDER BY recorded_at DESC`,
    countSql: `SELECT COUNT(*) AS n FROM food_log_events WHERE profile_id = ?`,
  }),
  tableDataset({
    // Non-food substance consumption ledger (#1078): one row per (date, substance)
    // with a per-use units count (nicotine/cannabis; alcohol rides food_daily_totals above).
    // User-entered health data, so it's in the portable export; id-keyed + owned,
    // deletable like the other logged datasets.
    key: "substance_daily_totals",
    label: "Substance log",
    table: "substance_daily_totals",
    columns: ["date", "substance", "units", "recorded_at", "notes"],
    select: `SELECT id, date, substance, units, recorded_at, notes
       FROM substance_daily_totals WHERE profile_id = ? ORDER BY date DESC, substance`,
    countSql: `SELECT COUNT(*) AS n FROM substance_daily_totals WHERE profile_id = ?`,
  }),
  tableDataset({
    // Protein-grams quick-add log (#824): one row per date with a running gram total
    // (protein powder / shakes have no food-group home). User-entered health data, so
    // it's in the portable export; id-keyed + owned, deletable like the other logged
    // datasets.
    key: "protein_daily_totals",
    label: "Protein log",
    table: "protein_daily_totals",
    columns: ["date", "grams"],
    select: `SELECT id, date, grams
       FROM protein_daily_totals WHERE profile_id = ? ORDER BY date DESC`,
    countSql: `SELECT COUNT(*) AS n FROM protein_daily_totals WHERE profile_id = ?`,
  }),
  tableDataset({
    // Fasting log (#2756): one row per claimed fast — the two instants and an optional
    // note. IN the portable export because it is the one thing here that cannot be
    // re-derived from anything else in the bundle: a fast is an EXPLICIT claim the user
    // starts and ends, never inferred from the food log (inferring eating times from TAP
    // times is the trap the table exists to avoid), so if these rows do not travel, the
    // family's entire fasting record is simply gone — #465/#2129's disease. It is
    // user-entered health data in exactly the sense practice_logs, symptom_logs and the
    // substance ledger are, and it fits none of the allowlist's four excuses (UI state,
    // AI-derived, operational/non-portable, media-file bundle).
    //
    // NOT exported: `end_written_at`. That column is the app's own clock at the moment an
    // end was WRITTEN, carried solely to bound the Undo window (lib/fast-write.ts) — it
    // is not a claim the user made and answers no question on another instance. The two
    // instants that ARE the record travel; elapsed time, day attribution and staleness
    // stay derived (lib/fasting.ts), so nothing here freezes one timezone's answer.
    //
    // Adult-only content is NOT a reason to withhold a dataset (the substance ledger
    // above is the precedent, #1174): exported rows remain the profile's own data.
    key: "fasts",
    label: "Fasting log",
    table: "fasts",
    columns: ["started_at", "ended_at", "note", "created_at"],
    select: `SELECT id, started_at, ended_at, note, created_at
       FROM fasts WHERE profile_id = ? ORDER BY started_at DESC, id DESC`,
    countSql: `SELECT COUNT(*) AS n FROM fasts WHERE profile_id = ?`,
  }),
  tableDataset({
    // Day-by-day symptom log (#799): one row per (date, symptom) with a 1–4 severity.
    // User-entered health data, so it's in the portable export; id-keyed + owned, so
    // deletable like the other logged datasets.
    key: "symptom_logs",
    label: "Symptom log",
    table: "symptom_logs",
    columns: ["date", "symptom", "severity", "note"],
    select: `SELECT id, date, symptom, severity, note
       FROM symptom_logs WHERE profile_id = ? ORDER BY date DESC, symptom COLLATE NOCASE`,
    countSql: `SELECT COUNT(*) AS n FROM symptom_logs WHERE profile_id = ?`,
  }),
  tableDataset({
    key: "situations",
    label: "Situations",
    table: "situations",
    columns: ["name", "active", "illness_type"],
    select: `SELECT id, name, active, illness_type
       FROM situations WHERE profile_id = ? ORDER BY name COLLATE NOCASE`,
    countSql: `SELECT COUNT(*) AS n FROM situations WHERE profile_id = ?`,
    deletable: false,
  }),
  tableDataset({
    // Uploaded-document METADATA (the file bytes are bundled separately in the ZIP).
    // Browse/export-only: deleting a document is not a plain id delete (it must unlink
    // the file and re-point child medical_records), so that lives on the import UI.
    key: "medical_documents",
    label: "Medical documents",
    table: "medical_documents",
    deletable: false,
    columns: [
      "filename",
      "doc_type",
      "source",
      "document_date",
      "mime_type",
      "size_bytes",
      "extraction_status",
      "extracted_count",
      "uploaded_at",
    ],
    select: `SELECT id, filename, doc_type, source, document_date, mime_type,
              size_bytes, extraction_status, extracted_count, uploaded_at
       FROM medical_documents WHERE profile_id = ? ORDER BY uploaded_at DESC, id DESC`,
    countSql: `SELECT COUNT(*) AS n FROM medical_documents WHERE profile_id = ?`,
  }),
  tableDataset({
    // Medication start/stop history (a child of intake_items via item_id, so
    // browse/export-only — the parent medication is the deletable unit).
    key: "medication_courses",
    label: "Medication courses",
    table: "medication_courses",
    deletable: false,
    columns: ["item", "started_on", "stopped_on", "stop_reason", "notes"],
    select: `SELECT mc.id, ii.name AS item, mc.started_on, mc.stopped_on,
              mc.stop_reason, mc.notes
       FROM medication_courses mc JOIN intake_items ii ON ii.id = mc.item_id
       WHERE ii.profile_id = ? ORDER BY ii.name, mc.started_on DESC, mc.id DESC`,
    countSql: `SELECT COUNT(*) AS n
       FROM medication_courses mc JOIN intake_items ii ON ii.id = mc.item_id
       WHERE ii.profile_id = ?`,
  }),
  tableDataset({
    // Label composition of an intake item (#2856) — a child of intake_items via
    // item_id, so browse/export-only. It exports rather than being argued away: the
    // rows are what a person transcribed off their own bottles, and they are the input
    // the upper-limit totals and interaction checks read, so a migrating family
    // leaving without them would leave without the composition half of their shelf.
    // `amount_text` is the label's own words and `amount`/`unit` the canonical reading
    // — both, because the second is derived from the first and only the first is
    // checkable against the bottle.
    key: "intake_item_ingredients",
    label: "Ingredients",
    table: "intake_item_ingredients",
    deletable: false,
    columns: ["item", "ingredient", "amount_text", "amount", "unit"],
    select: `SELECT g.id, ii.name AS item, g.name AS ingredient, g.amount_text,
              g.amount, g.unit
       FROM intake_item_ingredients g JOIN intake_items ii ON ii.id = g.item_id
       WHERE ii.profile_id = ? ORDER BY ii.name, g.sort, g.id`,
    countSql: `SELECT COUNT(*) AS n
       FROM intake_item_ingredients g JOIN intake_items ii ON ii.id = g.item_id
       WHERE ii.profile_id = ?`,
  }),
  tableDataset({
    // Purpose links of an intake item (#2857) — the structured "why", a child of
    // intake_items via item_id, so browse/export-only. It exports rather than being
    // argued away for the reason the composition above does: the rows are the person's
    // own statement of why an item is in their stack, recorded nowhere else once it
    // stopped living in `notes` prose. The condition is exported by NAME (the row holds
    // an id, #203) so the export reads without a second lookup; a condition deleted
    // since leaves the name blank rather than an unresolvable number.
    key: "intake_item_purposes",
    label: "Purposes",
    table: "intake_item_purposes",
    deletable: false,
    columns: ["item", "kind", "goal", "condition", "biomarker", "direction"],
    select: `SELECT p.id, ii.name AS item, p.kind, p.goal_key AS goal,
              (SELECT c.name FROM conditions c
                WHERE c.id = p.condition_id AND c.profile_id = ii.profile_id)
                AS condition,
              p.biomarker_key AS biomarker, p.direction
       FROM intake_item_purposes p JOIN intake_items ii ON ii.id = p.item_id
       WHERE ii.profile_id = ? ORDER BY ii.name, p.sort, p.id`,
    countSql: `SELECT COUNT(*) AS n
       FROM intake_item_purposes p JOIN intake_items ii ON ii.id = p.item_id
       WHERE ii.profile_id = ?`,
  }),
  tableDataset({
    // Recorded medication/supplement side effects (a child of intake_items via
    // item_id, so browse/export-only).
    key: "intake_item_side_effects",
    label: "Side effects",
    table: "intake_item_side_effects",
    deletable: false,
    columns: ["item", "effect", "severity", "noted_on", "resolved", "notes"],
    select: `SELECT se.id, ii.name AS item, se.effect, se.severity, se.noted_on,
              se.resolved, se.notes
       FROM intake_item_side_effects se JOIN intake_items ii ON ii.id = se.item_id
       WHERE ii.profile_id = ? ORDER BY ii.name, se.noted_on DESC, se.id DESC`,
    countSql: `SELECT COUNT(*) AS n
       FROM intake_item_side_effects se JOIN intake_items ii ON ii.id = se.item_id
       WHERE ii.profile_id = ?`,
  }),
  providersDataset,
];

// Per-dataset deletion policy for the manage-actions delete path: which pages to
// revalidate after rows change, and whether removing rows can orphan a starred
// biomarker (so the star is cleaned up). Keyed by the dataset `key`. Lives here,
// beside DATASETS, rather than in the "use server" manage-actions module — a file
// with a top-level "use server" may only export async functions, so a plain data
// map can't live there, and co-locating it lets a test assert the two stay in
// sync. INVARIANT (enforced in lib/__db_tests__/export.test.ts): every deletable
// dataset (deletable !== false) has an entry here, and every browse/export-only
// dataset (deletable: false) does NOT — otherwise a dataset would render a delete
// button whose action resolves to "Unknown dataset" (the pre-existing
// immunizations bug) or vice-versa.
export interface DatasetDeletePolicy {
  // Compile-checked revalidation targets (#2149): the manage action fans these out
  // through `revalidateRoute`, so a dataset pointing at a retired route is a build
  // error rather than a silent no-op refresh. A dynamic route is written in its
  // `[param]` literal form through `revalidateTarget`, which checks the literal
  // against the real route tree before widening it for storage here.
  revalidate: readonly RevalidateTarget[];
  cleanupStars?: boolean;
  // Whether removing rows can orphan an `immunization:<code>` due-nudge dismissal
  // (upcoming_dismissals) — set for the immunizations dataset so a bulk delete runs
  // the same losing-backing sweep the per-dose delete/edit paths do (issue #376).
  // Same name-recycling class as cleanupStars, one table over.
  cleanupImmunizations?: boolean;
  // Whether removing rows can orphan a `pr:strength:` / `pr:cardio:` personal-record
  // celebration dismissal (#1931). Set for the datasets whose deletion un-backs a PR
  // key: `activities` (the sets/sessions the records are computed from) and
  // `equipment` (whose delete retires the LOAD LANE half of a strength record's
  // identity). Same name-recycling class as cleanupStars, one domain over.
  cleanupPersonalRecords?: boolean;
}

// `satisfies` (not a Record annotation) so the keys stay literal: they are the
// closed union of DELETABLE dataset keys (the export.test.ts invariant pins keys
// here ⟺ deletable datasets), which lib/dataset-undo.ts consumes at the TYPE level
// to force a mapping decision for every undoable root that is bulk-deletable
// (#2125).
export const DELETE_POLICY = {
  activities: {
    revalidate: ["/training", "/"],
    cleanupPersonalRecords: true,
  },
  body_metrics: { revalidate: ["/trends", "/"] },
  medical_records: {
    // Also refresh the import document subpages, which list these readings.
    revalidate: [
      "/results",
      "/results/clinical-results/view",
      revalidateTarget("/import/[id]"),
      "/",
    ],
    cleanupStars: true,
  },
  immunizations: {
    revalidate: ["/records", "/"],
    cleanupImmunizations: true,
  },
  goals: { revalidate: ["/training", "/"] },
  injuries: { revalidate: ["/training", "/history", "/"] },
  // A niggle (#2948) is a plain id + profile_id delete: nothing FKs into the table, no
  // counter sits beside it, and liveness is recomputed on read from `last_reported_at`
  // — so removing rows means exactly "these are no longer on record" with nothing left
  // dangling. Revalidates the activity page as well as /training, because the confirm
  // chip's offer is derived from the live set: deleting the row must put the chip back.
  // Not an undo root (no UNDO_KINDS entry), so DATASET_UNDO_KIND needs no decision — and
  // a niggle is cheap to re-report, one tap on the same note.
  niggles: {
    revalidate: ["/training", revalidateTarget("/training/activity/[id]"), "/"],
  },
  endurance_plans: { revalidate: ["/training", "/history", "/upcoming", "/"] },
  intake_items: { revalidate: ["/nutrition", "/medications", "/"] },
  allergies: { revalidate: ["/records", "/"] },
  conditions: { revalidate: ["/records", "/"] },
  encounters: { revalidate: ["/records", "/"] },
  metric_samples: { revalidate: ["/trends", "/"] },
  // Clinical passport domains newly exported/deletable (#465).
  procedures: { revalidate: ["/records", "/"] },
  genomic_variants: { revalidate: ["/results", "/"] },
  imaging_studies: { revalidate: ["/results", "/"] },
  optical_prescriptions: { revalidate: ["/records", "/"] },
  family_history: { revalidate: ["/records", "/"] },
  care_plan_items: { revalidate: ["/records", "/"] },
  care_goals: { revalidate: ["/records", "/"] },
  appointments: { revalidate: ["/records", "/upcoming", "/"] },
  immunization_overrides: { revalidate: ["/records", "/"] },
  preventive_events: { revalidate: ["/upcoming", "/"] },
  preventive_overrides: { revalidate: ["/upcoming", "/"] },
  // A review decision (#3025) is a plain id + profile_id delete: nothing FKs into
  // the table and no derived state is stored — dropping a confirmed row simply
  // retracts its satisfaction and re-offers the candidate on the next assessment,
  // which is exactly what "delete this from my record" means here. Not an undo
  // root (no UNDO_KINDS entry), so DATASET_UNDO_KIND needs no decision.
  preventive_record_decisions: { revalidate: ["/upcoming", "/"] },
  protocols: { revalidate: ["/longevity", "/"] },
  milestones: { revalidate: ["/"] },
  equipment: {
    revalidate: ["/equipment", "/training"],
    cleanupPersonalRecords: true,
  },
  frequency_targets: { revalidate: ["/training", "/"] },
  food_daily_totals: { revalidate: ["/nutrition", "/trends", "/"] },
  food_log_events: { revalidate: ["/nutrition", "/"] },
  substance_daily_totals: {
    revalidate: ["/records/specialty/substance-use", "/"],
  },
  protein_daily_totals: { revalidate: ["/nutrition", "/"] },
  // The fasting card and its history live on the nutrition tab. A plain id + profile_id
  // delete: nothing FKs into `fasts`, no counter is decremented beside it, and no derived
  // state is stored — elapsed/attribution/staleness are all recomputed on read — so
  // removing rows here means exactly "these fasts are no longer on record". Not an undo
  // root (no UNDO_KINDS entry), so DATASET_UNDO_KIND needs no decision.
  //
  // This does NOT re-open the ruling that `discardFast` must refuse a COMPLETED row.
  // That refusal is about what Discard MEANS on the fasting card — "I never actually
  // fasted" — which the app is not entitled to pick for someone whose fast has already
  // ended. Removing a row from a table of rows on Data → Manage is the generic
  // "delete this from my record" every logged dataset carries, chosen deliberately
  // against the row itself; it makes no claim about whether the fast happened.
  // (`equipment` is the precedent for a STATEFUL_WRITE_TABLES-registered table that is
  // also bulk-deletable: a delete is not one of the table's state transitions.)
  fasts: { revalidate: ["/nutrition", "/"] },
  symptom_logs: { revalidate: ["/", "/history"] },
  cycles: { revalidate: ["/medical/cycles", "/history", "/"] },
  mood_logs: { revalidate: ["/trends", "/"] },
  practice_logs: { revalidate: ["/history", "/longevity", "/"] },
} satisfies Record<string, DatasetDeletePolicy>;

// The closed union of deletable dataset keys — every key equals its dataset's
// physical table; the db-tier dataset-undo test pins that correspondence at runtime.
export type DeletableDatasetKey = keyof typeof DELETE_POLICY;

export function getDataset(key: string): ExportDataset | undefined {
  return DATASETS.find((d) => d.key === key);
}
