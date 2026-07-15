// Pre-generate the exercise how-to guide dataset (lib/exercise-guides.json).
//
// One guide per distinct `exerciseHistoryKey` over the catalog (ALL_LIFT_NAMES),
// so equipment variants ("Barbell Curl"/"Dumbbell Curl"/"Curl") share ONE guide
// keyed by their base lift (#221/#482 — identity through exerciseHistoryKey). The
// file is COMMITTED and meant to be HUMAN-REVIEWED before it is trusted; guides
// are INFORMATIONAL FORM REFERENCE, NOT MEDICAL ADVICE.
//
//   npm run gen:exercise-guides
//
// Content SOURCE. The setup/execution/mistakes/etc. text is authored, not
// re-derived at runtime — it comes from the committed curated content module
// `scripts/exercise-guide-content.ts` (GUIDE_CONTENT), exactly the way the
// biomarker generator seeds from lib/curated-biomarkers.ts's CURATED_LABS. When a
// catalog key is MISSING from GUIDE_CONTENT and an ANTHROPIC_API_KEY is present,
// the model drafts a first pass for that key (AI is a build-time convenience, NEVER
// a runtime dependency — the committed JSON works fully offline). With every key
// authored, this whole script runs API-free.
//
// Muscle SOURCE. `primaryMuscles`/`secondaryMuscles` are NOT authored in the
// content module — they are folded in deterministically from the catalog lift's
// tags (#735) via `liftInfo(baseLiftName(...))`, so the guide and the coverage/
// anatomy layers key on the SAME MuscleIds by construction (one computation, one
// identity — #482). `--muscles-only` re-syncs just those arrays over the existing
// committed JSON, API-free, after a catalog tag edit:
//
//   npx tsx scripts/gen-exercise-guides.ts --muscles-only

import "./load-env";

import fs from "node:fs";
import path from "node:path";
import {
  type MuscleId,
  ALL_LIFT_NAMES,
  LIFT_OPTIONS,
  baseLiftName,
  exerciseHistoryKey,
  liftInfo,
} from "@/lib/lifts";
import { type ExerciseGuide } from "@/lib/exercise-guides";
import { GUIDE_CONTENT, type GuideContent } from "./exercise-guide-content";

const MODEL = process.env.HEALTH_AI_MODEL || "claude-sonnet-5";
const OUT = path.join(process.cwd(), "lib", "exercise-guides.json");
const OVERWRITE = process.argv.includes("--overwrite");
// API-free re-sync of just the muscle arrays from the catalog over the existing
// committed JSON (after a catalog tag edit). No content changes, no API needed.
const MUSCLES_ONLY = process.argv.includes("--muscles-only");

// The distinct exerciseHistoryKeys across the whole catalog, each with the base
// lift name and the catalog muscle tags to fold in. This is the completeness set
// the CI invariant also derives — a new catalog lift shows up here automatically.
interface KeyRow {
  key: string;
  base: string;
  primaryMuscles: MuscleId[];
  secondaryMuscles: MuscleId[];
}

function catalogKeyRows(): KeyRow[] {
  const rows = new Map<string, KeyRow>();
  for (const name of [...ALL_LIFT_NAMES, ...LIFT_OPTIONS]) {
    const key = exerciseHistoryKey(name);
    if (rows.has(key)) continue;
    const base = baseLiftName(name);
    const info = liftInfo(base) ?? liftInfo(name);
    rows.set(key, {
      key,
      base,
      primaryMuscles: info?.primaryMuscles ?? [],
      secondaryMuscles: info?.secondaryMuscles ?? [],
    });
  }
  return [...rows.values()].sort((a, b) => a.key.localeCompare(b.key));
}

// Load the committed dataset into a key-indexed map (empty when missing/malformed).
function loadExisting(): Map<string, ExerciseGuide> {
  const map = new Map<string, ExerciseGuide>();
  if (fs.existsSync(OUT)) {
    try {
      const cur = JSON.parse(fs.readFileSync(OUT, "utf8"));
      for (const g of cur.guides ?? []) map.set(g.key, g);
    } catch {
      // ignore a malformed existing file
    }
  }
  return map;
}

// Assemble a guide from its content + the catalog-sourced muscles.
function buildGuide(row: KeyRow, content: GuideContent): ExerciseGuide {
  return {
    key: row.key,
    setup: content.setup,
    execution: content.execution,
    ...(content.breathing ? { breathing: content.breathing } : {}),
    commonMistakes: content.commonMistakes,
    ...(content.safetyNotes ? { safetyNotes: content.safetyNotes } : {}),
    ...(content.equipmentNotes
      ? { equipmentNotes: content.equipmentNotes }
      : {}),
    primaryMuscles: row.primaryMuscles,
    secondaryMuscles: row.secondaryMuscles,
  };
}

