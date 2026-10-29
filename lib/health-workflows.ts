import { createHash } from "node:crypto";
import { hoistedStatement, today, writeTx } from "./db";
import { addIntakeItemCore, updateIntakeItemCore } from "./intake-item-write";
import {
  intakeItemFormData,
  intakeItemFormStateFrom,
} from "./intake-form-fields";
import { setIntakeActive } from "./intake-active-write";
import { reassignDocumentCore } from "./document-reassign";
import { commitBiomarkersCore, commitWorkoutsCore } from "./import-commit";
import { restoreDeletedRow } from "./undo-delete-db";
import { TRASH_EXCLUDED_KINDS, trashEntry } from "./trash";
import {
  getTrashRetentionDays,
  getTimezone,
  deleteProfileSetting,
} from "./settings";
import { refillMarkerKey } from "./refill-nudge";
import { sqlNow } from "./clock";
import { parseLooseValue } from "./reference-range/parsing";
import { isRealIsoDate } from "./date";
import { CADENCE_KINDS } from "./intake-cadence";
import { FOOD_TIMINGS } from "./intake-schedule";
import {
  GOAL_PURPOSES,
  type IntakeItemPurpose,
  purposeToDraft,
  purposeLabel,
} from "./intake-purposes";
import {
  restartMedicationCourse,
  setCourseStartDate,
  setMedicationEndDate,
} from "./queries/intake/medications";
import type { IntakeItem, IntakeDose, MedicationCourse } from "./types";
import type { ImportResult } from "@/app/(app)/data/actions";

export type HealthWorkflow = "imports" | "documents" | "medications" | "trash";
type Value = string | number | boolean | null;
interface Field {
  name: string;
  label: string;
  type: "text" | "number" | "date" | "time" | "checkbox" | "select";
  value?: Value;
  required?: boolean;
  options?: { value: string; label: string }[];
}
interface Action {
  id: string;
  label: string;
  fields: Field[];
}
interface Item {
  id: string;
  revision: string;
  title: string;
  summary: string;
  facts: { label: string; value: string }[];
  actions: Action[];
  recordKey?: string;
}
export interface WorkflowActor {
  profileId: number;
  loginId: number;
  writable: boolean;
  destinations: { id: number; name: string }[];
}
interface Entry {
  item: Item;
  apply: (action: string, values: Record<string, Value>) => void;
}
export class WorkflowError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}
function fail(message: string, status = 400): never {
  throw new WorkflowError(status, message);
}

const text = (
  name: string,
  label: string,
  value = "",
  type: Field["type"] = "text",
  required = false
): Field => ({ name, label, type, value, required });
const select = (
  name: string,
  label: string,
  value: string,
  options: readonly string[]
): Field => ({
  ...text(name, label, value, "select", true),
  options: options.map((value) => ({ value, label: value })),
});
const confirm = (label: string): Field => ({
  name: "confirm",
  label,
  type: "checkbox",
  value: false,
  required: true,
});
const form = (id: string, label: string, fields: Field[] = []): Action => ({
  id,
  label,
  fields,
});
const revision = (profileId: number, id: string, state: unknown) =>
  createHash("sha256")
    .update(JSON.stringify([profileId, id, state]))
    .digest("base64url");
function entry(
  actor: WorkflowActor,
  id: string,
  title: string,
  summary: string,
  state: unknown,
  actions: Action[],
  apply: Entry["apply"],
  facts: Item["facts"] = []
): Entry {
  return {
    item: {
      id,
      revision: revision(actor.profileId, id, state),
      title,
      summary,
      facts,
      actions: actor.writable ? actions : [],
    },
    apply,
  };
}
function checkResult(result: { ok: boolean; error?: string }) {
  if (!result.ok) fail(result.error ?? "Reload before saving.");
}
function dateOrder(start: string, end: string) {
  if (start && end && start > end)
    fail("The start date must be on or before the end date.");
}

