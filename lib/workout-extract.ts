import Anthropic from "@anthropic-ai/sdk";
import { AI_MODEL, aiConfigured, createAiClient } from "./ai-client";
import { describeError } from "./medical-extract";
import { createLogger } from "./log";
import { recordAiEvent, capDetail, LOG_PROMPTS, usageFrom } from "./ai-log";
import { strOrNull } from "./parse";

const log = createLogger("workout-extract");

const MODEL = AI_MODEL;
const MAX_TOKENS = Number(process.env.HEALTH_AI_MAX_TOKENS) || 16000;

// One resistance-training set. Weight is reported in its source unit so the
// server can convert to kg; duration_sec carries isometric holds (planks).
export interface ExtractedSet {
  exercise: string;
  weight: number | null;
  weight_unit: "kg" | "lb" | null;
  reps: number | null;
  duration_sec: number | null;
  // Right-side load for per-side (asymmetric) sets, in the same weight_unit;
  // null for normal bilateral sets. weight/reps are then the left side.
  weight_right: number | null;
  reps_right: number | null;
  // The user-defined equipment/implement this set used (e.g. an EZ-curl bar or
  // trap bar), matched to a name from the provided equipment list. Null when the
  // variation isn't one of the user's defined implements.
  equipment: string | null;
  // The rep target the set was aiming for (schema + manual UI field). Null when
  // the log states only what was performed. #420. Optional so existing ExtractedSet
  // fixtures need no change; normalize() always sets it.
  target_reps?: number | null;
  // Whether the set was taken to muscular failure (an "AMRAP"/"to failure"/"F"
  // annotation). 1/0/null — 1 only when the source clearly says so. #420
  to_failure?: number | null;
}

export interface ExtractedWorkout {
  date: string | null; // YYYY-MM-DD
  title: string | null;
  notes: string | null;
  // Session-level effort (easy | moderate | hard), when the log annotates it —
  // enforced structurally to that enum (else null). #420. Optional so existing
  // ExtractedWorkout fixtures need no change; normalize() always sets these.
  intensity?: string | null;
  // Clock start/end of the session ("HH:MM" or an ISO timestamp) and total
  // duration in whole minutes, when the log carries them. #420
  start_time?: string | null;
  end_time?: string | null;
  duration_min?: number | null;
  sets: ExtractedSet[];
}

export type WorkoutExtractionResult =
  | {
      status: "done";
      workouts: ExtractedWorkout[];
      // Count of pure-cardio rows (runs/rides/distances/paces) the extractor
      // deliberately skipped — the paste path stays strength-only, but the skip is
      // now reported structurally instead of dropped silently. #420
      cardioSkipped: number;
      model: string;
      raw: string;
    }
  | { status: "skipped"; message: string }
  | { status: "failed"; error: string };

