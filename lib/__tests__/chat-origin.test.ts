import fsMod from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stripComments } from "./strip-comments";
import {
  keyboardChatOrigin,
  markToken,
  ORIGIN_MARK_PATTERN,
  originFromToken,
  withChatOrigin,
} from "@/lib/notifications/chat-origin";
import { TELEGRAM_CALLBACK_DATA_MAX_BYTES } from "@/lib/notifications/callback-tokens";
import {
  FOOD_NUDGE_WINDOWS,
  foodLogCallbackData,
} from "@/lib/notifications/food-format";
import { foodGroupSlugs } from "@/lib/food-groups";
import { makeTmpDir } from "./tmp-dir";

// The pure half of the chat origin marker (#3087). The round trip — a real send, a
// real tap, a real rebuild — is lib/__db_tests__/logged-via-chat-origin.test.ts;
// what is pinned here is the wire format and the one rule whose absence caused a
// measured regression: a rebuild of an unmarked keyboard must stay unmarked.

describe("the marker on the wire", () => {
  it("puts itself in a segment of its own, ahead of the greedy slug", () => {
    expect(
      markToken("food:5:Midday:2026-07-13:leafy_greens", "telegram-command")
    ).toBe("food:c:5:Midday:2026-07-13:leafy_greens");
    expect(
      markToken("foodprotein:5:Evening:2026-07-13:30", "telegram-nudge")
    ).toBe("foodprotein:n:5:Evening:2026-07-13:30");
  });

  it("REPLACES a marker rather than stacking one, so a rebuild is idempotent", () => {
    const once = markToken("food:5:Midday:2026-07-13:x", "telegram-nudge");
    const twice = markToken(once, "telegram-nudge");
    expect(twice).toBe(once);
    expect(markToken(once, "telegram-command")).toBe(
      "food:c:5:Midday:2026-07-13:x"
    );
  });

  it("leaves every other token family alone", () => {
    // Rewriting a prefix nothing parses back would mint a button whose tap is
    // silently refused — a worse bug than the one the marker fixes.
    for (const token of [
      "take:5:1:2:2026-07-13",
      "prn:5:9:ab12",
      "foodmore:5:Midday:2026-07-13",
      "foodoptin:5:yes",
      "pdone:5:7:n1",
    ]) {
      expect(markToken(token, "telegram-command")).toBe(token);
    }
  });

  // ── THE BYTE CAP, DERIVED FROM THE BOUNDARY ─────────────────────────────────
  //
  // A GUARD OVER A BOUNDARY MUST BUILD ITS WORST CASE FROM THE BOUNDARY. The version
  // this replaced hard-coded `64` and a hand-made 21-character slug,
  // `sugary_foods_desserts`, WHICH IS NOT IN THE CATALOG (#3567) — so it tested an
  // invented token against an invented cap and could not have noticed either one
  // moving. Every segment below now comes from the thing that decides it:
  //
  //   the cap      TELEGRAM_CALLBACK_DATA_MAX_BYTES (lib/notifications/callback-data.ts)
  //   the windows  FOOD_NUDGE_WINDOWS  — Morning/Midday/Evening, longest 7
  //   the slug     foodGroupSlugs()    — the real catalog, 25 entries, longest 17
  //   the token    foodLogCallbackData + markToken, the two functions that mint it
  //
  // WHICH PROFILE ID, AND WHY IT IS THE WIDEST ONE. `profiles.id` is
  // `INTEGER PRIMARY KEY AUTOINCREMENT`, so a production instance counts from 1 and
  // its food tokens run to about 45 bytes — which is what chat-origin.ts's comment
  // says, and it is right. But this tree's DB tier deliberately mints WIDE ids:
  // lib/__db_tests__/fixture-profile-space.ts moves each test file's allocation into a
  // `(pid, thread)`-keyed block, so its profiles are twelve digits today and the only
  // thing bounding them is `Number.isSafeInteger`. A cap guard built from a
  // production-shaped id would therefore test LOOSER than the fixtures already
  // exercise, which is the wrong direction for a cap. So it is built from the widest
  // id this app can round-trip at all — `Number.MAX_SAFE_INTEGER`, sixteen digits —
  // and that is strictly wider than anything either tier can produce.
  const WIDEST_PROFILE_ID = Number.MAX_SAFE_INTEGER;
  // Any real day: the parser fixes the shape at `\d{4}-\d{2}-\d{2}`, so every date is
  // exactly ten bytes and no date is worse than another.
  const A_DATE = "2026-12-31";

  const widestFoodToken = (): string => {
    const window = [...FOOD_NUDGE_WINDOWS].sort(
      (a, b) => b.length - a.length
    )[0];
    const slug = [...foodGroupSlugs()].sort((a, b) => b.length - a.length)[0];
    return markToken(
      foodLogCallbackData(WIDEST_PROFILE_ID, window, A_DATE, slug),
      "telegram-command"
    );
  };

  it("keeps the WIDEST food token this tree can mint inside Telegram's cap", () => {
    const longest = widestFoodToken();
    // Named so a failure reads as "which segment grew", not as a bare number.
    expect(
      Buffer.byteLength(longest, "utf8"),
      `worst-case marked food token: ${longest}`
    ).toBeLessThanOrEqual(TELEGRAM_CALLBACK_DATA_MAX_BYTES);
  });

  it("would SEE the overflow — a slug one byte past the headroom breaks the cap", () => {
    // A PASSING CAP CHECK SAYS NOTHING ABOUT WHAT THE CHECK CAN SEE. The assertion
    // above is green with room to spare, and would stay green if some segment stopped
    // being included at all. So the same derivation is run against a catalog entry
    // authored to break it: the widest slug that still fits, plus one character.
    //
    // No magic number — the headroom is measured, and the fixture is built from it.
    // The slug is the only segment a routine change grows (a new food group is one
    // JSON entry away; the cap, the windows and the id width are not), so bytes of
    // slug is the honest unit to state the remaining room in.
    const headroom =
      TELEGRAM_CALLBACK_DATA_MAX_BYTES -
      Buffer.byteLength(widestFoodToken(), "utf8");
    expect(headroom).toBeGreaterThanOrEqual(0);

    const window = [...FOOD_NUDGE_WINDOWS].sort(
      (a, b) => b.length - a.length
    )[0];
    const longestSlug = [...foodGroupSlugs()].sort(
      (a, b) => b.length - a.length
    )[0];
    const tokenFor = (slug: string): string =>
      markToken(
        foodLogCallbackData(WIDEST_PROFILE_ID, window, A_DATE, slug),
        "telegram-command"
      );

    // Exactly at the cliff: still allowed.
    const atCap = "x".repeat(longestSlug.length + headroom);
    expect(Buffer.byteLength(tokenFor(atCap), "utf8")).toBe(
      TELEGRAM_CALLBACK_DATA_MAX_BYTES
    );
    // One character over: the cap is breached, so the derivation is TIGHT rather than
    // merely satisfied. A future slug of this length is what closes the gap.
    expect(
      Buffer.byteLength(tokenFor(`${atCap}x`), "utf8"),
      `a food-group slug may run to ${atCap.length} characters before its callback ` +
        `token overflows Telegram's cap (longest in the catalog today: ` +
        `${longestSlug}, ${longestSlug.length}).`
    ).toBeGreaterThan(TELEGRAM_CALLBACK_DATA_MAX_BYTES);
  });
});