// Field definitions are also the write allowlist. No client-supplied column names,
// JSON, paths or engine arguments can escape the backend-issued form.
function valuesFor(action: Action, input: unknown): Record<string, Value> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return fail("values");
  const values = input as Record<string, unknown>;
  if (Object.keys(values).some((k) => !action.fields.some((f) => f.name === k)))
    fail("Unknown field.");
  const out: Record<string, Value> = {};
  for (const f of action.fields) {
    const v = values[f.name];
    if (f.type === "checkbox") {
      if (typeof v !== "boolean" || (f.required && !v)) fail(f.label);
    } else if (f.type === "number") {
      if (
        v !== null &&
        (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 1e9)
      )
        fail(f.label);
      if (f.required && v === null) fail(f.label);
    } else {
      if (typeof v !== "string" || v.length > 2000 || (f.required && !v.trim()))
        fail(f.label);
      if (f.type === "date" && v && !isRealIsoDate(v as string)) fail(f.label);
      if (
        f.type === "time" &&
        v &&
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(v as string)
      )
        fail(f.label);
      if (f.type === "select" && !f.options?.some((o) => o.value === v))
        fail(f.label);
    }
    out[f.name] = v as Value;
  }
  return out;
}

function documentEntry(actor: WorkflowActor, id: number): Entry | null {
  const p = actor.profileId;
  const doc = hoistedStatement(
    "SELECT * FROM medical_documents WHERE id = ? AND profile_id = ?"
  ).get(id, p) as
    | {
        filename: string;
        patient_name: string | null;
        extraction_status: string;
        document_date: string | null;
      }
    | undefined;
  if (!doc) return null;
  const choices = actor.destinations.filter((d) => d.id !== p);
  const actions = [
    form("select", "Select document", [confirm("Open this document")]),
  ];
  if (
    choices.length &&
    !["pending", "processing"].includes(doc.extraction_status)
  )
    actions.push(
      form("reassign", "Move document", [
        {
          name: "person",
          label: "Person",
          type: "select",
          required: true,
          value: "",
          options: choices.map((d) => ({ value: String(d.id), label: d.name })),
        },
        confirm("Move this document and all its records to this person"),
      ])
    );
  const e = entry(
    actor,
    `document:${id}`,
    doc.filename,
    doc.extraction_status,
    [doc, choices],
    actions,
    (action, values) => {
      if (action === "select") return;
      const fd = new FormData();
      fd.set("id", String(id));
      fd.set("destProfileId", String(values.person));
      const result = reassignDocumentCore(
        p,
        actor.loginId,
        actor.destinations.map((d) => d.id),
        fd
      );
      if (result.status !== "done") fail(result.message, 409);
    },
    [
      {
        label: "Person named in document",
        value: doc.patient_name ?? "Unknown",
      },
      { label: "Date", value: doc.document_date ?? "Unknown" },
    ]
  );
  e.item.recordKey = `document:${id}`;
  return e;
}

function trashEntryFor(actor: WorkflowActor, id: number): Entry | null {
  const row = hoistedStatement(
    "SELECT id, kind, label, payload, deleted_at AS deletedAt FROM deleted_rows WHERE id = ? AND profile_id = ?"
  ).get(id, actor.profileId) as
    | {
        id: number;
        kind: string;
        label: string;
        payload: string;
        deletedAt: string;
      }
    | undefined;
  if (!row || (TRASH_EXCLUDED_KINDS as readonly string[]).includes(row.kind))
    return null;
  const display = trashEntry(
    row,
    getTrashRetentionDays(),
    new Date(),
    getTimezone(actor.profileId)
  );
  return entry(
    actor,
    `trash:${id}`,
    display.title ?? display.label,
    display.notes ?? display.label,
    row,
    [
      form("restore", "Restore", [
        confirm("Restore this item and its saved related records"),
      ]),
    ],
    () => {
      if (!restoreDeletedRow(actor.profileId, id))
        fail("This item could not be restored. Reload Trash.", 409);
    },
    [
      { label: "Date", value: display.date ?? "Unknown" },
      { label: "Related records", value: String(display.childCount) },
    ]
  );
}