const SYSTEM = `You are a strength-training data-extraction engine. You are given a
CSV or free-text log of resistance-training workouts. Extract it into structured
workouts by calling the save_workouts tool exactly once.

Rules:
- Group sets into workouts by their date (and session, if distinguishable). One
  workout per date unless the data clearly separates multiple sessions in a day.
- Emit ONE entry per set. If a row says "3 x 5 @ 100kg" (3 sets of 5), expand it
  into 3 identical set entries. If a row gives per-set reps like "8,8,7", emit one
  entry per listed value.
- exercise: the movement name, Title Case. Combine the movement with its
  equipment/variation when picking the name, and REUSE a catalog name when one
  matches exactly — e.g. a dumbbell curl → "Dumbbell Curl", a cable row → "Cable
  Row". If the equipment/variation is NOT one of the catalog's variants (e.g.
  "Curl Bar"/EZ-bar, "Trap Bar", "Seated", "Hack"), use the base movement's
  catalog name (e.g. "Curl", "Deadlift") rather than inventing a new one.
- equipment: if the row's implement/variation matches one of the user's defined
  equipment names (provided separately), set this to that EXACT equipment name;
  otherwise null. This records a specialty bar (e.g. "Curl Bar", "Trap Bar")
  the catalog can't name. It does NOT change the weight — logged weight is always
  the total load, never plates-only.
- Per-side sets: when a set is logged separately for left and right (e.g.
  "L15x15 R15x12", "15x15x3L, 15x12x3R", "L45x12x3 R45x8x3"), pair the sides
  into single entries — left in weight/reps, right in weight_right/reps_right
  (same weight_unit). Pair by order; if one side has extra sets, leave the other
  side null on those.
- weight + weight_unit: the load as a number plus its unit ("kg" or "lb"). Infer
  the unit from headers/symbols ("lb", "lbs", "#" → lb; "kg" → kg). If no unit is
  given, leave weight_unit null. Bodyweight/no load → weight null.
- reps: integer reps for the set, else null.
- duration_sec: for timed holds (planks, dead hangs) ONLY, the hold time in whole
  seconds (convert m:ss → seconds). Otherwise null. A set has reps OR duration,
  not both.
- target_reps: the rep TARGET when the log states one distinctly from what was
  performed (e.g. "3x8 target, got 8,8,7" → target_reps 8). Null otherwise.
- to_failure: 1 when the set is explicitly taken to failure — "AMRAP", "to failure",
  "F", "failure", "max reps". Else 0/null. Never guess from a low rep count alone.
- date: ISO YYYY-MM-DD when determinable, else null.
- intensity: the session's overall effort as EXACTLY one of "easy", "moderate", or
  "hard" when the log annotates it (RPE/"felt easy"/"hard session"). Use null when it
  isn't stated — do NOT invent one.
- start_time / end_time: the session's clock start/end as "HH:MM" (24-hour) or an ISO
  timestamp, when the log records them. Null otherwise.
- duration_min: the session's total duration in whole minutes, when stated. Null
  otherwise.
- notes: capture any per-row or session annotations — a "Notes"/"Comment" column,
  or free text like "felt easy", "PR", "belt", a bodyweight — into the workout's
  notes field. When a note clearly belongs to one exercise, prefix it with that
  exercise (e.g. "Deadlift: 225"); join multiple notes for a day with "; ". Never
  put set weights/reps here, and leave notes null when the day has none.
- Only extract RESISTANCE-TRAINING sets. Skip pure cardio rows (runs, cycling,
  distances/paces) — those aren't supported here — but COUNT every cardio row you
  skip and report the running total in "cardio_rows_skipped" so the skip is visible
  instead of silent.
- Do not invent data. If there are no extractable sets, return an empty array.`;

const TOOL: Anthropic.Tool = {
  name: "save_workouts",
  description: "Save the structured workouts extracted from the log.",
  input_schema: {
    type: "object",
    properties: {
      workouts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            date: { type: ["string", "null"], description: "ISO YYYY-MM-DD" },
            title: { type: ["string", "null"] },
            notes: {
              type: ["string", "null"],
              description:
                "Day/session notes from a notes/comment column or inline annotations; null if none",
            },
            intensity: {
              type: ["string", "null"],
              enum: ["easy", "moderate", "hard", null],
              description:
                "Session effort, exactly one of easy/moderate/hard when annotated; null otherwise",
            },
            start_time: {
              type: ["string", "null"],
              description:
                "Session clock start ('HH:MM' 24h or ISO timestamp), else null",
            },
            end_time: {
              type: ["string", "null"],
              description: "Session clock end, else null",
            },
            duration_min: {
              type: ["number", "null"],
              description: "Session total duration in whole minutes, else null",
            },
            sets: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  exercise: { type: "string" },
                  weight: { type: ["number", "null"] },
                  weight_unit: {
                    type: ["string", "null"],
                    enum: ["kg", "lb", null],
                  },
                  reps: { type: ["number", "null"] },
                  duration_sec: { type: ["number", "null"] },
                  weight_right: {
                    type: ["number", "null"],
                    description:
                      "Right-side load for per-side sets (same unit); null otherwise",
                  },
                  reps_right: {
                    type: ["number", "null"],
                    description:
                      "Right-side reps for per-side sets; null otherwise",
                  },
                  equipment: {
                    type: ["string", "null"],
                    description:
                      "Exact name of a matching user-defined equipment, or null",
                  },
                  target_reps: {
                    type: ["number", "null"],
                    description:
                      "The rep target for the set when stated distinctly from what was performed; null otherwise",
                  },
                  to_failure: {
                    type: ["number", "null"],
                    description:
                      "1 when the set is explicitly to failure (AMRAP/F/failure); else 0/null",
                  },
                },
                required: ["exercise"],
              },
            },
          },
          required: ["sets"],
        },
      },
      cardio_rows_skipped: {
        type: ["number", "null"],
        description:
          "Count of pure-cardio rows (runs/rides/distances/paces) skipped because this path is strength-only. 0 when none.",
      },
    },
    required: ["workouts"],
  },
};

const VOCAB_CAP = 400;

// The valid session-intensity enum, enforced structurally so a stray model value
// (an RPE number, "brutal", …) becomes null rather than reaching the DB. Matches
// lib/activity-form-model's INTENSITIES.
const INTENSITY_VALUES = new Set(["easy", "moderate", "hard"]);

