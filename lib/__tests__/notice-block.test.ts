import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static guard for the tinted notice/alert-block primitive (issue #794 cluster 4 +
// 8b). The warning/notice block — a bordered, tinted `bg-{amber,rose,emerald}-50`
// message container — used to be hand-rolled ~15 times with drifting borders
// (-200 vs -300), radii (rounded-lg vs -xl vs -2xl), and three dark-mode bg
// treatments (dark:bg-amber-950 vs /40 vs /50), plus low-contrast -600 text on the
// -50 tint (amber-600 = 3.07:1, fails WCAG AA). It now lives in ONE tone map,
// `NOTICE_TONE` in components/Notice.tsx, consumed by the `<Notice>` primitive and
// by FindingCard (#747). This test reads the repo's own TSX as TEXT (no DB, no
// network, so it stays "pure" in the vitest sense) and fails the build if a
// component re-hand-rolls the bordered tinted alert-block signature instead of
// reaching for NOTICE_TONE / `<Notice>` / FindingCard.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCAN_DIRS = ["app", "components"];

// Files permitted to carry the literal signature because they are NOT a hand-rolled
// notice block, with the justification for each.
const ALLOWLIST = new Map<string, string>([
  // The primitive itself — NOTICE_TONE is the ONE place the tone strings live.
  ["components/Notice.tsx", "the NOTICE_TONE tone map (the primitive)"],
  // A tone map applied to a `rounded-full` trend CHIP, not a message container —
  // the string is returned and used elsewhere, so it can't be excluded by line.
  [
    "app/(app)/trends/TrendingDigest.tsx",
    "trend chip tone map (applied to a rounded-full pill, not a notice block)",
  ],
]);

// The hand-rolled alert-block signature: a bordered tint — a `border-{tone}-{200,300}`
// AND a SOLID `bg-{tone}-50` (word-boundaried so `bg-amber-500` and the softer
// `bg-amber-50/60` finding-list tints don't count, and `:`/`-` prefixes exclude
// `hover:bg-`/`dark:bg-`) — for tones amber|rose|emerald, in either order within one
// className string.
const TONE = "(?:amber|rose|emerald)";
const BORDER = new RegExp(`border-${TONE}-(?:200|300)\\b`);
const SOLID_BG = new RegExp(`(?<![:\\w-])bg-${TONE}-50(?![/\\w])`);

// Interactive/floating/chip lines that share the tint but are not message blocks:
// a toggle/button state (`hover:bg-`), a floating toast (`fixed`), or a pill
// (`rounded-full`). These are a different token set, excluded by construction so the
// allowlist stays tiny.
const NOT_A_NOTICE = /hover:bg-|(?<![\w-])fixed(?![\w-])|rounded-full/;

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
      const rel = path.relative(REPO, full).split(path.sep).join("/");
      files.push({ rel, text: fs.readFileSync(full, "utf8") });
    }
  }
  return files;
}

function offenderLines(text: string): number[] {
  const hits: number[] = [];
  text.split("\n").forEach((line, i) => {
    if (NOT_A_NOTICE.test(line)) return;
    if (BORDER.test(line) && SOLID_BG.test(line)) hits.push(i + 1);
  });
  return hits;
}

describe("notice-block primitive guard (issue #794 cluster 4)", () => {
  it("no component hand-rolls the bordered tinted alert-block signature", () => {
    const offenders: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      if (ALLOWLIST.has(rel)) continue;
      for (const n of offenderLines(text)) offenders.push(`${rel}:${n}`);
    }
    expect(
      offenders,
      `Use the <Notice> primitive (or NOTICE_TONE / FindingCard) instead of ` +
        `hand-rolling "border-{amber,rose,emerald}-{200,300} bg-{tone}-50 …". A ` +
        `genuinely non-notice one-off (toggle/chip/toast) gets an ALLOWLIST entry ` +
        `with justification:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("every allowlisted file still exists and still carries the signature (no stale entries)", () => {
    const stale: string[] = [];
    for (const rel of ALLOWLIST.keys()) {
      const abs = path.join(REPO, rel);
      if (!fs.existsSync(abs)) {
        stale.push(rel);
        continue;
      }
      const text = fs.readFileSync(abs, "utf8");
      const hasLiteral = text
        .split("\n")
        .some((line) => BORDER.test(line) && SOLID_BG.test(line));
      if (!hasLiteral) stale.push(rel);
    }
    expect(
      stale,
      `These ALLOWLIST entries no longer carry the signature (or were removed) ` +
        `and should be deleted from the allowlist:\n${stale.join("\n")}`
    ).toEqual([]);
  });

  it("NOTICE_TONE and Notice are exported from the primitive module", () => {
    const src = fs.readFileSync(
      path.join(REPO, "components/Notice.tsx"),
      "utf8"
    );
    expect(/export const NOTICE_TONE\b/.test(src)).toBe(true);
    expect(/export function Notice\b/.test(src)).toBe(true);
  });
});
