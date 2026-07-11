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
  notes: string | null;
};
type ActivitySet = SetRow & { activity_id: number; exercise: string };

// Columns selected from `activities` (shared by the full + bounded reads).
const ACTIVITY_COLUMNS = `id, date, type, title, duration_min, distance_km, intensity, notes`;
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
const ITEMS_SELECT = `SELECT id, name, brand, product, condition, priority, situation,
          stack, active, notes
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
    key: "body_metrics",
    label: "Body metrics",
    table: "body_metrics",
    columns: ["date", "weight_kg", "body_fat_pct", "resting_hr", "notes"],
    select: `SELECT id, date, weight_kg, body_fat_pct, resting_hr, notes
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
      "notes",
    ],
    select: `SELECT id, date, category, name, canonical_name, value, value_num,
              unit, reference_range, flag, panel, notes
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
      "brand",
      "product",
      "condition",
      "priority",
      "situation",
      "stack",
      "active",
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
    columns: ["date", "item", "taken_at"],
    select: `SELECT l.id, l.date, ii.name AS item, l.taken_at
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
  supplements: { revalidate: ["/medicine", "/"] },
  allergies: { revalidate: ["/allergies", "/"] },
  conditions: { revalidate: ["/conditions", "/"] },
  encounters: { revalidate: ["/encounters", "/"] },
  metric_samples: { revalidate: ["/trends", "/"] },
};

export function getDataset(key: string): ExportDataset | undefined {
  return DATASETS.find((d) => d.key === key);
}
