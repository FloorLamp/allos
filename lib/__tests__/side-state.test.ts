// The side-state census guard (issue #2087) — the registry of registries' teeth.
//
// Every side-state family (dismissals, send markers, undo captures, tombstones,
// edit locks, stars) already had its own registry and scan; what nothing guarded was
// the CATEGORY. These tests close the two halves the census declares:
//
//   1. REFLECTION — a census row cannot point at a registry that moved, a symbol
//      that was renamed, or a guard test that stopped mentioning what it guards.
//   2. THE CATEGORY SCAN — a quoted key literal shaped like side-state must belong
//      to a registered family or be argued out in NON_SIDE_STATE_KEYS.
//
// Same idiom as page-width-scan.test.ts and send-markers.test.ts: the app's own
// source read as TEXT, no DB, no network.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  NON_SIDE_STATE_KEYS,
  SIDE_STATE_FAMILIES,
  SIDE_STATE_KEY_SHAPES,
} from "@/lib/side-state";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DECLARATION = "lib/side-state.ts";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // The three test tiers guard; they do not mint keys. Shipped migrations are
      // frozen history (the hash manifest), not live key-minting.
      if (entry.name.startsWith("__")) continue;
      if (entry.name === "node_modules" || entry.name === "migrations")
        continue;
      out.push(...walk(full));
    } else if (
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

function rel(full: string): string {
  return path.relative(REPO, full).split(path.sep).join("/");
}

function sourceFiles(): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = [];
  for (const d of ["lib", "scripts"]) {
    for (const full of walk(path.join(REPO, d))) {
      const r = rel(full);
      if (r === DECLARATION) continue; // the census may spell its own shapes
      out.push({ rel: r, text: fs.readFileSync(full, "utf8") });
    }
  }
  return out;
}

/**
 * Comments MENTION retired key names constantly (`starred_biomarkers` alone
 * appears in three doc comments), so the scan reads CODE only — the same reason
 * the send-marker scan strips comments. Minimal quote-aware stripper: tracks the
 * three string forms so a `//` inside a string never starts a comment, and
 * blanks comment bodies (preserving newlines for line numbers).
 */
export function stripComments(text: string): string {
  let out = "";
  let i = 0;
  let mode: "code" | "line" | "block" | '"' | "'" | "`" = "code";
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (mode === "code") {
      if (c === "/" && next === "/") mode = "line";
      else if (c === "/" && next === "*") mode = "block";
      else if (c === '"' || c === "'" || c === "`") mode = c;
      out += mode === "line" || mode === "block" ? " " : c;
    } else if (mode === "line") {
      if (c === "\n") mode = "code";
      out += c === "\n" ? c : " ";
    } else if (mode === "block") {
      if (c === "*" && next === "/") {
        mode = "code";
        out += "  ";
        i += 2;
        continue;
      }
      out += c === "\n" ? c : " ";
    } else {
      // Inside a string: emit verbatim, honor escapes, close on the open quote.
      if (c === "\\") {
        out += c + (next ?? "");
        i += 2;
        continue;
      }
      if (c === mode) mode = "code";
      out += c;
    }
    i++;
  }
  return out;
}

/** Quoted literals starting with a side-state shape, as `{ literal, line }`. */
export function sideStateLiterals(
  raw: string
): { literal: string; line: number }[] {
  const text = stripComments(raw);
  const out: { literal: string; line: number }[] = [];
  const shapes = SIDE_STATE_KEY_SHAPES.map((s) =>
    s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  ).join("|");
  // The closing delimiter is a LOOKAHEAD for a quote or a `${` interpolation, so a
  // template key with a variable tail (`` `pinned_${id}` ``) is still caught by its
  // prefix — the "unresolvable by construction" shape send-markers routes through
  // builders.
  const re = new RegExp(
    `["'\`]((?:${shapes})[a-z0-9_]*)(?=["'\`]|\\$\\{)`,
    "g"
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({
      literal: m[1],
      line: text.slice(0, m.index).split("\n").length,
    });
  }
  return out;
}