function medicationEntry(actor: WorkflowActor, id: number): Entry | null {
  const p = actor.profileId;
  const item =
    id === 0
      ? null
      : (hoistedStatement(
          `SELECT ii.*, COALESCE(s.name, ii.situation) AS situation, ps.name AS pause_situation,
    (SELECT name FROM providers WHERE id = ii.provider_id) AS provider_name
    FROM intake_items ii LEFT JOIN situations s ON s.id = ii.situation_id AND s.profile_id = ii.profile_id
    LEFT JOIN situations ps ON ps.id = ii.pause_situation_id AND ps.profile_id = ii.profile_id
    WHERE ii.id = ? AND ii.profile_id = ?`
        ).get(id, p) as IntakeItem | undefined);
  if (id && !item) return null;
  const doses = id
    ? (hoistedStatement(
        "SELECT d.* FROM intake_item_doses d JOIN intake_items i ON i.id = d.item_id WHERE d.item_id = ? AND i.profile_id = ? AND d.retired = 0 ORDER BY d.sort, d.id"
      ).all(id, p) as IntakeDose[])
    : [];
  const courses = id
    ? (hoistedStatement(
        "SELECT c.* FROM medication_courses c JOIN intake_items i ON i.id = c.item_id WHERE c.item_id = ? AND i.profile_id = ? ORDER BY c.started_on DESC, c.id DESC"
      ).all(id, p) as MedicationCourse[])
    : [];
  const ingredients = id
    ? (hoistedStatement(
        "SELECT g.* FROM intake_item_ingredients g JOIN intake_items i ON i.id = g.item_id WHERE g.item_id = ? AND i.profile_id = ? ORDER BY g.sort, g.id"
      ).all(id, p) as { name: string; amount_text: string | null }[])
    : [];
  const purposes = id
    ? (hoistedStatement(
        "SELECT g.* FROM intake_item_purposes g JOIN intake_items i ON i.id = g.item_id WHERE g.item_id = ? AND i.profile_id = ? ORDER BY g.sort, g.id"
      ).all(id, p) as IntakeItemPurpose[])
    : [];
  const pairs = id
    ? (hoistedStatement(
        "SELECT g.* FROM intake_item_pairs g JOIN intake_items i ON (i.id = g.a_id OR i.id = g.b_id) WHERE i.id = ? AND i.profile_id = ? ORDER BY g.a_id, g.b_id"
      ).all(id, p) as {
        a_id: number;
        b_id: number;
        relation: "with" | "separate";
        note: string | null;
      }[])
    : [];
  const state = intakeItemFormStateFrom({
    kind: item?.kind ?? "medication",
    item,
    doses,
    ingredients: ingredients.map((g) => ({
      name: g.name,
      amount: g.amount_text ?? "",
    })),
    purposes: purposes.flatMap((p) => {
      const draft = purposeToDraft(p);
      return draft ? [draft] : [];
    }),
    pairs: pairs.map((g) => ({
      otherId: g.a_id === id ? g.b_id : g.a_id,
      relation: g.relation,
      note: g.note ?? "",
    })),
  });
  const actions = [
    form("save", id ? "Save item" : "Create intake item", [
      text("name", "Name", state.name, "text", true),
      select("kind", "Kind", state.kind, ["medication", "supplement"]),
      text("brand", "Brand", state.brand),
      text("product", "Product", state.product),
      text("notes", "Notes", state.notes),
    ]),
  ];
  if (item) {
    actions.push(
      form(
        item.active ? "pause" : "resume",
        item.active ? "Pause item" : "Resume item",
        [
          confirm(
            item.active
              ? "Pause this item and close its open medication courses"
              : "Resume this item"
          ),
        ]
      )
    );
    actions.push(
      form("cadence", "Save schedule", [
        select("obligation", "Commitment", state.obligation, [
          "must",
          "should",
          "may",
        ]),
        confirm(
          "Apply this commitment; reducing it removes missed-dose escalation"
        ),
        select("cadence", "Cadence", state.cadence.kind, CADENCE_KINDS),
        text(
          "weekdays",
          "Weekdays (0 Sunday to 6 Saturday)",
          state.cadence.weekdays.join(",")
        ),
        {
          ...text("interval", "Interval in days", "", "number"),
          value: state.cadence.intervalDays
            ? Number(state.cadence.intervalDays)
            : null,
        },
        text("anchor", "Anchor date", state.cadence.anchorDate, "date"),
      ])
    );
    const slotFields = (n?: number): Field[] => {
      const d = n === undefined ? undefined : state.doses[n];
      return [
        text("amount", "Dose amount with unit", d?.amount ?? ""),
        text("time", "Time", d?.time_of_day ?? "", "time"),
        select("food", "Food timing", d?.food_timing ?? "any", FOOD_TIMINGS),
        text(
          "weekdays",
          "Weekdays (0 Sunday to 6 Saturday)",
          d?.weekdays.join(",") ?? ""
        ),
        text("start", "Start date", d?.start_date ?? "", "date"),
        text("end", "End date", d?.end_date ?? "", "date"),
      ];
    };
    actions.push(form("slot:add", "Add dose slot", slotFields()));
    state.doses.forEach((_, n) => {
      actions.push(form(`slot:${n}`, `Save dose slot ${n + 1}`, slotFields(n)));
      actions.push(
        form(`slot-remove:${n}`, `Remove dose slot ${n + 1}`, [
          confirm(
            "Remove this slot from the schedule; keep its administration history"
          ),
        ])
      );
    });
    actions.push(
      form("ingredient:add", "Add ingredient", [
        text("name", "Ingredient", "", "text", true),
        text("amount", "Amount with unit", "", "text", true),
      ])
    );
    state.ingredients.forEach((g, n) => {
      actions.push(
        form(`ingredient:${n}`, `Save ingredient ${n + 1}`, [
          text("name", "Ingredient", g.name, "text", true),
          text("amount", "Amount with unit", g.amount, "text", true),
        ])
      );
      actions.push(
        form(`ingredient-remove:${n}`, `Remove ingredient ${n + 1}`, [
          confirm("Remove this ingredient"),
        ])
      );
    });
    const conditions = hoistedStatement(
      "SELECT id, name FROM conditions WHERE profile_id = ? ORDER BY name LIMIT 200"
    ).all(p) as { id: number; name: string }[];
    const markers = hoistedStatement(
      "SELECT DISTINCT COALESCE(canonical_name, name) AS name FROM medical_records WHERE profile_id = ? ORDER BY name LIMIT 200"
    ).all(p) as { name: string }[];
    const purposeOptions = [
      ...GOAL_PURPOSES.map((g) => ({ value: `goal:${g.key}`, label: g.label })),
      ...conditions.map((c) => ({ value: `condition:${c.id}`, label: c.name })),
      ...markers.map((m) => ({ value: `biomarker:${m.name}`, label: m.name })),
    ];
    const purposeFields = (value = ""): Field[] => [
      {
        name: "purpose",
        label: "Purpose",
        type: "select",
        value,
        required: true,
        options: purposeOptions,
      },
    ];
    actions.push(form("purpose:add", "Add purpose", purposeFields()));
    purposes.forEach((g, n) => {
      const key = `${g.kind}:${g.goal_key ?? g.condition_id ?? g.biomarker_key}`;
      if (purposeOptions.some((o) => o.value === key))
        actions.push(
          form(`purpose:${n}`, `Save purpose ${n + 1}`, purposeFields(key))
        );
      actions.push(
        form(`purpose-remove:${n}`, `Remove purpose ${n + 1}`, [
          confirm("Remove this purpose"),
        ])
      );
    });
    if (item.kind === "medication") {
      if (!item.active)
        actions.push(
          form("course:add", "Start a new course", [
            text("start", "Start date", "", "date", true),
            confirm("Start a new medication course"),
          ])
        );
      courses.forEach((c) =>
        actions.push(
          form(
            `course:${c.id}`,
            `Save course ${c.started_on ?? "unknown start"}`,
            [
              text("start", "Start date", c.started_on ?? "", "date"),
              ...(c.id === courses[0]?.id
                ? [
                    text("end", "End date", c.stopped_on ?? "", "date"),
                    confirm(
                      "Apply these dates and the resulting active or stopped state"
                    ),
                  ]
                : []),
            ]
          )
        )
      );
    }
  }
  return entry(
    actor,
    id ? `intake:${id}` : "intake:new",
    item?.name ?? "New intake item",
    item ? (item.active ? "Active" : "Paused") : "Medication or supplement",
    [
      item,
      doses,
      courses,
      ingredients,
      purposes,
      pairs,
      id
        ? null
        : hoistedStatement(
            "SELECT COUNT(*) AS count, MAX(id) AS last FROM intake_items WHERE profile_id = ?"
          ).get(p),
    ],
    actions,
    (action, v) => {
      if (action === "pause" || action === "resume") {
        const result = setIntakeActive(p, id, action === "pause" ? 0 : 1);
        if (result !== "paused" && result !== "resumed")
          fail("Reload this item.", 409);
        return;
      }
      if (action === "course:add") {
        if (String(v.start) > today(p))
          fail("The start date cannot be in the future.");
        const result = restartMedicationCourse(p, id, String(v.start));
        if (result !== "restarted") fail("Reload the course.", 409);
        deleteProfileSetting(p, refillMarkerKey(id));
        return;
      }
      if (action.startsWith("course:")) {
        const course = courses.find(
          (c) => c.id === Number(action.split(":")[1])
        )!;
        const end = "end" in v ? String(v.end) : (course.stopped_on ?? "");
        dateOrder(String(v.start), end);
        if (String(v.start) > today(p) || end > today(p))
          fail("Course dates cannot be in the future.");
        writeTx((tx) => {
          if (
            setCourseStartDate(
              tx,
              p,
              id,
              course.id,
              String(v.start) || null
            ) !== "updated"
          )
            fail("Reload the course.", 409);
          if ("end" in v && end !== (course.stopped_on ?? "")) {
            const result = setMedicationEndDate(p, id, end || null);
            if (result === "not-found" || result === "no-course")
              fail("Reload the course.", 409);
          }
        });
        return;
      }
      if (action === "save") {
        state.name = String(v.name);
        state.kind = v.kind as typeof state.kind;
        state.brand = String(v.brand);
        state.product = String(v.product);
        state.notes = String(v.notes);
      } else if (action === "cadence") {
        state.obligation = v.obligation as typeof state.obligation;
        state.cadence = {
          kind: v.cadence as typeof state.cadence.kind,
          weekdays: weekdays(String(v.weekdays)),
          intervalDays: v.interval === null ? "" : String(v.interval),
          anchorDate: String(v.anchor),
        };
        if (state.cadence.kind === "weekly" && !state.cadence.weekdays.length)
          fail("Choose at least one weekday.");
        if (
          state.cadence.kind === "interval" &&
          (!Number.isInteger(v.interval) ||
            Number(v.interval) < 1 ||
            !state.cadence.anchorDate)
        )
          fail("Enter a positive interval and anchor date.");
      } else if (action.startsWith("slot-remove:"))
        state.doses.splice(Number(action.split(":")[1]), 1);
      else if (action.startsWith("slot:")) {
        dateOrder(String(v.start), String(v.end));
        const n =
          action === "slot:add"
            ? state.doses.length
            : Number(action.split(":")[1]);
        state.doses[n] = {
          ...state.doses[n],
          amount: String(v.amount),
          time_of_day: String(v.time),
          food_timing: v.food as IntakeDose["food_timing"],
          weekdays: weekdays(String(v.weekdays)),
          start_date: String(v.start),
          end_date: String(v.end),
        };
      } else if (action.startsWith("ingredient-remove:"))
        state.ingredients.splice(Number(action.split(":")[1]), 1);
      else if (action.startsWith("ingredient:"))
        state.ingredients[
          action === "ingredient:add"
            ? state.ingredients.length
            : Number(action.split(":")[1])
        ] = { name: String(v.name), amount: String(v.amount) };
      else if (action.startsWith("purpose-remove:"))
        state.purposes.splice(Number(action.split(":")[1]), 1);
      else if (action.startsWith("purpose:")) {
        const value = String(v.purpose);
        const kind = value.slice(0, value.indexOf(":"));
        const key = value.slice(value.indexOf(":") + 1);
        const n =
          action === "purpose:add"
            ? state.purposes.length
            : Number(action.split(":")[1]);
        state.purposes[n] =
          kind === "goal"
            ? { kind: "goal", goalKey: key }
            : kind === "condition"
              ? { kind: "condition", conditionId: Number(key) }
              : {
                  kind: "biomarker",
                  biomarkerKey: key,
                  direction:
                    state.purposes[n]?.kind === "biomarker"
                      ? state.purposes[n].direction
                      : null,
                };
      }
      const fd = intakeItemFormData(state);
      // Course editing has its own explicit form. Unrelated edits preserve course history.
      fd.delete("started_on");
      fd.delete("end_date");
      fd.delete("course_id");
      checkResult(id ? updateIntakeItemCore(p, fd) : addIntakeItemCore(p, fd));
    },
    [
      { label: "Kind", value: state.kind },
      { label: "Schedule", value: state.cadence.kind },
      { label: "Commitment", value: state.obligation },
      { label: "Notes", value: state.notes },
      ...state.doses.map((d) => ({
        label: "Dose slot",
        value: [
          d.amount,
          d.time_of_day,
          d.food_timing,
          d.weekdays.join(","),
          d.start_date,
          d.end_date,
        ]
          .filter(Boolean)
          .join(" · "),
      })),
      ...purposes.map((g) => ({
        label: "Purpose",
        value:
          purposeLabel(
            g,
            g.condition_id == null
              ? null
              : (
                  hoistedStatement(
                    "SELECT name FROM conditions WHERE id = ? AND profile_id = ?"
                  ).get(g.condition_id, p) as { name: string } | undefined
                )?.name
          ) ?? "Unknown",
      })),
      ...ingredients.map((g) => ({
        label: g.name,
        value: g.amount_text ?? "Unknown amount",
      })),
      ...courses.map((c) => ({
        label: "Course",
        value: `${c.started_on ?? "Unknown start"} – ${c.stopped_on ?? "Open"}`,
      })),
    ]
  );
}
function weekdays(raw: string): number[] {
  if (!raw.trim()) return [];
  if (!/^[0-6](,[0-6])*$/.test(raw))
    return fail("Use weekdays 0 through 6, separated by commas.");
  return [...new Set(raw.split(",").map(Number))].sort();
}

