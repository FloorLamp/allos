import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static guard for arbitrary micro text sizes (issue #794 cluster 5). The app had
// ~23 `text-[10px]` / `text-[11px]` / `text-[0.65rem]` / `text-[0.7rem]` one-offs
// where the `text-xs` utility (or the `.section-label` primitive, which is itself
// text-xs) should serve. They were swept to text-xs / section-label. This test
// reads the repo's own TSX as TEXT (no DB, no network, so it stays "pure" in the
// vitest sense) and fails the build if a new arbitrary micro `text-[…px|rem]`
// appears — the exact drift #794 removed.
//
// A handful of genuinely intentional survivors are ALLOWLISTED by file: places
// where 10px is a deliberate density decision (chart/heatmap tick labels, a
// gauge-scale axis) or a proportional-to-container size (avatar initials). Each
// carries its justification, plus a staleness check so a stale entry fails.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCAN_DIRS = ["app", "components"];

// Deliberate survivors — arbitrary micro sizes kept on purpose.
const ALLOWLIST = new Map<string, string>([
  [
    "components/WorkoutHeatmap.tsx",
    "heatmap month/weekday/legend tick labels — deliberate 10px density aligned to the 3px-gap cell grid",
  ],
  [
    "components/BiomarkerScale.tsx",
    "gauge-scale numeric axis labels (low/high/band) — chart tick density",
  ],
  [
    "components/Avatar.tsx",
    "avatar initials sized proportionally to the avatar diameter (0.65rem in the 28px sm circle)",
  ],
]);

// text-[<number>px] or text-[<number>rem] — an arbitrary font SIZE (not a color,
// which would be text-[#…]/text-[rgb…]). Word-boundaried so it's a real utility.
const MICRO = /(?<![\w-])text-\[[0-9.]+(?:px|rem)\]/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      out.push(...walk(full));
    } else if (entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

function sourceFiles(): { rel: string; text: string }[] {
  const files: { rel: string; text: string }[] = [];
  for (const d of SCAN_DIRS) {
    const abs = path.join(REPO, d);
    if (!fs.existsSync(abs)) continue;
    for (const full of walk(abs)) {
      files.push({
        rel: path.relative(REPO, full).split(path.sep).join("/"),
        text: fs.readFileSync(full, "utf8"),
      });
    }
  }
  return files;
}

describe("micro text-size guard (issue #794 cluster 5)", () => {
  it("no component hand-rolls an arbitrary micro text-[…px|rem] size", () => {
    const offenders: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      if (ALLOWLIST.has(rel)) continue;
      text.split("\n").forEach((line, i) => {
        if (MICRO.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(
      offenders,
      `Use text-xs (or the .section-label primitive) instead of an arbitrary ` +
        `micro text-[…px|rem]. A genuinely intentional survivor (chart/heatmap ` +
        `tick, proportional sizing) gets an ALLOWLIST entry with justification:\n` +
        offenders.join("\n")
    ).toEqual([]);
  });

  it("every allowlisted file still exists and still carries a micro size (no stale entries)", () => {
    const stale: string[] = [];
    for (const rel of ALLOWLIST.keys()) {
      const abs = path.join(REPO, rel);
      if (!fs.existsSync(abs)) {
        stale.push(rel);
        continue;
      }
      const text = fs.readFileSync(abs, "utf8");
      if (!text.split("\n").some((line) => MICRO.test(line))) stale.push(rel);
    }
    expect(
      stale,
      `These ALLOWLIST entries no longer carry a micro text size and should be ` +
        `removed from the allowlist:\n${stale.join("\n")}`
    ).toEqual([]);
  });
});