describe("reading it back", () => {
  it("reads an UNMARKED token as the nudge, at the tap", () => {
    // A handler must produce a value, and a keyboard minted before this shipped is
    // almost always a proactive send.
    expect(originFromToken("food:5:Midday:2026-07-13:x")).toBe(
      "telegram-nudge"
    );
    expect(originFromToken("food:c:5:Midday:2026-07-13:x")).toBe(
      "telegram-command"
    );
    expect(originFromToken(undefined)).toBe("telegram-nudge");
  });

  it("answers NULL for an unmarked KEYBOARD, which is not the same question", () => {
    // THE RULE A REGRESSION TAUGHT. A rebuild preserves what the delivered keyboard
    // says. A legacy keyboard says nothing — so the rebuild must say nothing, or it
    // differs from what is on screen by exactly the marker and the hourly sweep
    // spends one Telegram edit per live food message adding it.
    expect(
      keyboardChatOrigin([[{ callback_data: "food:5:Midday:2026-07-13:x" }]])
    ).toBeNull();
    expect(keyboardChatOrigin(undefined)).toBeNull();
    expect(
      keyboardChatOrigin([[{ callback_data: "take:5:1:2:2026-07-13" }]])
    ).toBeNull();
    expect(
      keyboardChatOrigin([
        [{ callback_data: "foodmore:5:Midday:2026-07-13" }],
        [{ callback_data: "food:c:5:Midday:2026-07-13:x" }],
      ])
    ).toBe("telegram-command");
  });

  it("leaves a message untouched when the origin is null", () => {
    const msg = {
      title: "t",
      body: "b",
      actions: [{ label: "x", data: "food:5:Midday:2026-07-13:x" }],
    };
    expect(withChatOrigin(msg, null)).toBe(msg);
    expect(withChatOrigin(null, "telegram-command")).toBeNull();
    expect(withChatOrigin(msg, "telegram-command").actions[0].data).toBe(
      "food:c:5:Midday:2026-07-13:x"
    );
    // …and the original is not mutated: a builder's output is re-rendered elsewhere.
    expect(msg.actions[0].data).toBe("food:5:Midday:2026-07-13:x");
  });
});