// A non-negative whole number from a number/numeric string, else null (target_reps,
// duration_min). Zero/negative/fractional-only is dropped.
function posIntOrNull(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

// Collapse a to-failure flag (boolean / 0-1 / yes-no) to 1/0/null. Unknown → null.
function toFailureFlag(v: unknown): number | null {
  if (v === true || v === 1) return 1;
  if (v === false || v === 0) return 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["1", "true", "yes", "y", "f", "failure", "amrap"].includes(s))
      return 1;
    if (["0", "false", "no", "n"].includes(s)) return 0;
  }
  return null;
}

// Exported for the pure unit tier: coerces the model's raw tool output into typed
// workouts + the cardio-skipped count, enforcing the intensity enum and the numeric
// guards structurally (not just via the prompt). #420
export function normalizeWorkoutExtraction(raw: any): {
  workouts: ExtractedWorkout[];
  cardioSkipped: number;
} {
  const arr = Array.isArray(raw?.workouts) ? raw.workouts : [];
  const out: ExtractedWorkout[] = [];
  for (const w of arr) {
    const sets: ExtractedSet[] = [];
    for (const s of Array.isArray(w?.sets) ? w.sets : []) {
      const exercise = typeof s?.exercise === "string" ? s.exercise.trim() : "";
      if (!exercise) continue;
      const num = (v: unknown) =>
        typeof v === "number" && Number.isFinite(v) ? v : null;
      const unit =
        s?.weight_unit === "lb" || s?.weight_unit === "kg"
          ? s.weight_unit
          : null;
      sets.push({
        exercise,
        weight: num(s?.weight),
        weight_unit: unit,
        reps: num(s?.reps),
        duration_sec: num(s?.duration_sec),
        weight_right: num(s?.weight_right),
        reps_right: num(s?.reps_right),
        equipment: strOrNull(s?.equipment),
        target_reps: posIntOrNull(s?.target_reps),
        to_failure: toFailureFlag(s?.to_failure),
      });
    }
    if (sets.length === 0) continue;
    const intensityRaw =
      typeof w?.intensity === "string" ? w.intensity.trim().toLowerCase() : "";
    out.push({
      date: strOrNull(w?.date),
      title: strOrNull(w?.title),
      notes: strOrNull(w?.notes),
      intensity: INTENSITY_VALUES.has(intensityRaw) ? intensityRaw : null,
      start_time: strOrNull(w?.start_time),
      end_time: strOrNull(w?.end_time),
      duration_min: posIntOrNull(w?.duration_min),
      sets,
    });
  }
  const cardioSkipped = posIntOrNull(raw?.cardio_rows_skipped) ?? 0;
  return { workouts: out, cardioSkipped };
}

// Split a CSV/text workout log into chunks small enough to extract within the
// output budget, without splitting a single day across chunks. A new day starts
// at a line whose first column is non-empty (has a date); blank-date lines
// belong to the day above. The header line is prepended to every chunk.
const MAX_LINES_PER_CHUNK = 50;

function chunkByDate(text: string, maxLines = MAX_LINES_PER_CHUNK): string[] {
  const lines = text.split(/\r?\n/);
  let h = 0;
  while (h < lines.length && !lines[h].trim()) h++;
  const header = lines[h] ?? "";
  const data = lines.slice(h + 1).filter((l) => l.trim() !== "");
  if (data.length <= maxLines) return [text];

  const chunks: string[] = [];
  let cur: string[] = [];
  const flush = () => {
    if (cur.length) chunks.push([header, ...cur].join("\n"));
    cur = [];
  };
  for (const line of data) {
    const startsDay = !line.startsWith(","); // dated row = new day
    if (startsDay && cur.length >= maxLines) flush();
    cur.push(line);
  }
  flush();
  return chunks;
}

