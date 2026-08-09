import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  GLYPH,
  GLYPH_MODULES,
  GLYPH_VOCABULARY,
  RETIRED_GLYPHS,
  type GlyphName,
} from "@/lib/notifications/glyphs";
import { REPO } from "./sql-scan";
import { stringLiterals } from "./source-literals";

const NAMES = Object.keys(GLYPH_VOCABULARY) as GlyphName[];

// ---------------------------------------------------------------------------
// THE VOCABULARY (#2392)
// ---------------------------------------------------------------------------

describe("the glyph vocabulary declares a meaning and a role for every entry", () => {
  it("carries a written meaning and a declared role on every entry", () => {
    expect(NAMES.length).toBeGreaterThan(40);
    for (const name of NAMES) {
      const e = GLYPH_VOCABULARY[name];
      expect(e.glyph.length, name).toBeGreaterThan(0);
      // A meaning short enough to be a label is not a meaning — the point of the
      // registry is that the next producer can decide from it.
      expect(e.means.length, name).toBeGreaterThan(30);
      expect(["actor", "alert", "topic", "state", "control"], name).toContain(
        e.role
      );
    }
  });

  // RULE 1, AS AN ASSERTION. Two entries sharing a glyph is the synonym problem seen
  // from the other side: one symbol answering to two concepts, which is what makes a
  // reader stop and work out whether the difference matters.
  it("gives each concept its OWN glyph — no entry shares one", () => {
    const seen = new Map<string, GlyphName>();
    for (const name of NAMES) {
      const g = GLYPH_VOCABULARY[name].glyph;
      const prev = seen.get(g);
      expect(prev, `${g}: ${prev} and ${name} claim the same glyph`).toBe(
        undefined
      );
      seen.set(g, name);
    }
  });

  it("exposes the same glyph through the call-site lookup", () => {
    for (const name of NAMES) {
      expect(GLYPH[name], name).toBe(GLYPH_VOCABULARY[name].glyph);
    }
  });

  // THE ENCODING GUARANTEE, derived from Unicode rather than from a hand-kept list.
  //
  // 🌡 rendered two ways in one product because U+1F321 is `\p{Emoji}` but NOT
  // `\p{Emoji_Presentation}` — a codepoint whose default face is the monochrome TEXT
  // glyph, which becomes a colour emoji only when a U+FE0F follows it. Six sites had the
  // selector and one did not, and nothing could tell.
  //
  // So: a presentation-AMBIGUOUS base must carry an explicit selector, and an
  // unambiguous one must carry none — because a redundant selector is a second spelling
  // of the same glyph, which is the same defect wearing the opposite sign.
  it("pins one unambiguous encoding per entry", () => {
    for (const name of NAMES) {
      const g = GLYPH_VOCABULARY[name].glyph;
      const cps = [...g];
      const base = cps[0];
      const rest = cps.slice(1);
      expect(
        rest.length,
        `${name}: ${g} is more than a base + selector`
      ).toBeLessThan(2);
      const selector = rest[0] ?? "";
      if (rest.length === 1) {
        expect(
          ["️", "︎"],
          `${name}: trailing codepoint is not a variation selector`
        ).toContain(selector);
      }
      const isEmoji = /\p{Emoji}/u.test(base) && base.codePointAt(0)! > 0x7f;
      const defaultsToEmoji = /\p{Emoji_Presentation}/u.test(base);
      if (isEmoji && !defaultsToEmoji) {
        expect(
          selector,
          `${name}: ${JSON.stringify(g)} is presentation-ambiguous and must declare U+FE0F or U+FE0E`
        ).not.toBe("");
      } else {
        expect(
          selector,
          `${name}: ${JSON.stringify(g)} already has one face — a variation selector is a second spelling`
        ).toBe("");
      }
    }
  });

  // RULE 1'S OTHER HALF. A retirement is a claim that a form no longer exists in the
  // vocabulary, so it must point at a real survivor and must not itself be live.
  it("records every retirement against a live survivor", () => {
    expect(RETIRED_GLYPHS.length).toBeGreaterThan(3);
    const live = new Set(NAMES.map((n) => GLYPH_VOCABULARY[n].glyph));
    const forms = new Set<string>();
    for (const r of RETIRED_GLYPHS) {
      expect(NAMES, r.form).toContain(r.replacedBy);
      expect(live.has(r.form), `${r.form} is retired AND live`).toBe(false);
      expect(forms.has(r.form), `${r.form} retired twice`).toBe(false);
      forms.add(r.form);
      expect(r.why.length, r.form).toBeGreaterThan(60);
    }
  });
});

// ---------------------------------------------------------------------------
// THE SCAN (#2392)
// ---------------------------------------------------------------------------