function importEntry(actor: WorkflowActor, id: number): Entry | null {
  const row = hoistedStatement(
    "SELECT * FROM import_jobs WHERE id = ? AND profile_id = ?"
  ).get(id, actor.profileId) as
    | {
        status: string;
        type: string;
        error: string | null;
        result_json: string | null;
      }
    | undefined;
  if (!row) return null;
  let result: ImportResult | null = null;
  try {
    result = row.result_json
      ? (JSON.parse(row.result_json) as ImportResult)
      : null;
  } catch {
    /* Corrupt extraction remains rejectable. */
  }
  const actions: Action[] = [];
  const facts: Item["facts"] = [{ label: "Status", value: row.status }];
  const ready = row.status === "ready" && result?.ok;
  if (ready && result) {
    if (result.type === "clinical-results") {
      facts.push({
        label: "Person named in extraction",
        value: result.meta?.patient_name ?? "Unknown",
      });
      result.results.forEach((r, n) => {
        facts.push({
          label: r.name,
          value: [
            r.value,
            r.unit,
            r.reference_range,
            r.flag,
            r.collected_date,
            r.notes,
          ]
            .filter(Boolean)
            .join(" · "),
        });
        actions.push(
          form(`correct:${n}`, `Correct ${r.name}`, [
            text("value", "Value", r.value ?? ""),
            text("unit", "Unit", r.unit ?? ""),
            text("date", "Collected date", r.collected_date ?? "", "date"),
            text("notes", "Notes", r.notes ?? ""),
          ])
        );
      });
      result.immunizations?.forEach((r) =>
        facts.push({
          label: r.vaccine,
          value: [r.date, r.dose_label, r.notes].filter(Boolean).join(" · "),
        })
      );
    } else {
      result.workouts.forEach((w, n) => {
        facts.push({
          label: w.title ?? "Workout",
          value: `${w.date}: ${w.sets.map((s) => `${s.exercise}: ${s.weight ?? ""} ${s.weight_unit ?? ""}, ${s.reps ?? ""} reps`).join("; ")}`,
        });
        actions.push(
          form(`correct:${n}`, `Correct workout ${n + 1}`, [
            text("title", "Title", w.title ?? ""),
            text("date", "Date", w.date ?? "", "date", true),
            text("notes", "Notes", w.notes ?? ""),
          ])
        );
      });
    }
    actions.push(
      form("commit", "Commit reviewed import", [
        confirm(
          "I reviewed every extracted fact and conflict and confirm this import belongs to the selected person"
        ),
      ])
    );
  }
  if (!["processing", "committing"].includes(row.status))
    actions.push(
      form("reject", "Reject import", [
        confirm("Discard this uncommitted extraction"),
      ])
    );
  return entry(
    actor,
    `import:${id}`,
    `Import ${id}`,
    row.error ?? row.type,
    row,
    actions,
    (action, v) => {
      if (action === "reject") {
        hoistedStatement(
          "DELETE FROM import_jobs WHERE id = ? AND profile_id = ?"
        ).run(id, actor.profileId);
        return;
      }
      if (!result) return fail("Extraction unavailable.", 409);
      if (action === "commit") {
        const outcome =
          result.type === "clinical-results"
            ? commitBiomarkersCore(
                actor.profileId,
                result.results,
                result.meta,
                result.immunizations
              )
            : commitWorkoutsCore(
                actor.profileId,
                actor.loginId,
                result.workouts
              );
        checkResult(outcome);
        hoistedStatement(
          "DELETE FROM import_jobs WHERE id = ? AND profile_id = ?"
        ).run(id, actor.profileId);
      } else {
        const n = Number(action.split(":")[1]);
        if (result.type === "clinical-results") {
          const r = result.results[n];
          const value = String(v.value);
          // A changed display value must never retain the extractor's old numeric value.
          const parsed = parseLooseValue(value);
          const numeric = parsed && !parsed.bound ? parsed.value : null;
          Object.assign(r, {
            value: value || null,
            value_num: numeric,
            unit: String(v.unit) || null,
            collected_date: String(v.date) || null,
            notes: String(v.notes) || null,
          });
        } else
          Object.assign(result.workouts[n], {
            title: String(v.title),
            date: String(v.date),
            notes: String(v.notes) || null,
          });
        hoistedStatement(
          "UPDATE import_jobs SET result_json = ?, updated_at = ? WHERE id = ? AND profile_id = ?"
        ).run(JSON.stringify(result), sqlNow(), id, actor.profileId);
      }
    },
    facts
  );
}
const readers = {
  imports: importEntry,
  documents: documentEntry,
  medications: medicationEntry,
  trash: trashEntryFor,
} satisfies Record<
  HealthWorkflow,
  (actor: WorkflowActor, id: number) => Entry | null
