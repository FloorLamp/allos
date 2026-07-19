import { db } from "./db";
import { summarizeExercise, type SetRow } from "./journal-format";
import { baseLiftName } from "./lifts";
import { toCsv } from "./csv";

// Re-exported so existing importers (`@/lib/export`) keep working; the pure
// implementation lives in lib/csv.ts for isolated unit testing.
export { toCsv };

// Datasets exposed on the Data → Export tab. Each is a flat table with a stable
// column order used for both the on-screen preview and the CSV download. Every
// row also carries an `id` (the primary key of `table`) — not shown in `columns`
// or the CSV, but used by the management UI to select and delete rows.
// The Data page shows PAGE_SIZE rows per dataset table; the same size drives the
// bounded `page()` reads below so a visit ships one page, not the whole table
// (issue #113 — /data used to serialize every dataset in full).
export const PAGE_SIZE = 25;

export interface ExportDataset {
  key: string;
  label: string;
  // Underlying table whose primary key `id` identifies each row for deletion.
  table: string;
  columns: string[];
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
function tableDataset(cfg: {
  key: string;
  label: string;
  table: string;
  columns: string[];
  select: string;
  countSql: string;
  deletable?: boolean;
}): ExportDataset {
  return {
    key: cfg.key,
    label: cfg.label,
    table: cfg.table,
    columns: cfg.columns,
    deletable: cfg.deletable,
    rows: q(cfg.select),
    page: qPage(cfg.select),
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

// Columns selected from `activities` (shared by the full + bounded reads). Carries
// the full device/Strava telemetry, not just the display projection (#466).
const ACTIVITY_COLUMNS = `id, date, type, title, duration_min, distance_km, intensity,
          start_time, end_time, avg_hr, max_hr, elevation_m, avg_power_w, avg_cadence,
          kilojoules, est_calories, workout_type, source, external_id, notes`;
// Exercise-sets read, scoped to the profile through the activities JOIN. The page
// reader appends `AND s.activity_id IN (...)` to fetch only the shown activities'
// sets; the export reader takes them all. Kept as one const so both share the
// (profile-scoped) FROM/WHERE.
const SETS_SELECT = `SELECT s.activity_id, s.exercise, s.set_number, s.weight_kg, s.reps,
          s.weight_kg_right, s.reps_right, s.duration_sec, s.duration_sec_right
   FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
   WHERE a.profile_id = ?`;

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

// Parent intake_items read (supplements + medications). The page reader appends
// LIMIT/OFFSET; both filter profile_id directly.
const ITEMS_SELECT = `SELECT id, name, kind, brand, product, condition, priority, situation,
          stack, active, critical, as_needed, prescriber, pharmacy, rx_number,
          quantity_on_hand, notes
   FROM intake_items WHERE profile_id = ?`;
// Dose-schedule read, scoped to the profile through the intake_items JOIN. The
// page reader appends `AND d.item_id IN (...)` to fetch only the shown
// items' doses.
const DOSES_SELECT = `SELECT d.item_id, d.amount, d.time_of_day, d.food_timing
   FROM intake_item_doses d JOIN intake_items ii ON ii.id = d.item_id
   WHERE ii.profile_id = ?`;

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
const PROVIDER_LINK_SELECTS = [
  `SELECT provider_id AS pid FROM encounters WHERE profile_id = ? AND provider_id IS NOT NULL`,
  `SELECT location_provider_id AS pid FROM encounters WHERE profile_id = ? AND location_provider_id IS NOT NULL`,
  `SELECT provider_id AS pid FROM procedures WHERE profile_id = ? AND provider_id IS NOT NULL`,
  `SELECT provider_id AS pid FROM appointments WHERE profile_id = ? AND provider_id IS NOT NULL`,
  `SELECT provider_id AS pid FROM care_plan_items WHERE profile_id = ? AND provider_id IS NOT NULL`,
  `SELECT provider_id AS pid FROM immunizations WHERE profile_id = ? AND provider_id IS NOT NULL`,
  `SELECT provider_id AS pid FROM medical_records WHERE profile_id = ? AND provider_id IS NOT NULL`,
  `SELECT provider_id AS pid FROM intake_items WHERE profile_id = ? AND provider_id IS NOT NULL`,
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

function providerRows(profileId: number): Record<string, unknown>[] {
  const ids = referencedProviderIds(profileId);
  if (ids.length === 0) return [];
  const ph = ids.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT id, name, type, npi, identifier, phone, address
         FROM providers WHERE id IN (${ph}) ORDER BY name, id`
    )
    .all(...ids) as Record<string, unknown>[];
}

const providersDataset: ExportDataset = {
  key: "providers",
  label: "Providers",
  table: "providers",
  deletable: false,
  columns: PROVIDER_COLUMNS,
  rows: providerRows,
  count: (profileId) => referencedProviderIds(profileId).length,
  page: (profileId, limit, offset) =>
    providerRows(profileId).slice(offset, offset + limit),
};

export const DATASETS: ExportDataset[] = [
  {
    // Activities and their exercise sets combined: one row per activity, with an
    // `exercises` summary that folds in the sets using the shortened (base) lift
    // name (e.g. "Barbell Bench Press" -> "Bench Press") and a compact per-set
    // summary. Cardio/sport rows simply have an empty `exercises` cell.
    key: "activities",
    label: "Activities",
    table: "activities",
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
    count: qCount(`SELECT COUNT(*) AS n FROM activities WHERE profile_id = ?`),
    rows: (profileId: number) => {
      const acts = db
        .prepare(
          `SELECT ${ACTIVITY_COLUMNS}
           FROM activities WHERE profile_id = ? ORDER BY date DESC, id DESC`
        )
        .all(profileId) as ActivityRow[];
      const sets = db
        .prepare(
          `${SETS_SELECT} ORDER BY s.activity_id, s.exercise, s.set_number`
        )
        .all(profileId) as ActivitySet[];
      return shapeActivities(acts, sets);
    },
    page: (profileId: number, limit: number, offset: number) => {
      const acts = db
        .prepare(
          `SELECT ${ACTIVITY_COLUMNS}
           FROM activities WHERE profile_id = ? ORDER BY date DESC, id DESC
           LIMIT ? OFFSET ?`
        )
        .all(profileId, limit, offset) as ActivityRow[];
      if (acts.length === 0) return [];
      // Fetch sets only for the shown activities (still profile-scoped via the
      // JOIN); the id list comes from the profile-scoped page query above.
      const ph = acts.map(() => "?").join(",");
      const sets = db
        .prepare(
          `${SETS_SELECT} AND s.activity_id IN (${ph})
           ORDER BY s.activity_id, s.exercise, s.set_number`
        )
        .all(profileId, ...acts.map((a) => a.id)) as ActivitySet[];
      return shapeActivities(acts, sets);
    },
  },
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
    key: "body_metrics",
    label: "Body metrics",
    table: "body_metrics",
    // source + edited carry provenance (which integration wrote it, whether a hand
    // edit locked it) that the export used to drop (#466).
    columns: [
      "date",
      "weight_kg",
      "body_fat_pct",
      "resting_hr",
      "source",
      "edited",
      "notes",
    ],
    select: `SELECT id, date, weight_kg, body_fat_pct, resting_hr, source, edited, notes
       FROM body_metrics WHERE profile_id = ? ORDER BY date DESC`,
    countSql: `SELECT COUNT(*) AS n FROM body_metrics WHERE profile_id = ?`,
  }),
  tableDataset({
    key: "medical_records",
    label: "Biomarkers & records",
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
    key: "immunizations",
    label: "Immunizations",
    table: "immunizations",
    columns: ["date", "vaccine", "dose_label", "notes"],
    select: `SELECT id, date, vaccine, dose_label, notes
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
    // Endurance event plans (#839) — user-entered training goals a migrating family keeps
    // (event, discipline, target distance/time, status). The weekly trajectory is derived,
    // never stored, so nothing but the goal is exported here.
    key: "endurance_plans",
    label: "Event plans",
    table: "endurance_plans",
    columns: [
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
    select: `SELECT id, event_name, discipline, event_date, target_distance_km, target_time_sec,
              status, notes, completed_on, created_at
       FROM endurance_plans WHERE profile_id = ? ORDER BY event_date DESC, id DESC`,
    countSql: `SELECT COUNT(*) AS n FROM endurance_plans WHERE profile_id = ?`,
  }),
  {
    // Supplements + medications (the parent intake_items rows), one per row, with
    // each item's dose SCHEDULE folded into a readable `schedule` summary (built
    // in JS from its intake_item_doses children, ordered by sort — e.g.
    // "morning × 1 cap; evening × 2 tab (with food)"). Keeping the row at the
    // item level preserves the edit/delete model: deleting a row removes the
    // parent intake_items (its doses/logs cascade). The dose schedule is
    // read-only here — dose editing lives on /medicine.
    key: "supplements",
    label: "Supplements & Medications",
    table: "intake_items",
    columns: [
      "name",
      "kind",
      "brand",
      "product",
      "condition",
      "priority",
      "situation",
      "stack",
      "active",
      "critical",
      "as_needed",
      "prescriber",
      "pharmacy",
      "rx_number",
      "quantity_on_hand",
      "notes",
      "schedule",
    ],
    count: qCount(
      `SELECT COUNT(*) AS n FROM intake_items WHERE profile_id = ?`
    ),
    rows: (profileId: number) => {
      const items = db
        .prepare(`${ITEMS_SELECT} ORDER BY name`)
        .all(profileId) as Record<string, unknown>[];
      // Doses reach profile_id through the intake_items JOIN (child table); the
      // WHERE ii.profile_id = ? keeps this scoped just like the old dose dataset.
      const doses = db
        .prepare(`${DOSES_SELECT} ORDER BY ii.name, d.sort, d.id`)
        .all(profileId) as DoseRow[];
      return shapeSupplements(items, doses);
    },
    page: (profileId: number, limit: number, offset: number) => {
      const items = db
        .prepare(`${ITEMS_SELECT} ORDER BY name LIMIT ? OFFSET ?`)
        .all(profileId, limit, offset) as Record<string, unknown>[];
      if (items.length === 0) return [];
      // Fetch doses only for the shown items (still profile-scoped via the JOIN);
      // the id list comes from the profile-scoped page query above.
      const ph = items.map(() => "?").join(",");
      const doses = db
        .prepare(
          `${DOSES_SELECT} AND d.item_id IN (${ph})
           ORDER BY ii.name, d.sort, d.id`
        )
        .all(profileId, ...items.map((it) => it.id)) as DoseRow[];
      return shapeSupplements(items, doses);
    },
  },
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
    columns: ["date", "item", "status", "taken_at", "amount", "skip_reason"],
    select: `SELECT l.id, l.date, ii.name AS item, l.status, l.taken_at, l.amount,
              l.skip_reason
       FROM intake_item_logs l JOIN intake_items ii ON ii.id = l.item_id
       WHERE ii.profile_id = ? ORDER BY l.date DESC, ii.name`,
    countSql: `SELECT COUNT(*) AS n
       FROM intake_item_logs l JOIN intake_items ii ON ii.id = l.item_id
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
      "onset_date",
      "notes",
    ],
    select: `SELECT id, substance, reaction, severity, status, onset_date, notes
       FROM allergies WHERE profile_id = ? ORDER BY substance`,
    countSql: `SELECT COUNT(*) AS n FROM allergies WHERE profile_id = ?`,
  }),
  tableDataset({
    key: "conditions",
    label: "Conditions",
    table: "conditions",
    columns: [
      "name",
      "code",
      "code_system",
      "status",
      "onset_date",
      "resolved_date",
      "notes",
    ],
    select: `SELECT id, name, code, code_system, status, onset_date, resolved_date, notes
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
    // and the projected height / head-circumference points). Each carries id +
    // profile_id, so it's fully deletable like the other logged datasets.
    key: "metric_samples",
    label: "Metric samples",
    table: "metric_samples",
    columns: ["date", "metric", "value", "start_time", "end_time", "source"],
    select: `SELECT id, date, metric, value, start_time, end_time, source
       FROM metric_samples WHERE profile_id = ?
       ORDER BY date DESC, metric, start_time DESC`,
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
      "indication",
      "status",
      "notes",
    ],
    select: `SELECT id, modality, body_region, laterality, contrast, contrast_agent,
              study_date, impression, indication, status, notes
       FROM imaging_studies WHERE profile_id = ?
       ORDER BY COALESCE(study_date, '') DESC, id DESC`,
    countSql: `SELECT COUNT(*) AS n FROM imaging_studies WHERE profile_id = ?`,
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
      "condition",
      "code",
      "code_system",
      "onset_age",
      "deceased",
      "notes",
    ],
    select: `SELECT id, relation, condition, code, code_system, onset_age, deceased, notes
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
    columns: ["scheduled_at", "title", "location", "status", "notes"],
    select: `SELECT id, scheduled_at, title, location, status, notes
       FROM appointments WHERE profile_id = ? ORDER BY scheduled_at DESC, id DESC`,
    countSql: `SELECT COUNT(*) AS n FROM appointments WHERE profile_id = ?`,
  }),
  tableDataset({
    key: "immunization_overrides",
    label: "Immunization overrides",
    table: "immunization_overrides",
    columns: ["vaccine", "kind", "reason", "note"],
    select: `SELECT id, vaccine, kind, reason, note
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
    key: "food_log",
    label: "Food log",
    table: "food_log",
    columns: ["date", "group_key", "servings", "notes"],
    select: `SELECT id, date, group_key, servings, notes
       FROM food_log WHERE profile_id = ? ORDER BY date DESC, group_key`,
    countSql: `SELECT COUNT(*) AS n FROM food_log WHERE profile_id = ?`,
  }),
  tableDataset({
    // Food-log EVENT ledger (#950): one append-only row per serving TAP, carrying the
    // tap `logged_at` (a UTC instant) beside the food day. It's the timing layer behind
    // slot-aware button ranking; the food_log counter stays the day's data of record.
    // User-entered health data, so it's in the portable export; id-keyed + owned, so
    // deletable like the other logged datasets (a wipe just degrades ranking to overall
    // frecency — the food_log counter is untouched).
    key: "food_log_events",
    label: "Food log events",
    table: "food_log_events",
    columns: ["date", "group_key", "logged_at"],
    select: `SELECT id, date, group_key, logged_at
       FROM food_log_events WHERE profile_id = ? ORDER BY logged_at DESC`,
    countSql: `SELECT COUNT(*) AS n FROM food_log_events WHERE profile_id = ?`,
  }),
  tableDataset({
    // Protein-grams quick-add log (#824): one row per date with a running gram total
    // (protein powder / shakes have no food-group home). User-entered health data, so
    // it's in the portable export; id-keyed + owned, deletable like the other logged
    // datasets.
    key: "protein_log",
    label: "Protein log",
    table: "protein_log",
    columns: ["date", "grams"],
    select: `SELECT id, date, grams
       FROM protein_log WHERE profile_id = ? ORDER BY date DESC`,
    countSql: `SELECT COUNT(*) AS n FROM protein_log WHERE profile_id = ?`,
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
  revalidate: string[];
  cleanupStars?: boolean;
  // Whether removing rows can orphan an `immunization:<code>` due-nudge dismissal
  // (upcoming_dismissals) — set for the immunizations dataset so a bulk delete runs
  // the same losing-backing sweep the per-dose delete/edit paths do (issue #376).
  // Same name-recycling class as cleanupStars, one table over.
  cleanupImmunizations?: boolean;
}

export const DELETE_POLICY: Record<string, DatasetDeletePolicy> = {
  activities: { revalidate: ["/training", "/"] },
  body_metrics: { revalidate: ["/trends", "/"] },
  medical_records: {
    // Also refresh the import document subpages, which list these readings.
    revalidate: ["/biomarkers", "/biomarkers/view", "/import/[id]", "/"],
    cleanupStars: true,
  },
  immunizations: {
    revalidate: ["/immunizations", "/"],
    cleanupImmunizations: true,
  },
  goals: { revalidate: ["/training", "/"] },
  injuries: { revalidate: ["/training", "/timeline", "/"] },
  endurance_plans: { revalidate: ["/training", "/timeline", "/upcoming", "/"] },
  supplements: { revalidate: ["/nutrition", "/medications", "/"] },
  allergies: { revalidate: ["/allergies", "/"] },
  conditions: { revalidate: ["/conditions", "/"] },
  encounters: { revalidate: ["/encounters", "/"] },
  metric_samples: { revalidate: ["/trends", "/"] },
  // Clinical passport domains newly exported/deletable (#465).
  procedures: { revalidate: ["/procedures", "/"] },
  genomic_variants: { revalidate: ["/genomics", "/"] },
  imaging_studies: { revalidate: ["/imaging", "/"] },
  optical_prescriptions: { revalidate: ["/vision", "/"] },
  family_history: { revalidate: ["/family-history", "/"] },
  care_plan_items: { revalidate: ["/care-plan", "/"] },
  care_goals: { revalidate: ["/care-goals", "/"] },
  appointments: { revalidate: ["/encounters", "/upcoming", "/"] },
  immunization_overrides: { revalidate: ["/immunizations", "/"] },
  preventive_events: { revalidate: ["/upcoming", "/"] },
  preventive_overrides: { revalidate: ["/upcoming", "/"] },
  protocols: { revalidate: ["/protocols", "/"] },
  milestones: { revalidate: ["/"] },
  equipment: { revalidate: ["/settings/equipment", "/training"] },
  frequency_targets: { revalidate: ["/training", "/"] },
  food_log: { revalidate: ["/nutrition", "/trends", "/"] },
  food_log_events: { revalidate: ["/nutrition", "/"] },
  protein_log: { revalidate: ["/nutrition", "/"] },
  symptom_logs: { revalidate: ["/", "/timeline"] },
};

export function getDataset(key: string): ExportDataset | undefined {
  return DATASETS.find((d) => d.key === key);
}

// Datasets tied to the age-gated fitness surfaces (Activities, Goals). Restricted
// profiles have these hidden across the app (see lib/age-gate.ts) — the export UI
// filters them from the card list, and the AUTHORITATIVE layers enforce it too
// (issue #471): the per-dataset CSV route 404s a restricted one, and the full-ZIP
// snapshot omits them. Lives here beside DATASETS so the UI list and the route/ZIP
// gate share one source of truth rather than each spelling the set out.
export const RESTRICTED_DATASETS = new Set(["activities", "goals"]);