// Sort by key and write the committed JSON.
function writeDataset(guides: ExerciseGuide[]): void {
  const sorted = [...guides].sort((a, b) => a.key.localeCompare(b.key));
  const out = {
    $comment:
      "Exercise how-to guides, keyed by exerciseHistoryKey. Committed and HUMAN-REVIEWABLE. Regenerate with `npm run gen:exercise-guides`. INFORMATIONAL FORM REFERENCE, NOT MEDICAL ADVICE.",
    guides: sorted,
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(`\nWrote ${sorted.length} guides to ${OUT}`);
  console.log("Review the content for accuracy before committing.");
}

// Re-sync ONLY the muscle arrays from the catalog into the existing committed
// JSON, preserving all content and order. API-free — this is --muscles-only.
function applyMusclesInPlace(): void {
  const cur = JSON.parse(fs.readFileSync(OUT, "utf8")) as {
    guides?: ExerciseGuide[];
    [k: string]: unknown;
  };
  const rowsByKey = new Map(catalogKeyRows().map((r) => [r.key, r]));
  let applied = 0;
  for (const g of cur.guides ?? []) {
    const row = rowsByKey.get(g.key);
    if (!row) {
      console.warn(`  muscles: no catalog key "${g.key}" — skipped`);
      continue;
    }
    g.primaryMuscles = row.primaryMuscles;
    g.secondaryMuscles = row.secondaryMuscles;
    applied++;
  }
  fs.writeFileSync(OUT, JSON.stringify(cur, null, 2) + "\n");
  console.log(`Re-synced muscles for ${applied} guide(s) in ${OUT}`);
}

// The AI tool schema for drafting content for a key with no curated entry. Only
// reached when GUIDE_CONTENT is missing a key AND an API key is set.
async function draftContent(
  key: string,
  base: string
): Promise<GuideContent | null> {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const client = new Anthropic({ apiKey });
  const TOOL = {
    name: "save_guide",
    description: "Save the how-to guide content for one exercise.",
    input_schema: {
      type: "object" as const,
      properties: {
        setup: { type: "array", items: { type: "string" } },
        execution: { type: "array", items: { type: "string" } },
        breathing: { type: ["string", "null"] },
        commonMistakes: { type: "array", items: { type: "string" } },
        safetyNotes: { type: ["array", "null"], items: { type: "string" } },
      },
      required: ["setup", "execution", "commonMistakes"],
    },
  };
  const SYSTEM = `You write concise, correct strength-training FORM REFERENCE for one exercise.
Emit ordered setup steps, ordered execution cues, common mistakes, and (only when
useful) a one-line breathing cue and informational safety notes. Keep it generic
and instructional — INFORMATIONAL, NEVER MEDICAL ADVICE, never diagnostic. Call
save_guide exactly once.`;
  const msg = await client.messages
    .stream({
      model: MODEL,
      max_tokens: 1500,
      system: SYSTEM,
      tools: [TOOL as never],
      tool_choice: { type: "tool", name: "save_guide" },
      messages: [
        {
          role: "user",
          content: `Write the how-to guide content for the exercise "${base}" (key "${key}").`,
        },
      ],
    })
    .finalMessage();
  const toolUse = msg.content.find((b) => b.type === "tool_use");
  const input = (toolUse as { input?: Record<string, unknown> })?.input;
  if (!input) return null;
  return {
    setup: (input.setup as string[]) ?? [],
    execution: (input.execution as string[]) ?? [],
    breathing: (input.breathing as string) || undefined,
    commonMistakes: (input.commonMistakes as string[]) ?? [],
    safetyNotes: (input.safetyNotes as string[]) || undefined,
  };
}

async function main() {
  // API-free re-sync of the catalog muscle arrays over the existing JSON.
  if (MUSCLES_ONLY) {
    console.log("Re-syncing muscle arrays from the catalog…");
    applyMusclesInPlace();
    return;
  }

  const existing = OVERWRITE
    ? new Map<string, ExerciseGuide>()
    : loadExisting();
  const rows = catalogKeyRows();
  const out: ExerciseGuide[] = [];
  let authored = 0;
  let drafted = 0;
  let preserved = 0;
  const missing: string[] = [];

  for (const row of rows) {
    // 1) curated content wins (always fully offline).
    const curated = GUIDE_CONTENT[row.key];
    if (curated) {
      out.push(buildGuide(row, curated));
      authored++;
      continue;
    }
    // 2) preserve an existing committed guide's content (re-fold fresh muscles).
    const prior = existing.get(row.key);
    if (prior && !OVERWRITE) {
      out.push({
        ...prior,
        primaryMuscles: row.primaryMuscles,
        secondaryMuscles: row.secondaryMuscles,
      });
      preserved++;
      continue;
    }
    // 3) draft a first pass via the model, if an API key is available.
    process.stdout.write(`Drafting ${row.key}… `);
    try {
      const content = await draftContent(row.key, row.base);
      if (content) {
        out.push(buildGuide(row, content));
        drafted++;
        console.log("ok");
      } else {
        missing.push(row.key);
        console.log("no API key — skipped");
      }
    } catch (err) {
      missing.push(row.key);
      console.log(
        `failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  writeDataset(out);
  console.log(
    `Curated: ${authored}, drafted: ${drafted}, preserved: ${preserved}` +
      (missing.length
        ? `, MISSING (add to GUIDE_CONTENT): ${missing.join(", ")}`
        : "")
  );
  if (missing.length) {
    console.error(
      `\n${missing.length} catalog key(s) have no guide — the completeness test will fail. ` +
        `Author them in scripts/exercise-guide-content.ts (or set ANTHROPIC_API_KEY to draft).`
    );
    process.exitCode = 1;
  }
}

// Run only when invoked as the CLI entry point — NOT when imported.
if (process.argv[1]?.includes("gen-exercise-guides")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

// Exported for the drift/coverage tests (pure, no API).
export { catalogKeyRows };
export type { KeyRow };