>;
const prefixes = {
  imports: "import",
  documents: "document",
  medications: "intake",
  trash: "trash",
} as const;

export function listHealthWorkflow(
  actor: WorkflowActor,
  kind: HealthWorkflow,
  q: string,
  cursor: string,
  id = ""
) {
  // One item by its id (a record page's read): itself, or none.
  if (id) {
    const match = new RegExp(`^${prefixes[kind]}:([1-9][0-9]*)$`).exec(id);
    if (!match || q || cursor) fail("id");
    const e = readers[kind](actor, Number(match[1]));
    return { items: e ? [e.item] : [], next: null };
  }
  const offset = cursor
    ? Number(Buffer.from(cursor, "base64url").toString("utf8"))
    : 0;
  if (
    (cursor && Buffer.from(String(offset)).toString("base64url") !== cursor) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 100000
  )
    fail("cursor");
  if (q.length > 200) fail("q");
  const pattern = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  let rows: { id: number }[];
  // All query shapes are fixed here; neither a table nor a column comes from a form.
  if (kind === "imports")
    rows = hoistedStatement(
      "SELECT id FROM import_jobs WHERE profile_id = ? AND (type LIKE ? ESCAPE '\\' OR COALESCE(error, '') LIKE ? ESCAPE '\\') ORDER BY id DESC LIMIT 26 OFFSET ?"
    ).all(actor.profileId, pattern, pattern, offset) as { id: number }[];
  else if (kind === "documents")
    rows = hoistedStatement(
      "SELECT id FROM medical_documents WHERE profile_id = ? AND (filename LIKE ? ESCAPE '\\' OR COALESCE(patient_name, '') LIKE ? ESCAPE '\\') ORDER BY id DESC LIMIT 26 OFFSET ?"
    ).all(actor.profileId, pattern, pattern, offset) as { id: number }[];
  else if (kind === "medications")
    rows = hoistedStatement(
      "SELECT id FROM intake_items WHERE profile_id = ? AND name LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 26 OFFSET ?"
    ).all(actor.profileId, pattern, offset) as { id: number }[];
  else
    rows = hoistedStatement(
      `SELECT id FROM deleted_rows WHERE profile_id = ? AND kind NOT IN (${TRASH_EXCLUDED_KINDS.map(() => "?").join(",")}) AND (label LIKE ? ESCAPE '\\' OR payload LIKE ? ESCAPE '\\') ORDER BY id DESC LIMIT 26 OFFSET ?`
    ).all(
      actor.profileId,
      ...TRASH_EXCLUDED_KINDS,
      pattern,
      pattern,
      offset
    ) as { id: number }[];
  const items = rows.slice(0, 25).flatMap((row) => {
    const e = readers[kind](actor, row.id);
    return e ? [e.item] : [];
  });
  if (kind === "medications" && !cursor && !q && actor.writable)
    items.unshift(medicationEntry(actor, 0)!.item);
  return {
    items,
    next:
      rows.length > 25
        ? Buffer.from(String(offset + 25)).toString("base64url")
        : null,
  };
}