// ── THE REBUILD CENSUS ────────────────────────────────────────────────────────
//
// EVERY REBUILD PRESERVES is a rule about CALL SITES, and a rule about call sites is
// not something a type can hold: `buildFoodNudge` returns a perfectly good message
// whether or not anybody re-applies the marker to it. Four sites rebuild a food nudge
// and one of them shipped unwrapped, sixty lines below the comment stating the hazard.
// One tap on that path rewrote all seven buttons UNMARKED, `keyboardChatOrigin` then
// answered null for that keyboard for ever, and every later tap on the message
// recorded `telegram-nudge` — a permanent, one-directional inflation of the nudge
// count on the exact axis this column exists to measure.
//
// So the census asks the only question that generalises: is every call to the builder
// the FIRST ARGUMENT of `withChatOrigin`? A fifth rebuild site is then a red rather
// than a review catch.
//
// READS BYTES rather than shelling out to a grep, for the #3206 reason: a source file
// carrying a deliberate NUL separator is BINARY to grep and would be skipped, so a
// shelled-out sweep would report a pass it never took.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** The builder's own module — the definition, not a rebuild. */
const BUILDER_MODULE = "lib/notifications/food.ts";

/**
 * Comments name this builder constantly; only a CALL is a call.
 *
 * Shared with the surface-wiring census — see lib/__tests__/strip-comments.ts for
 * why one scanner replaced the pair of ordered regexes both files used to carry.
 */
function code(src: string): string {
  return stripComments(src);
}

type SourceFile = { rel: string; raw: string; code?: string };

let repoSourcesCache: SourceFile[] | undefined;

function sourceCode(file: SourceFile): string {
  return (file.code ??= code(file.raw));
}

function sources(root: string): SourceFile[] {
  // The production census has several independent assertions over one immutable
  // checkout. Read and strip it once for this file; synthetic temp corpora remain
  // uncached because those tests author their files immediately before scanning.
  if (root === REPO && repoSourcesCache) return repoSourcesCache;
  const out: SourceFile[] = [];
  const rec = (dir: string): void => {
    let entries: fsMod.Dirent[] = [];
    try {
      entries = fsMod.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next") continue;
        rec(p);
        continue;
      }
      if (!p.endsWith(".ts") && !p.endsWith(".tsx")) continue;
      const rel = path.relative(root, p).split(path.sep).join("/");
      if (/__(?:db_|action_)?tests__/.test(rel)) continue;
      if (rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) continue;
      out.push({ rel, raw: fsMod.readFileSync(p, "utf8") });
    }
  };
  for (const sub of ["lib", "app", "components"]) rec(path.join(root, sub));
  const sorted = out.sort((a, b) => a.rel.localeCompare(b.rel));
  if (root === REPO) repoSourcesCache = sorted;
  return sorted;
}