// Public entry: extract a (possibly large) log by splitting it into date-aligned
// chunks, extracting each, and merging — so big histories don't truncate.
export async function extractWorkouts(
  text: string,
  knownLifts: string[] = [],
  knownEquipment: string[] = []
): Promise<WorkoutExtractionResult> {
  if (!text.trim()) {
    return {
      status: "failed",
      error: "Nothing to extract — the input is empty.",
    };
  }
  const chunks = chunkByDate(text);
  if (chunks.length <= 1) return extractChunk(text, knownLifts, knownEquipment);

  // Extract chunks concurrently (much faster than one-at-a-time) but in bounded
  // batches so a very large paste can't fire dozens of simultaneous requests and
  // trip rate limits. Order is preserved; any chunk that skips/fails fails the
  // whole import (and we stop firing further batches).
  log.info("extracting in chunks", { chunks: chunks.length });
  const CONCURRENCY = 4;
  const all: ExtractedWorkout[] = [];
  let cardioSkipped = 0;
  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const batch = chunks.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((c) => extractChunk(c, knownLifts, knownEquipment))
    );
    const bad = results.find((r) => r.status !== "done");
    if (bad) return bad;
    for (const r of results)
      if (r.status === "done") {
        all.push(...r.workouts);
        cardioSkipped += r.cardioSkipped;
      }
  }
  return {
    status: "done",
    workouts: all,
    cardioSkipped,
    model: MODEL,
    raw: `(${chunks.length} chunks)`,
  };
}

async function extractChunk(
  text: string,
  knownLifts: string[] = [],
  knownEquipment: string[] = []
): Promise<WorkoutExtractionResult> {
  if (!aiConfigured()) {
    recordAiEvent({
      feature: "extraction",
      status: "skipped",
      detail: "workouts — AI not configured",
    });
    return {
      status: "skipped",
      message:
        "AI not configured — set ANTHROPIC_API_KEY (or AI_BASE_URL) to extract workouts.",
    };
  }
  if (!text.trim()) {
    return {
      status: "failed",
      error: "Nothing to extract — the input is empty.",
    };
  }

  const vocab = knownLifts.slice(0, VOCAB_CAP);
  const content: Anthropic.ContentBlockParam[] = [
    { type: "text", text: `Workout log to extract:\n\n${text}` },
    {
      type: "text",
      text: "Extract all resistance-training sets using the save_workouts tool.",
    },
  ];
  if (vocab.length) {
    content.push({
      type: "text",
      text: `Catalog exercise names to reuse when one matches (use the exact spelling):\n${vocab.join(
        ", "
      )}`,
    });
  }
  const equipment = knownEquipment.slice(0, VOCAB_CAP);
  if (equipment.length) {
    content.push({
      type: "text",
      text: `User-defined equipment names. When a row's implement/variation matches one of these, set the set's "equipment" field to the exact name (else null):\n${equipment.join(
        ", "
      )}`,
    });
  }

  const startedAt = Date.now();
  log.info("extraction started", { bytes: text.length, model: MODEL });
  try {
    const client = createAiClient();
    const msg = await client.messages
      .stream({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM,
        tools: [TOOL],
        tool_choice: { type: "tool", name: "save_workouts" },
        messages: [{ role: "user", content }],
      })
      .finalMessage();

    const toolUse = msg.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );
    if (!toolUse) {
      recordAiEvent({
        feature: "extraction",
        status: "failed",
        model: MODEL,
        durationMs: Date.now() - startedAt,
        detail: "workouts",
        error: "Model returned no structured data.",
      });
      return { status: "failed", error: "Model returned no structured data." };
    }
    const input = toolUse.input as any;
    const { workouts, cardioSkipped } = normalizeWorkoutExtraction(input);

    if (msg.stop_reason === "max_tokens") {
      // Log the truncation so the "every AI call is logged" invariant holds
      // (mirrors medical-extract's handling).
      log.error("extraction failed: truncated at output limit", {
        parsed: workouts.length,
        max_tokens: MAX_TOKENS,
      });
      const error = `Extraction was truncated at the output limit (${MAX_TOKENS} tokens). Import fewer workouts at a time, or raise HEALTH_AI_MAX_TOKENS.`;
      recordAiEvent({
        feature: "extraction",
        status: "failed",
        model: MODEL,
        durationMs: Date.now() - startedAt,
        detail: `workouts — ${workouts.length} parsed before truncation`,
        error,
      });
      return { status: "failed", error };
    }

    recordAiEvent({
      feature: "extraction",
      status: "ok",
      model: MODEL,
      durationMs: Date.now() - startedAt,
      usage: usageFrom(msg),
      detail: capDetail(
        `workouts — ${workouts.length} workout(s)` +
          (LOG_PROMPTS ? `\nresponse: ${JSON.stringify(input)}` : "")
      ),
    });
    return {
      status: "done",
      workouts,
      cardioSkipped,
      model: MODEL,
      raw: JSON.stringify(input),
    };
  } catch (err) {
    const message = describeError(err);
    log.error("extraction failed", { err });
    recordAiEvent({
      feature: "extraction",
      status: "failed",
      model: MODEL,
      durationMs: Date.now() - startedAt,
      detail: "workouts",
      error: message,
    });
    return { status: "failed", error: message };
  }
}