// GLYPH SCAN. A vocabulary without a scan is a document, and 53 glyphs across 42 files is
// what a document becomes. A module in the DECLARED scope (GLYPH_MODULES) may not carry
// an emoji LITERAL: it references GLYPH, or it carries an allowlist entry below with a
// written reason.
//
// Same shape as lib/__tests__/message-line.test.ts one layer up, and it reuses that
// module's tokenizer outright rather than growing a second one — the question ("what are
// the string literals in this file, ignoring comments?") is identical, and two answers to
// it would drift.
//
// WHAT IT DOES NOT GUARANTEE, stated so the guarantee isn't overread:
//
//   • It is a TEXT scan over string literals. A glyph assembled from `String.fromCodePoint`
//     or held in a constant in an unregistered module and imported is invisible to it.
//     (A `\uXXXX` escape is NOT invisible — the source is unescaped before tokenizing,
//     which is how the digest's `"\u{1F6B4}"` was found.)
//   • `\p{Extended_Pictographic}` is the detector, so a symbol that is not a pictograph
//     at all — the recap's `•` bullet, the priority line's `⚑` — is registered for the
//     vocabulary's sake but cannot be enforced by it. RETIRED_GLYPHS closes exactly one
//     hole here on purpose: `✓` is not a pictograph either, and it is the synonym most
//     likely to come back.
//   • It says nothing about whether a producer chose the RIGHT concept. That is what the
//     `means` field is for, and what review reads.

const PICTOGRAPH = /\p{Extended_Pictographic}/u;

// Unescape `\uXXXX` and `\u{XXXXX}` before tokenizing, so an escaped glyph and a typed
// one are the same thing to the scan. Escapes contain no newlines, so line numbers are
// unaffected.
export function unescapeCodepoints(src: string): string {
  return src.replace(
    /\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})/g,
    (m, a, b) => {
      const cp = parseInt(a ?? b, 16);
      if (!Number.isFinite(cp) || cp > 0x10ffff) return m;
      const ch = String.fromCodePoint(cp);
      // Only PICTOGRAPHS are worth un-escaping; every other escape stays as written,
      // so an ordinary one (a newline, a quote) is not rewritten into something the
      // tokenizer then has to reason about.
      return PICTOGRAPH.test(ch) ? ch : m;
    }
  );
}

// A reviewed survivor: an emoji literal inside a registered module that is legitimately
// not a produced glyph. Matched on the module plus a substring of the physical source
// line, so an exemption cannot silently widen to the rest of the file.
const ALLOW: { module: string; includes: string; why: string }[] = [
  {
    module: "lib/notifications/reconcile-registry.ts",
    includes: "the on-demand `/practice` list's",
    why: "DOCUMENTATION PROSE in a `why:` field, quoting the practice list's confirm button so the family's rationale names the control it is about. It produces no message text — the button itself is built in practices.ts and takes its glyph from the registry — and interpolating a reference into a paragraph of explanation would make the paragraph harder to read than the drift it guards against.",
  },
  {
    module: "lib/notifications/reconcile-registry.ts",
    includes: 'inert: "closes the',
    why: "The same: prose describing what a callback does ('closes the Tune panel'), quoting the control's label. The label is produced in digest-tune.ts from the registry; this sentence only refers to it.",
  },
  {
    module: "lib/notifications/reconcile-registry.ts",
    includes: "The generic (chat, kind) rule cannot express",
    why: "The same: a `why:` paragraph quoting the food nudge's view-control button while explaining why that nudge keeps its own pointer rotation. Prose about a control, not a control.",
  },
];

const MODULE_PATHS = GLYPH_MODULES.map((m) => m.module);

interface Violation {
  module: string;
  line: number;
  glyph: string;
  source: string;
  hint: string;
}

export function scanGlyphModule(rel: string, src: string): Violation[] {
  // SCOPE IS DECLARED, NOT INFERRED — see the comment on GLYPH_MODULES. An unregistered
  // module is out of scope by construction: `lib/datasets/food-groups.ts` carries one
  // icon per catalog row and `lib/mood.ts` a graded 1–5 scale of faces, and neither is a
  // vocabulary of concepts.
  if (!MODULE_PATHS.includes(rel)) return [];
  const unescaped = unescapeCodepoints(src);
  const physical = unescaped.split("\n");
  const retired = new Map(RETIRED_GLYPHS.map((r) => [r.form, r]));
  const out: Violation[] = [];
  for (const lit of stringLiterals(unescaped)) {
    const found = new Set<string>();
    for (const ch of lit.text) {
      if (PICTOGRAPH.test(ch) || retired.has(ch)) found.add(ch);
    }
    if (found.size === 0) continue;
    const source = (physical[lit.line - 1] ?? "").trim();
    if (
      ALLOW.some((a) => a.module === rel && source.includes(a.includes)) ||
      // A multi-line construct: allow a match against the statement's opening lines too,
      // so an exemption anchored on a wrapped expression still resolves.
      ALLOW.some(
        (a) =>
          a.module === rel &&
          physical
            .slice(Math.max(0, lit.line - 4), lit.line)
            .join("")
            .replace(/\s+/g, " ")
            .includes(a.includes)
      )
    )
      continue;
    for (const glyph of found) {
      const gone = retired.get(glyph);
      out.push({
        module: rel,
        line: lit.line,
        glyph,
        source,
        hint: gone
          ? `${glyph} was RETIRED — the concept is GLYPH.${gone.replacedBy}`
          : `use GLYPH.<concept> from lib/notifications/glyphs.ts`,
      });
    }
  }
  return out;
}