/** The builder's own name. */
const BUILDER = "buildFoodNudge";

/**
 * Every name the builder can be CALLED by anywhere in the tree.
 *
 * A census that matches one spelling of a symbol fails open on every other one, and
 * reports clean because it cannot see (#3580). `import { buildFoodNudge as build }`
 * then `build(…)` is the same rebuild and used to return `[]`; so does the same
 * rename through a barrel — `export { buildFoodNudge as build } from "./food"` — and
 * a barrel re-exporting a barrel. The loop runs to a fixed point for that last one.
 *
 * Every caller in this tree writes the plain named import today, so this is latent
 * rather than live. That is the point: the guard has to be able to see the shape
 * BEFORE somebody writes it, or the day it appears is the day it is invisible.
 */
export function builderAliases(files: SourceFile[]): Set<string> {
  const out = new Set([BUILDER]);
  for (let grew = true; grew;) {
    grew = false;
    for (const file of files) {
      // Most files cannot extend the alias graph. The raw gate is only a cheap
      // rejection; candidates still run through the comment-aware scanner.
      if (
        !file.raw.includes("export") ||
        ![...out].some((alias) => file.raw.includes(alias))
      )
        continue;
      const src = sourceCode(file);
      for (const m of src.matchAll(
        /export\s*\{([^}]*)\}\s*from\s*["'][^"']+["']/g
      ))
        for (const part of m[1].split(",")) {
          const t = part.trim().replace(/^type\s+/, "");
          if (!t) continue;
          const [orig, alias] = /\s+as\s+/.test(t)
            ? (t.split(/\s+as\s+/).map((x) => x.trim()) as [string, string])
            : [t, t];
          if (out.has(orig) && !out.has(alias)) {
            out.add(alias);
            grew = true;
          }
        }
    }
  }
  return out;
}

/** What THIS file can call the builder by, after resolving its own imports. */
function localBuilderNames(
  file: SourceFile,
  aliases: Set<string>
): Set<string> {
  const out = new Set([BUILDER]);
  const src = sourceCode(file);
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'][^"']+["']/g))
    for (const part of m[1].split(",")) {
      const t = part.trim().replace(/^type\s+/, "");
      if (!t) continue;
      const [orig, local] = /\s+as\s+/.test(t)
        ? (t.split(/\s+as\s+/).map((x) => x.trim()) as [string, string])
        : [t, t];
      if (aliases.has(orig)) out.add(local);
    }
  // `import * as F from "…"` then `F.buildFoodNudge(…)` — the same indirection in
  // the namespace spelling.
  for (const m of src.matchAll(
    /import\s*\*\s*as\s+([A-Za-z0-9_$]+)\s*from\s*["'][^"']+["']/g
  ))
    for (const a of aliases) out.add(`${m[1]}.${a}`);
  return out;
}

/** Every call to the builder, under any name, as `file:line`. */
function builderCalls(
  root: string
): { rel: string; src: string; at: number }[] {
  const files = sources(root);
  const aliases = builderAliases(files);
  const out: { rel: string; src: string; at: number }[] = [];
  for (const file of files) {
    if (file.rel === BUILDER_MODULE) continue;
    // A file with none of the reachable names cannot call the builder.
    if (![...aliases].some((alias) => file.raw.includes(alias))) continue;
    const src = sourceCode(file);
    for (const name of localBuilderNames(file, aliases)) {
      const re = new RegExp(`\\b${name.replace(/\./g, "\\.")}\\s*\\(`, "g");
      for (const m of src.matchAll(re))
        out.push({ rel: file.rel, src, at: m.index ?? 0 });
    }
  }
  return out;
}

