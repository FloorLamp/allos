import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MEDICAL_DISCLAIMER,
  NOT_A_DIAGNOSIS,
  NEVER_PRESCRIPTIVE,
  DATASET_DISCLAIMER,
  DISCLAIMER_FULL,
  DISCLAIMER_SECTIONS,
} from "@/lib/disclaimers";

// Source-scan guard for the disclaimer-consolidation invariant (issue #1049), in the
// profile-scoping / telegram-chokepoint / immediate-tx / notes-text tradition. Disclaimer
// copy used to live as ~40 inline literals that drifted into ~15 near-variants of one
// sentence. Per the owner's ratified call, all of that boilerplate is now DELETED from the
// surfaces: the disclaimer lives on ONE page (/disclaimer, footer-linked), and the domain
// pages carry no disclaimer prose at all. This test reads the repo's own source as TEXT
// (no DB, no network — it stays "pure") and fails the build if a disclaimer literal
// reappears under app/ or components/, so the consolidation can't silently regrow.
//
// STRICT: because no legitimate inline disclaimer remains, there are ZERO `disclaimer-ok:`
// escapes in the tree, and the second test below pins that count at 0. The escape hatch
// stays wired only for a future, reviewed carve-out; the PHQ-9 crisis contract (#716) is
// NOT one — it renders crisis RESOURCES (a safety surface) sourced from
// lib/crisis-resources.ts constants, which are not disclaimer phrasings and never trip
// this scan. lib/disclaimers.ts itself is out of scan scope (it lives under lib/, and the
// only remaining consumer is the /disclaimer page + tests).

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCAN_DIRS = ["app", "components"];

// The banned disclaimer phrasings, as they'd appear inside a string literal. High-signal
// (they don't occur in ordinary UI copy) so a synthetic fixture / a constant reference
// never trips them, but every hand-written variant of the disclaimer sentence does.
const BANNED: RegExp[] = [
  /not medical advice/i,
  /informational[^.\n]*\badvice\b/i,
  /not a diagnosis/i,
  /never prescriptive/i,
];

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      out.push(...walk(full, exts));
    } else if (exts.some((e) => entry.name.endsWith(e))) {
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
    for (const full of walk(abs, [".ts", ".tsx"])) {
      const rel = path.relative(REPO, full).split(path.sep).join("/");
      if (rel.includes("__tests__") || rel.endsWith(".test.tsx")) continue;
      files.push({ rel, text: fs.readFileSync(full, "utf8") });
    }
  }
  return files;
}

// Strip line/block comments so prose mentioning a disclaimer phrase (a doc comment
// explaining the framing) can't trip the scanner — only real code counts.
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("disclaimer consolidation guard (issue #1049)", () => {
  it("no surface under app/ or components/ hand-writes a disclaimer literal", () => {
    const offenders: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      const code = stripComments(text);
      const lines = code.split("\n");
      lines.forEach((line, i) => {
        if (line.includes("disclaimer-ok")) return; // marker escape
        if (BANNED.some((re) => re.test(line)))
          offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(
      offenders,
      `These hand-write a disclaimer phrase. Render a reference to a constant from ` +
        `lib/disclaimers.ts (MEDICAL_DISCLAIMER / NOT_A_DIAGNOSIS / NEVER_PRESCRIPTIVE / ` +
        `DATASET_DISCLAIMER) instead of a literal:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("carries ZERO disclaimer-ok escapes — the surfaces hold no inline disclaimers", () => {
    const escapes: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      text.split("\n").forEach((line, i) => {
        if (line.includes("disclaimer-ok")) escapes.push(`${rel}:${i + 1}`);
      });
    }
    expect(
      escapes,
      `The disclaimer boilerplate was fully deleted from the surfaces, so no ` +
        `disclaimer-ok escape should exist. If a NEW reviewed carve-out genuinely ` +
        `needs one, update this test with the justification:\n${escapes.join("\n")}`
    ).toEqual([]);
  });

  it("no surface under app/ or components/ imports a disclaimer constant except the /disclaimer page", () => {
    const importers: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      if (rel === "app/(app)/disclaimer/page.tsx") continue;
      if (/from\s*["']@\/lib\/disclaimers["']/.test(text)) importers.push(rel);
    }
    expect(
      importers,
      `The disclaimer copy is consolidated onto /disclaimer; a domain surface should ` +
        `not import from @/lib/disclaimers (delete the inline disclaimer instead):\n` +
        importers.join("\n")
    ).toEqual([]);
  });

  it("the canonical constants carry the expected posture", () => {
    expect(MEDICAL_DISCLAIMER).toBe("Informational, not medical advice.");
    expect(NOT_A_DIAGNOSIS).toMatch(/not a diagnosis/i);
    expect(NEVER_PRESCRIPTIVE).toMatch(/never prescriptive/i);
    expect(DATASET_DISCLAIMER).toMatch(/curated subset/i);
  });

  it("DISCLAIMER_FULL covers every required framing (the single surface's content)", () => {
    expect(DISCLAIMER_SECTIONS.length).toBeGreaterThanOrEqual(5);
    expect(DISCLAIMER_FULL).toMatch(/not medical advice/i);
    expect(DISCLAIMER_FULL).toMatch(/not.*diagnos/i);
    expect(DISCLAIMER_FULL).toMatch(/curated/i);
    expect(DISCLAIMER_FULL).toMatch(/extract/i);
    expect(DISCLAIMER_FULL).toMatch(/emergency/i);
    expect(DISCLAIMER_FULL).toMatch(/self-hosted|your data/i);
  });

  it("the guard actually fires on a planted literal and passes a constant reference", () => {
    const planted = `<p>Informational, not medical advice.</p>`;
    const reference = `<p>{MEDICAL_DISCLAIMER}</p>`;
    expect(BANNED.some((re) => re.test(planted))).toBe(true);
    expect(BANNED.some((re) => re.test(reference))).toBe(false);
  });
});