describe("the side-state census (issue #2087)", () => {
  it("declares every family completely, with no duplicates", () => {
    expect(SIDE_STATE_FAMILIES.length).toBeGreaterThanOrEqual(6);
    const names = SIDE_STATE_FAMILIES.map((f) => f.family);
    expect(new Set(names).size).toBe(names.length);
    for (const f of SIDE_STATE_FAMILIES) {
      for (const field of [
        f.concept,
        f.store,
        f.registryModule,
        f.registrySymbol,
        f.keyGrammar,
        f.sweep,
        f.guard,
      ]) {
        expect(field, `${f.family} has an empty field`).toBeTruthy();
      }
    }
  });

  it("every registry module exists and exports its named symbol", () => {
    for (const f of SIDE_STATE_FAMILIES) {
      const full = path.join(REPO, f.registryModule);
      expect(
        fs.existsSync(full),
        `${f.family}: ${f.registryModule} is gone`
      ).toBe(true);
      const text = fs.readFileSync(full, "utf8");
      const exported = new RegExp(
        `export (?:const|function|type) ${f.registrySymbol}\\b`
      ).test(text);
      expect(
        exported,
        `${f.family}: ${f.registryModule} no longer exports ${f.registrySymbol} — ` +
          "update the census row to the registry's new home"
      ).toBe(true);
    }
  });

  it("every guard test exists and references the symbol it guards", () => {
    for (const f of SIDE_STATE_FAMILIES) {
      const full = path.join(REPO, f.guard);
      expect(fs.existsSync(full), `${f.family}: guard ${f.guard} is gone`).toBe(
        true
      );
      const text = fs.readFileSync(full, "utf8");
      expect(
        text.includes(f.registrySymbol),
        `${f.family}: ${f.guard} never mentions ${f.registrySymbol} — it has ` +
          "stopped guarding this family's registry"
      ).toBe(true);
    }
  });

  it("no side-state-shaped key literal lives outside the census", () => {
    const known = new Set(NON_SIDE_STATE_KEYS.map((k) => k.literal));
    const offenders: string[] = [];
    for (const { rel: r, text } of sourceFiles()) {
      for (const { literal, line } of sideStateLiterals(text)) {
        if (!known.has(literal)) offenders.push(`${r}:${line} — "${literal}"`);
      }
    }
    expect(
      offenders,
      "These quoted keys read as side-state but belong to no registered family. " +
        "Either register the state with the family whose grammar it follows " +
        "(SIDE_STATE_FAMILIES in lib/side-state.ts) or argue it out in " +
        "NON_SIDE_STATE_KEYS with what it actually is:\n" +
        offenders.join("\n")
    ).toEqual([]);
  });

  it("every argued-out literal still exists somewhere — no stale allowlist", () => {
    const files = sourceFiles();
    const stale: string[] = [];
    for (const { literal } of NON_SIDE_STATE_KEYS) {
      const held = files.some(({ text }) =>
        sideStateLiterals(text).some((l) => l.literal === literal)
      );
      if (!held) stale.push(literal);
    }
    expect(
      stale,
      `NON_SIDE_STATE_KEYS entries with nothing left to excuse — delete them so ` +
        `the allowlist keeps meaning what it says:\n${stale.join("\n")}`
    ).toEqual([]);
  });

  it("the literal extractor reads every quote form and only the declared shapes", () => {
    expect(
      sideStateLiterals('const k = "seen_report";').map((l) => l.literal)
    ).toEqual(["seen_report"]);
    expect(
      sideStateLiterals("mark(`pinned_${'x'}`)").map((l) => l.literal)
    ).toEqual(["pinned_"]);
    expect(sideStateLiterals('const notKey = "unseen_thing";')).toEqual([]);
    expect(sideStateLiterals('const col = "last_used";')).toEqual([]);
  });
});
