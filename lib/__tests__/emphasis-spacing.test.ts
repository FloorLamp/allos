import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static guard for the missing-space-around-bold-text defect the all-pages
// census found (#1447): pages rendering "At minimaldetail each event…",
// "A read-onlygrant can view everything", "…you can access.Each profile keeps…".
//
// ── The surprise, and why this guard looks the way it does ──────────────────
//
// The issue assumed an authoring slip (`<strong>word</strong>text`). It is not:
// a scan for that shape returns ZERO hits, and every reported line has its space
// in the source. The defect is in the JSX → SSR output. In ONE paragraph of
// Settings → Server, two structurally identical lines behave differently:
//
//   Two tiers, each its own provider. <strong>Heavy</strong> handles
//   …
//   endpoint for zero external egress. <strong>Light</strong> handles
//
// renders as "…provider. Heavy handles…" but "…egress. Lighthandles…". The
// difference is not the markup — it's that the text node following </strong>
// CONTAINS AN HTML ENTITY further along (`when it&rsquo;s unset`). A JSX text
// node that (a) follows an element or expression, (b) begins with a space, and
// (c) contains an entity, loses that leading space in the emitted HTML. It is
// visible in the raw SSR response, so it's the server render, not hydration.
//
// The fix is therefore NOT to add spaces — they're already there — but to keep
// the entity out of such a text node. `&rsquo;`/`&ldquo;`/`&rdquo;` have exact
// literal equivalents (’ “ ”) that render identically, so swapping them is a
// no-op for the reader and sidesteps the bug entirely. (`{" "}` also fixes it,
// but prettier collapses `{" "}` back into a literal space whenever the line
// fits — so that fix cannot survive `npm run format` and must not be used here.)
//
// This test therefore bans the TRIGGER, which is what's actually detectable in
// source, plus the two straightforward authoring slips that have no legitimate
// use anyway.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// Directories scanned for rendered copy (React lives here).
const SCAN_DIRS = ["app", "components"];

const INLINE_TAGS = "strong|em|b|code|a";
const ENTITY = /&[a-zA-Z]+;|&#\d+;/;

// THE trigger: a closing inline tag (or a closing expression brace), one space,
// then the rest of that text node — everything up to the next tag or expression.
// Flagged when that remainder carries an HTML entity.
const AFTER_TAG = new RegExp(`</(?:${INLINE_TAGS})>( )([^<{}]*)`, "g");
const AFTER_EXPR = /\}( )([^<{}]*)/g;

// The two plain authoring slips: a tag butted against a word, and the separating
// space parked inside the emphasis element (where it bolds with the run).
const TAG_BUTTED = new RegExp(
  `(</(?:${INLINE_TAGS})>[A-Za-z0-9]|[A-Za-z0-9]<(?:strong|em|b)>)`
);
const SPACE_INSIDE = /(<(?:strong|em|b)> | <\/(?:strong|em|b)>)/;

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
      if (rel.includes("__tests__") || rel.endsWith(".test.tsx")) continue;
      files.push({ rel, text: fs.readFileSync(full, "utf8") });
    }
  }
  return files;
}

function entityAfterSpace(re: RegExp): string[] {
  const out: string[] = [];
  for (const { rel, text } of sourceFiles()) {
    for (const m of text.matchAll(new RegExp(re))) {
      const remainder = m[2] ?? "";
      if (!ENTITY.test(remainder)) continue;
      const line = text.slice(0, m.index).split("\n").length;
      out.push(`${rel}:${line}: …${remainder.trim().slice(0, 70)}`);
    }
  }
  return out;
}

function lineHits(re: RegExp): string[] {
  const out: string[] = [];
  for (const { rel, text } of sourceFiles()) {
    text.split("\n").forEach((line, i) => {
      if (re.test(line)) out.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  return out;
}

describe("spacing around bold/inline spans in rendered copy (#1447)", () => {
  it("scans a non-trivial number of rendered source files", () => {
    // Guards the guard: a broken walk would make every assertion below vacuous.
    expect(sourceFiles().length).toBeGreaterThan(200);
  });

  it("never puts an HTML entity in a text node that follows a tag and starts with a space", () => {
    // Use the literal character (’ “ ” instead of &rsquo; &ldquo; &rdquo;) — it
    // renders identically and keeps the leading space. See the header.
    expect(entityAfterSpace(AFTER_TAG)).toEqual([]);
  });

  it("never puts an HTML entity in a text node that follows an expression and starts with a space", () => {
    expect(entityAfterSpace(AFTER_EXPR)).toEqual([]);
  });

  it("never butts a bold/italic span against the word beside it", () => {
    expect(lineHits(TAG_BUTTED)).toEqual([]);
  });

  it("never parks the separating space inside the emphasis element", () => {
    expect(lineHits(SPACE_INSIDE)).toEqual([]);
  });

  it("detects each shape when it is present", () => {
    // Pins the patterns themselves, so a refactor can't silently relax them into
    // something that matches nothing.
    const trigger = (s: string) => {
      const m = [...s.matchAll(new RegExp(AFTER_TAG))];
      return m.some((x) => ENTITY.test(x[2] ?? ""));
    };
    expect(
      trigger("<strong>Light</strong> handles when it&rsquo;s unset")
    ).toBe(true);
    // The same line with a literal apostrophe is fine — that's the fix.
    expect(trigger("<strong>Light</strong> handles when it’s unset")).toBe(
      false
    );
    // A space-free follower is not this defect (it's TAG_BUTTED's business).
    expect(trigger("<strong>Light</strong>handles it&rsquo;s")).toBe(false);

    expect(TAG_BUTTED.test("A <strong>read-only</strong>grant")).toBe(true);
    expect(TAG_BUTTED.test("A <strong>read-only</strong> grant")).toBe(false);
    // Punctuation directly after a span is correct, not a defect.
    expect(TAG_BUTTED.test("in <strong>bold</strong>.")).toBe(false);
    expect(TAG_BUTTED.test("(<strong>bold</strong>)")).toBe(false);

    expect(SPACE_INSIDE.test("A<strong> read-only</strong> grant")).toBe(true);
    expect(SPACE_INSIDE.test("A <strong>read-only</strong> grant")).toBe(false);
  });
});