// Resolve write access and load the form again under the same IMMEDIATE lock as
// the engine write. Throwing a refusal rolls back nested engine savepoints too.
export function applyHealthWorkflow(
  kind: HealthWorkflow,
  body: Record<string, unknown>,
  resolveActor: () => WorkflowActor
): void {
  writeTx(() => {
    const actor = resolveActor();
    if (!actor.writable) fail("access", 403);
    if (
      Object.keys(body).some(
        (k) => !["id", "revision", "action", "values"].includes(k)
      )
    )
      fail("Unknown field.");
    if (
      typeof body.id !== "string" ||
      typeof body.revision !== "string" ||
      typeof body.action !== "string"
    )
      fail("form");
    const match = new RegExp(`^${prefixes[kind]}:(new|[1-9][0-9]*)$`).exec(
      body.id
    );
    if (!match || (match[1] === "new" && kind !== "medications"))
      fail("item", 409);
    const rowId = match[1] === "new" ? 0 : Number(match[1]);
    if (!Number.isSafeInteger(rowId)) fail("item", 409);
    const e = readers[kind](actor, rowId);
    if (!e || e.item.revision !== body.revision)
      fail("This item changed. Reload before saving.", 409);
    const action = e.item.actions.find((a) => a.id === body.action);
    if (!action) fail("action");
    e.apply(action.id, valuesFor(action, body.values));
  });
}
