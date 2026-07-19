import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MOOD_OBS_PREFIX,
  SLEEP_MOOD_PREFIX,
  lowMoodSignalKey,
  sleepMoodSignalKey,
} from "@/lib/mood-observation";
import { tierForDedupeKey } from "@/lib/rule-finding-prefixes";
import canonical from "@/lib/canonical-biomarkers.json";

// The #992 sensitivity guardrails, pinned STRUCTURALLY (the source-scan pattern of
// profile-scoping / telegram-chokepoint / e2e-hygiene):
//
//   1. NEVER FLAGGED / NEVER RETESTED — a mood value is a subjective self-rating,
//      not a lab. mood_logs must stay outside the reference-range/flag engine and
//      every retest clock: the only lib modules allowed to name the table are its
//      own store/read/write/migration files, and the canonical-biomarker catalog
//      (whose ranges DRIVE flags + retest cadence) must carry no mood-scale entry.
//   2. NO GAMIFICATION, EVER — no mood streaks, no milestones, no score to beat:
//      the streak/milestone engines must never reference mood, and the mood
//      modules must never import them.
//   3. COACHING TIER ONLY — both mood dedupeKey namespaces resolve to the calm
//      tier (#449), so they can never ride a push or the Needs-attention hero.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// Strip comments so a module's own prose ("never import the reference-range
// engine", this guard's raison d'être) can't trip the code-level scan — the same
// comment-stripping discipline the copy-lint scanner uses.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function read(rel: string): string {
  return stripComments(fs.readFileSync(path.join(REPO, rel), "utf8"));
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      out.push(...walk(full));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

// The ONLY lib modules allowed to reference the mood_logs table: its migration,
// the owned-tables registry, the read layer, and the one write core. Anything
// else naming the table — a flag reconciler, a retest clock, a streak engine, an
// importer — is exactly the drift this guard exists to fail.
const MOOD_TABLE_ALLOWLIST = new Set([
  "lib/migrations/versions/073-mood-logs.ts",
  "lib/owned-tables.ts",
  "lib/queries/mood.ts",
  "lib/offline/writes.ts",
  // The Data → Export dataset registry (#465 export-completeness): every owned
  // table must round-trip through the full export, so lib/export.ts names the
  // table for its verbatim SELECT/COUNT/delete-policy — a data-portability
  // surface, not a flag/retest/streak engine.
  "lib/export.ts",
]);

describe("mood guardrails (#992) — never flagged, never retested", () => {
  it("mood_logs is referenced ONLY by its own store/read/write/migration modules", () => {
    for (const full of walk(path.join(REPO, "lib"))) {
      const rel = path.relative(REPO, full).split(path.sep).join("/");
      if (rel.includes("__db_tests__") || rel.includes("__action_tests__"))
        continue;
      const text = fs.readFileSync(full, "utf8");
      if (text.includes("mood_logs")) {
        expect(
          MOOD_TABLE_ALLOWLIST.has(rel),
          `${rel} references mood_logs — mood is store-private: no flag/retest/` +
            `streak/import engine may touch the table (issue #992 contract)`
        ).toBe(true);
      }
    }
  });

  it("the read layer and pure mood modules never import the flag/retest engines", () => {
    for (const rel of [
      "lib/queries/mood.ts",
      "lib/mood.ts",
      "lib/mood-observation.ts",
    ]) {
      const text = read(rel);
      expect(text, `${rel} must not touch reference-range flags`).not.toMatch(
        /reference-range|reconcileFlag|reconciledFlag/
      );
      expect(text, `${rel} must not touch a retest clock`).not.toMatch(
        /biomarker-retest|retest-worthiness|fitness-retest/
      );
    }
  });

  it("the canonical biomarker catalog carries no mood-scale entry (no ranges → no flags, no retest)", () => {
    const names = (
      canonical as { biomarkers: { name: string }[] }
    ).biomarkers.map((c) => c.name.toLowerCase());
    for (const banned of ["mood", "valence", "wellbeing"]) {
      expect(
        names.filter((n) => n.includes(banned)),
        `a canonical biomarker matching "${banned}" would give mood a reference range`
      ).toEqual([]);
    }
  });
});

describe("mood guardrails (#992) — no gamification, ever", () => {
  it("the streak/milestone engines never reference mood", () => {
    for (const rel of [
      "lib/streak.ts",
      "lib/milestones.ts",
      "lib/milestones-db.ts",
    ]) {
      expect(read(rel), `${rel} must stay mood-blind`).not.toMatch(/\bmood/i);
    }
  });

  it("the mood modules never import the streak/milestone machinery", () => {
    for (const rel of [
      "lib/mood.ts",
      "lib/mood-observation.ts",
      "lib/queries/mood.ts",
      "lib/notifications/mood.ts",
    ]) {
      expect(
        read(rel),
        `${rel} must not reach for streaks/milestones`
      ).not.toMatch(/streak|milestone/i);
    }
  });
});

describe("mood guardrails (#992) — coaching tier only", () => {
  it("both mood namespaces resolve to the coaching tier (never push, never hero)", () => {
    expect(tierForDedupeKey(lowMoodSignalKey("2026-07"))).toBe("coaching");
    expect(tierForDedupeKey(sleepMoodSignalKey("2026-07"))).toBe("coaching");
    expect(tierForDedupeKey(`${MOOD_OBS_PREFIX}low:x`)).toBe("coaching");
    expect(tierForDedupeKey(`${SLEEP_MOOD_PREFIX}co:x`)).toBe("coaching");
  });
});