/** Every call to the builder that is NOT wrapped, as `file:line`. */
export function unwrappedFoodRebuilds(root: string): string[] {
  const out: string[] = [];
  for (const { rel, src, at } of builderCalls(root)) {
    // The wrap, allowing the formatter's line break between the two calls.
    const before = src.slice(Math.max(0, at - 60), at);
    if (/withChatOrigin\s*\(\s*$/.test(before)) continue;
    // THE LINE IS THE REAL LINE (#3580 item 3, closed by #3581). This counts on the
    // COMMENT-BLANKED source, which used to be a different file: the old stripper
    // DELETED comments, so a ten-line block comment collapsed and every line after
    // it was reported short — a call at :13 came out as `lib/x.ts:4`. The shared
    // scanner blanks in place and keeps every newline, so the two agree by
    // construction. Pinned below rather than assumed.
    out.push(`${rel}:${src.slice(0, at).split("\n").length}`);
  }
  return [...new Set(out)].sort();
}

describe("every rebuild of a food nudge re-applies the origin", () => {
  it("leaves no call site rebuilding a nudge without re-applying the marker", () => {
    // Prove the scan reached the relevant corpus before making an absence claim.
    // Counting files is weak evidence; counting the calls this rule judges is direct.
    expect(builderCalls(REPO).length).toBeGreaterThanOrEqual(6);
    expect(
      unwrappedFoodRebuilds(REPO),
      "A `buildFoodNudge(…)` call is not wrapped in `withChatOrigin(…)` (#3087). " +
        "Every send and every rebuild of this keyboard must re-apply the origin it " +
        "read off the tapped token or the live keyboard — an unwrapped rebuild " +
        "strips the marker from the whole keyboard permanently, and every later tap " +
        "on that message records `telegram-nudge` whatever surface it came from."
    ).toEqual([]);
  });

  it("SEES an unwrapped rebuild, and stays quiet on the wrapped ones", () => {
    // A green sweep over a complying tree says nothing about what the sweep can see,
    // so the offender is planted on disk and the whole walker runs over it — including
    // the two spellings the formatter actually produces, and a comment that merely
    // names the builder.
    const root = makeTmpDir("food-rebuild");
    fsMod.mkdirSync(path.join(root, "lib/notifications"), { recursive: true });
    fsMod.writeFileSync(
      path.join(root, "lib/notifications/handlers.ts"),
      [
        "// buildFoodNudge is the builder every send and rebuild shares.",
        "const a = withChatOrigin(buildFoodNudge(p, w, d), origin);",
        "const b = withChatOrigin(",
        "  buildFoodNudge(p, w, d, n, { ref }),",
        "  keyboardChatOrigin(rows)",
        ");",
        "const c = buildFoodNudge(p, w, d, n, { ref });",
        "/* withChatOrigin(buildFoodNudge()) in a block comment is not a call */",
      ].join("\n")
    );
    expect(unwrappedFoodRebuilds(root)).toEqual([
      "lib/notifications/handlers.ts:7",
    ]);
  });

  it("SEES a rebuild through an ALIASED import", () => {
    // FAIL-OPEN ON AN INDIRECTION (#3580 item 2). `import { buildFoodNudge as build }`
    // then `build(…)` rebuilds the same keyboard and used to return `[]`.
    const root = makeTmpDir("food-rebuild-alias");
    fsMod.mkdirSync(path.join(root, "lib/notifications"), { recursive: true });
    fsMod.writeFileSync(
      path.join(root, "lib/notifications/aliased.ts"),
      [
        'import { buildFoodNudge as build } from "@/lib/notifications/food";',
        "const a = withChatOrigin(build(p, w, d), origin);",
        "const b = build(p, w, d, n, { ref });",
      ].join("\n")
    );
    expect(unwrappedFoodRebuilds(root)).toEqual([
      "lib/notifications/aliased.ts:3",
    ]);
  });

  it("SEES a rebuild reached through a BARREL that renames the builder", () => {
    // The same indirection one hop further out: the barrel renames, the caller only
    // ever sees the new name, and nothing in either file spells `buildFoodNudge(`.
    const root = makeTmpDir("food-rebuild-barrel");
    fsMod.mkdirSync(path.join(root, "lib/notifications"), { recursive: true });
    fsMod.writeFileSync(
      path.join(root, "lib/notifications/index.ts"),
      'export { buildFoodNudge as renderFood } from "./food";\n'
    );
    fsMod.writeFileSync(
      path.join(root, "lib/notifications/sweep.ts"),
      [
        'import { renderFood } from "@/lib/notifications";',
        "const a = withChatOrigin(renderFood(p, w, d), origin);",
        "const b = renderFood(p, w, d);",
      ].join("\n")
    );
    expect(unwrappedFoodRebuilds(root)).toEqual([
      "lib/notifications/sweep.ts:3",
    ]);
  });

  it("STAYS QUIET on a same-named function that is not the builder", () => {
    // The over-matching direction. `build(…)` is an ordinary name; it is the builder
    // only where an import binds it to one, and a file that defines its own must not
    // become a finding.
    const root = makeTmpDir("food-rebuild-quiet");
    fsMod.mkdirSync(path.join(root, "lib/notifications"), { recursive: true });
    fsMod.writeFileSync(
      path.join(root, "lib/notifications/other.ts"),
      ["function build(p: number) { return p; }", "const a = build(1);"].join(
        "\n"
      )
    );
    expect(unwrappedFoodRebuilds(root)).toEqual([]);
  });

  it("names the REAL line, behind a multi-line block comment", () => {
    // #3580 item 3, closed by the shared scanner (#3581) and pinned here so it stays
    // closed. The old stripper DELETED comments, so this call — at real line 13 —
    // was reported as `lib/x.ts:4`. Blanking in place keeps every newline, so the
    // offset the match lands on is the offset in the real file.
    const root = makeTmpDir("food-rebuild-lines");
    fsMod.mkdirSync(path.join(root, "lib/notifications"), { recursive: true });
    const body = [
      "/**",
      " * A ten-line block comment, which is what this tree writes above a rebuild.",
      " * It exists to explain the marker rule, and it says `buildFoodNudge` twice",
      " * on purpose — a census that counted a sentence as a call would fire here.",
      " *",
      " * The old stripper deleted these lines outright, so every line number after",
      " * this comment was reported short by exactly the number of lines it spans.",
      " * That sends the next reader to the wrong place, and after once they stop",
      " * trusting the guard.",
      " */",
      "const origin = keyboardChatOrigin(rows);",
      "",
      "const rebuilt = buildFoodNudge(p, w, d);",
    ].join("\n");
    fsMod.writeFileSync(path.join(root, "lib/notifications/spaced.ts"), body);
    expect(unwrappedFoodRebuilds(root)).toEqual([
      "lib/notifications/spaced.ts:13",
    ]);
  });
});

// ── THE MARKER CHARSET CENSUS (#3567 item 3) ──────────────────────────────────
//
// `ORIGIN_MARK_PATTERN` is exported so that the marker segment is written ONCE. It was
// exported and then hand-spelled anyway, at six code sites across three modules, and
// every one of them was correct only by coincidence.
//
// WHY THIS PARTICULAR DUPLICATE IS WORTH A GUARD, when most are not: widening the
// charset would have missed the hand-copies SILENTLY. A food token whose marker no
// longer matches does not throw and does not mis-parse — it reads as an UNMARKED
// legacy token, which is a valid state that logs a nudge. So the failure mode of
// forgetting one copy is a permanent, one-directional inflation of exactly the number
// this column exists to measure, on a path nothing renders.
//
// WHAT IT KEYS ON is the repo's own spelling, not the issue's description: every one
// of the six copies wrote the charset as a regex CHARACTER CLASS over the mark
// letters. The alternation form is included too — it is the same thought, and a
// census that saw one spelling and not the other would report clean because it cannot
// see (#3580). Both are DERIVED from the exported pattern, so widening the charset
// widens this guard in the same edit.
//
// WHAT IT CANNOT SEE, stated rather than implied: a copy built at runtime from a
// variable, a `String.fromCharCode`, or a class written with a range or an escape
// (`[n-c]`, `[\x6e\x63]`). Nobody has written one; nothing stops them.

/** The character class inside the exported pattern — `nc`, derived, never restated. */
const MARK_CHARS = /\[([^\]]+)\]/.exec(ORIGIN_MARK_PATTERN)?.[1] ?? "";

