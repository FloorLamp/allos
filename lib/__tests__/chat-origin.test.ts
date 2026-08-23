import fsMod from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stripComments } from "./strip-comments";
import {
  keyboardChatOrigin,
  markToken,
  originFromToken,
  withChatOrigin,
} from "@/lib/notifications/chat-origin";
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

  it("stays under Telegram's 64-byte callback cap on a long real token", () => {
    // A food token runs to about 45 bytes; the marker costs two.
    const longest = markToken(
      "food:107080001001:Evening:2026-08-22:sugary_foods_desserts",
      "telegram-command"
    );
    expect(Buffer.byteLength(longest, "utf8")).toBeLessThanOrEqual(64);
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

function sources(root: string): { rel: string; src: string }[] {
  const out: { rel: string; src: string }[] = [];
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
      out.push({ rel, src: code(fsMod.readFileSync(p, "utf8")) });
    }
  };
  for (const sub of ["lib", "app", "components"]) rec(path.join(root, sub));
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** Every `buildFoodNudge(` call that is NOT wrapped, as `file:line`. */
export function unwrappedFoodRebuilds(root: string): string[] {
  const out: string[] = [];
  for (const { rel, src } of sources(root)) {
    if (rel === BUILDER_MODULE) continue;
    for (const m of src.matchAll(/buildFoodNudge\s*\(/g)) {
      const at = m.index ?? 0;
      // The wrap, allowing the formatter's line break between the two calls.
      const before = src.slice(Math.max(0, at - 60), at);
      if (/withChatOrigin\s*\(\s*$/.test(before)) continue;
      out.push(`${rel}:${src.slice(0, at).split("\n").length}`);
    }
  }
  return out;
}

describe("every rebuild of a food nudge re-applies the origin", () => {
  it("has a corpus to make a claim about", () => {
    // AN ABSENCE ASSERTION FAILS OPEN. The floor is the four rebuild sites plus the
    // two mint sites plus the hourly sweep, measured on 2026-08-23 and set below the
    // real figure so ordinary churn does not trip it and a collapsed scan does.
    const calls = sources(REPO)
      .filter((f) => f.rel !== BUILDER_MODULE)
      .flatMap((f) => [...f.src.matchAll(/buildFoodNudge\s*\(/g)]);
    expect(calls.length).toBeGreaterThanOrEqual(6);
  });

  it("leaves no call site rebuilding a nudge without re-applying the marker", () => {
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
});
