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
export interface ExportDataset {
  key: string;
  label: string;
  // Underlying table whose primary key `id` identifies each row for deletion.
  table: string;
  columns: string[];
  rows: (profileId: number) => Record<string, unknown>[];
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
    rows: (profileId: number) => {
      const acts = db
        .prepare(
          `SELECT id, date, type, title, duration_min, distance_km, intensity, notes
           FROM activities WHERE profile_id = ? ORDER BY date DESC, id DESC`
        )
        .all(profileId) as {
        id: number;
        date: string;
        type: string;
        title: string;
        duration_min: number | null;
        distance_km: number | null;
        intensity: string | null;
        notes: string | null;
      }[];
      const sets = db
        .prepare(
          `SELECT s.activity_id, s.exercise, s.set_number, s.weight_kg, s.reps,
                  s.weight_kg_right, s.reps_right, s.duration_sec, s.duration_sec_right
           FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
           WHERE a.profile_id = ?
           ORDER BY s.activity_id, s.exercise, s.set_number`
        )
        .all(profileId) as (SetRow & {
        activity_id: number;
        exercise: string;
      })[];

      const byAct = new Map<number, (SetRow & { exercise: string })[]>();
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
    },
  },
  {
    key: "body_metrics",
    label: "Body metrics",
    table: "body_metrics",
    columns: ["date", "weight_kg", "body_fat_pct", "resting_hr", "notes"],
    rows: q(
      `SELECT id, date, weight_kg, body_fat_pct, resting_hr, notes
       FROM body_metrics WHERE profile_id = ? ORDER BY date DESC`
    ),
  },
  {
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
    rows: q(
      `SELECT id, date, category, name, canonical_name, value, value_num,
              unit, reference_range, flag, panel, notes
       FROM medical_records WHERE profile_id = ? ORDER BY date DESC, id DESC`
    ),
  },
  {
    key: "immunizations",
    label: "Immunizations",
    table: "immunizations",
    columns: ["date", "vaccine", "dose_label", "notes"],
    rows: q(
      `SELECT id, date, vaccine, dose_label, notes
       FROM immunizations WHERE profile_id = ? ORDER BY date DESC, id DESC`
    ),
  },
  {
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
    rows: q(
      `SELECT id, title, description, category, target_value, current_value,
              unit, target_date, status, created_at
       FROM goals WHERE profile_id = ? ORDER BY created_at DESC`
    ),
  },
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
    rows: (profileId: number) => {
      const items = db
        .prepare(
          `SELECT id, name, brand, product, condition, priority, situation,
                  stack, active, notes
           FROM intake_items WHERE profile_id = ? ORDER BY name`
        )
        .all(profileId) as Record<string, unknown>[];
      // Doses reach profile_id through the intake_items JOIN (child table); the
      // WHERE ii.profile_id = ? keeps this scoped just like the old dose dataset.
      const doses = db
        .prepare(
          `SELECT d.supplement_id, d.amount, d.time_of_day, d.food_timing
           FROM intake_item_doses d JOIN intake_items ii ON ii.id = d.supplement_id
           WHERE ii.profile_id = ? ORDER BY ii.name, d.sort, d.id`
        )
        .all(profileId) as {
        supplement_id: number;
        amount: string | null;
        time_of_day: string | null;
        food_timing: string | null;
      }[];

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
        const list = byItem.get(d.supplement_id);
        if (list) list.push(piece);
        else byItem.set(d.supplement_id, [piece]);
      }

      return items.map((it) => ({
        ...it,
        schedule: (byItem.get(it.id as number) ?? []).join("; "),
      }));
    },
  },
  {
    // Adherence log: one row per confirmed dose on a date. A child of
    // intake_items (joined via supplement_id), so browse/export-only.
    key: "intake_log",
    label: "Supplement & medication log",
    table: "intake_item_logs",
    deletable: false,
    columns: ["date", "item", "taken_at"],
    rows: q(
      `SELECT l.id, l.date, ii.name AS item, l.taken_at
       FROM intake_item_logs l JOIN intake_items ii ON ii.id = l.supplement_id
       WHERE ii.profile_id = ? ORDER BY l.date DESC, ii.name`
    ),
  },
  {
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
    rows: q(
      `SELECT id, substance, reaction, severity, status, onset_date, notes
       FROM allergies WHERE profile_id = ? ORDER BY substance`
    ),
  },
  {
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
    rows: q(
      `SELECT id, name, code, code_system, status, onset_date, resolved_date, notes
       FROM conditions WHERE profile_id = ? ORDER BY name`
    ),
  },
  {
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
    rows: q(
      `SELECT id, date, end_date, type, class_code, reason, diagnoses, notes
       FROM encounters WHERE profile_id = ? ORDER BY date DESC, id DESC`
    ),
  },
  {
    // Integration-synced daily/scalar samples (steps, distance, calories, HRV,
    // and the projected height / head-circumference points). Each carries id +
    // profile_id, so it's fully deletable like the other logged datasets.
    key: "metric_samples",
    label: "Metric samples",
    table: "metric_samples",
    columns: ["date", "metric", "value", "start_time", "end_time", "source"],
    rows: q(
      `SELECT id, date, metric, value, start_time, end_time, source
       FROM metric_samples WHERE profile_id = ?
       ORDER BY date DESC, metric, start_time DESC`
    ),
  },
  {
    // Per-minute heart-rate buckets (integration-synced). Keyed by
    // (profile_id, ts) with no single `id`, so browse/export-only.
    key: "hr_minutes",
    label: "Heart rate (per-minute)",
    table: "hr_minutes",
    deletable: false,
    columns: ["ts", "bpm", "bpm_min", "bpm_max", "n", "source"],
    rows: q(
      `SELECT ts, bpm, bpm_min, bpm_max, n, source
       FROM hr_minutes WHERE profile_id = ? ORDER BY ts DESC`
    ),
  },
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
}

export const DELETE_POLICY: Record<string, DatasetDeletePolicy> = {
  activities: { revalidate: ["/training", "/"] },
  body_metrics: { revalidate: ["/trends", "/"] },
  medical_records: {
    // Also refresh the import document subpages, which list these readings.
    revalidate: ["/biomarkers", "/biomarkers/view", "/import/[id]", "/"],
    cleanupStars: true,
  },
  immunizations: { revalidate: ["/immunizations", "/"] },
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