describe("glyph scan: the declared scope references the registry", () => {
  it("registers real, unique modules, each with a written reason", () => {
    expect(GLYPH_MODULES.length).toBeGreaterThan(20);
    expect(new Set(MODULE_PATHS).size).toBe(MODULE_PATHS.length);
    for (const m of GLYPH_MODULES) {
      expect(fs.existsSync(path.join(REPO, m.module)), m.module).toBe(true);
      expect(m.why.length, m.module).toBeGreaterThan(40);
    }
  });

  it("carries a written reason on every allowlist entry", () => {
    for (const a of ALLOW) {
      expect(MODULE_PATHS, a.includes).toContain(a.module);
      expect(a.includes.length, a.includes).toBeGreaterThan(4);
      expect(a.why.length, a.includes).toBeGreaterThan(60);
    }
  });

  it("has no emoji literal in a registered module", () => {
    const violations = GLYPH_MODULES.flatMap((m) =>
      scanGlyphModule(
        m.module,
        fs.readFileSync(path.join(REPO, m.module), "utf8")
      )
    );
    const report = violations
      .map(
        (v) =>
          `${v.module}:${v.line} has "${v.glyph}" — ${v.hint}.\n    ${v.source}`
      )
      .join("\n");
    expect(violations, `\n${report}\n`).toEqual([]);
  });

  it("has no STALE allowlist entry", () => {
    // An exemption that no longer matches anything is a claim about code that has moved
    // on. Each entry must still resolve, so removing a survivor removes its reason too.
    for (const a of ALLOW) {
      const src = fs.readFileSync(path.join(REPO, a.module), "utf8");
      expect(
        src.replace(/\s+/g, " ").includes(a.includes.replace(/\s+/g, " ")),
        `${a.module}: ${a.includes}`
      ).toBe(true);
    }
  });

  // EVERY REGISTERED CONCEPT IS USED. A vocabulary that grows entries nobody references
  // is a palette, and a palette is what this replaced. An entry whose last producer went
  // away is retired, not left sitting.
  it("has no entry no producer references", () => {
    const sources = [
      ...GLYPH_MODULES.map((m) => m.module),
      "lib/notifications/message-line.ts",
    ]
      .map((m) => fs.readFileSync(path.join(REPO, m), "utf8"))
      .join("\n");
    const unused = NAMES.filter((n) => !sources.includes(`GLYPH.${n}`));
    expect(unused, `unused: ${unused.join(", ")}`).toEqual([]);
  });

  // THE FIXTURES THAT PROVE THE GUARD CAN FAIL. They pass today because the tree is
  // clean, which is indistinguishable from a scanner whose detector never matches.
  it("FLAGS an emoji literal planted in a registered module", () => {
    const planted = [
      "// A comment naming 😴 the sleep glyph is prose, not a producer.",
      "export function line(t: string) {",
      "  return `😴 ${t}`;",
      "}",
    ].join("\n");
    const found = scanGlyphModule("lib/notifications/digest.ts", planted);
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(3);
    expect(found[0].glyph).toBe("😴");
    // The same source in an UNREGISTERED module is out of scope by declaration.
    expect(scanGlyphModule("lib/datasets/food-groups.ts", planted)).toEqual([]);
  });

  it("FLAGS a glyph smuggled in as a codepoint ESCAPE", () => {
    // The digest carried exactly this — `glyph: "\u{1F6B4}"` — and a scan reading the raw
    // source would have seen nine ASCII characters and passed it.
    const planted = 'export const g = "\\u{1F6B4}";';
    const found = scanGlyphModule("lib/notifications/digest.ts", planted);
    expect(found).toHaveLength(1);
    expect(found[0].glyph).toBe("\u{1F6B4}");
  });

  it("FLAGS a RETIRED form by name, even one that is not a pictograph", () => {
    const planted = "export const l = `✓ ${name}`;";
    const found = scanGlyphModule("lib/notifications/practices.ts", planted);
    expect(found).toHaveLength(1);
    expect(found[0].hint).toContain("GLYPH.done");
  });

  it("does not flag ordinary punctuation or a registry reference", () => {
    const clean = [
      "export const a = `goal 100–130 g · reached — nice`;",
      "export const b = `${GLYPH.sleep} Last night: ${d}`;",
      'export const c = "well-being ×2 ≈ 4";',
    ].join("\n");
    expect(scanGlyphModule("lib/notifications/digest.ts", clean)).toEqual([]);
  });
});