/** The module that is ALLOWED to spell it: the one that exports it. */
const MARKER_MODULE = "lib/notifications/chat-origin.ts";

/** Every hand-spelling of the marker charset, in the two shapes this repo writes. */
function markerCharsetSpellings(chars: string): string[] {
  const letters = [...chars];
  const orders =
    letters.length === 2
      ? [letters.join(""), [...letters].reverse().join("")]
      : [letters.join("")];
  return [
    ...orders.map((o) => `[${o}]`),
    ...orders.map((o) => `(?:${[...o].join("|")})`),
    ...orders.map((o) => `(${[...o].join("|")})`),
  ];
}

/** Files that respell the marker charset instead of importing the pattern. */
export function respelledMarkerCharsets(root: string): string[] {
  const spellings = markerCharsetSpellings(MARK_CHARS);
  const out: string[] = [];
  for (const file of sources(root)) {
    if (file.rel === MARKER_MODULE) continue;
    if (!spellings.some((spelling) => file.raw.includes(spelling))) continue;
    const src = sourceCode(file);
    for (const spelling of spellings)
      if (src.includes(spelling)) out.push(`${file.rel}: ${spelling}`);
  }
  return [...new Set(out)].sort();
}

describe("the marker charset is written once", () => {
  it("leaves no module respelling the charset chat-origin.ts exports", () => {
    expect(MARK_CHARS.length).toBeGreaterThanOrEqual(2);
    expect(sources(REPO).map((f) => f.rel)).toContain(MARKER_MODULE);
    expect(
      respelledMarkerCharsets(REPO),
      "The origin marker's charset is hand-spelled outside chat-origin.ts (#3567). " +
        "Import ORIGIN_MARK_PATTERN instead: a copy that misses a later widening " +
        "does not throw — the token reads as an UNMARKED legacy token, which is a " +
        "valid state that logs a nudge, so the miscount is silent and permanent."
    ).toEqual([]);
  });

  it("SEES a hand-spelled charset, and STAYS SILENT on the imported one", () => {
    // A green sweep over a complying tree says nothing about what the sweep can see.
    const root = makeTmpDir("marker-charset");
    fsMod.mkdirSync(path.join(root, "lib/notifications"), { recursive: true });
    fsMod.writeFileSync(
      path.join(root, "lib/notifications/handspelled.ts"),
      [
        "const RE = /^food:(?:[nc]:)?\\d+:/;",
        "export const ok = RE.test(x);",
      ].join("\n")
    );
    fsMod.writeFileSync(
      path.join(root, "lib/notifications/alternation.ts"),
      "const RE = new RegExp(`^food:(?:(n|c):)?\\\\d+:`);\n"
    );
    fsMod.writeFileSync(
      path.join(root, "lib/notifications/imported.ts"),
      [
        'import { ORIGIN_MARK_PATTERN } from "./chat-origin";',
        "const RE = new RegExp(`^food:${ORIGIN_MARK_PATTERN}\\\\d+:`);",
      ].join("\n")
    );
    // …and a COMMENT that quotes the charset in order to explain it, which three
    // shipped files do. Reading comments would report the documentation as the defect.
    fsMod.writeFileSync(
      path.join(root, "lib/notifications/explained.ts"),
      [
        "// `[nc]` is the marker charset; do not respell it — import the pattern.",
        'import { ORIGIN_MARK_PATTERN } from "./chat-origin";',
        "export const P = ORIGIN_MARK_PATTERN;",
      ].join("\n")
    );
    expect(respelledMarkerCharsets(root)).toEqual([
      "lib/notifications/alternation.ts: (n|c)",
      "lib/notifications/handspelled.ts: [nc]",
    ]);
  });
});
