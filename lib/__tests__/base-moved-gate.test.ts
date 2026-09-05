import { describe, expect, it } from "vitest";
import {
  RECEIPT_MARKER,
  baseMovedVerdict,
  typeBearing,
} from "../../scripts/orchestration/merge-gate-core.mjs";

// THE BASE-MOVED GATE (#5235). type-verdict.test.ts pins that a tree can be
// clean on its own base and invalid merged; this pins what the merge gate DOES
// about it. The two are the same incident from either end — #5129 made `kind`
// required, #5138's CI was green against a base that predated it, both merged
// clean, and `main` was red on three jobs for two merges.
//
// Every case below is one way that merge could have read as safe.

const HEAD = "abcdef1234567890abcdef1234567890abcdef12";
const OLD_HEAD = "0123456789abcdef0123456789abcdef01234567";
const CI_BASE = "1111111111111111111111111111111111111111";
const TIP = "2222222222222222222222222222222222222222";

const mark = (rest: string, who = "orchestrator") => ({
  line: `${RECEIPT_MARKER}: ${rest}`,
  rest,
  who,
  at: "2026-09-05T09:00:00Z",
});

/** #5138's own shape: behind by one merge that made a type stricter. */
const moved = (over: Partial<Parameters<typeof baseMovedVerdict>[0]> = {}) =>
  baseMovedVerdict({
    head: HEAD,
    baseRef: "main",
    baseTip: TIP,
    ciBase: CI_BASE,
    landed: [{ sha: TIP, subject: "Give a timezone switch a kind" }],
    landedFiles: ["lib/travel.ts", "app/settings/page.tsx"],
    truncated: false,
    marks: [],
    unread: "",
    ...over,
  });

// A PATH IS THE WHOLE TRIGGER, so what it does and does not reach is the claim.
// The right-hand column is not "does this file matter" — it is "could a merge
// touching this file move a type the compiler would then reject".
describe("what a path can say about a type", () => {
  it.each<[string, boolean]>([
    ["lib/travel.ts", true],
    ["lib/release-notes.json", true],
    ["lib/migrations/versions/index.ts", true],
    ["app/settings/page.tsx", true],
    ["components/TimezoneSwitch.tsx", true],
    ["e2e/travel.spec.ts", true],
    ["scripts/seed.ts", true],
    ["package.json", true],
    ["package-lock.json", true],
    ["tsconfig.json", true],
    // The other side, and it is what makes the gate narrower than "any merge".
    ["docs/internals/e2e-hygiene.md", false],
    ["README.md", false],
    [".github/workflows/ci.yml", false],
    ["scripts/orchestration/merge-gate.mjs", false],
    ["public/icon.png", false],
    ["e2e/spec-durations.json", false],
  ])("%s can move a type: %s", (path, expected) => {
    expect(typeBearing([path])).toEqual(expected ? [path] : []);
  });
});

describe("a head whose base has moved", () => {
  it("refuses #5138's own shape, and says what it did not check", () => {
    const verdict = moved();
    expect(verdict.ok).toBe(false);
    expect(verdict.kind).toBe("missing");
    expect(verdict.message).toContain("1 merge(s) behind main");
    expect(verdict.message).toContain("lib/travel.ts");
    expect(verdict.message).toContain("#5129/#5138");
    // BOTH stated limits, which are what a reader needs in order to know what a
    // PASS from this gate is worth: it reads paths, never files, and it never
    // decides whether the tiers a receipt names were the right ones.
    expect(verdict.message).toContain("The trigger is PATHS");
    expect(verdict.message).toContain("checks that they were named");
  });

  it.each<[string, string, Partial<Parameters<typeof baseMovedVerdict>[0]>]>([
    // NOTHING LANDED. The ordinary case, and the one that must stay cheap.
    [
      "nothing landed since the CI base",
      "current",
      { landed: [], landedFiles: [] },
    ],
    // A MERGE THAT CANNOT CARRY A TYPE. The exemption the ruling asks for.
    [
      "a docs-only merge landed",
      "inert",
      { landedFiles: ["docs/internals/verification-failure-modes.md"] },
    ],
    // THE RECEIPT, AND EVERY WAY IT FALLS SHORT OF ONE.
    [
      "a receipt on this head, this tip, naming both commands",
      "receipted",
      {
        marks: [
          mark(
            `${HEAD.slice(0, 8)} onto ${TIP.slice(0, 8)} — npm run typecheck; npm run test:db`
          ),
        ],
      },
    ],
    [
      "a receipt naming a head that no longer exists",
      "stale-head",
      {
        marks: [
          mark(
            `${OLD_HEAD.slice(0, 8)} onto ${TIP.slice(0, 8)} — npm run typecheck; npm test`
          ),
        ],
      },
    ],
    [
      "a receipt against a main this one has moved past",
      "stale-base",
      {
        marks: [
          mark(
            `${HEAD.slice(0, 8)} onto ${CI_BASE.slice(0, 8)} — npm run typecheck; npm test`
          ),
        ],
      },
    ],
    [
      "a receipt that claims the check but names no command",
      "unnamed-commands",
      {
        marks: [
          mark(
            `${HEAD.slice(0, 8)} onto ${TIP.slice(0, 8)} — I merged main and it was clean`
          ),
        ],
      },
    ],
    [
      "a receipt naming tests but no typecheck, which is the only type verdict",
      "unnamed-commands",
      {
        marks: [
          mark(`${HEAD.slice(0, 8)} onto ${TIP.slice(0, 8)} — npm run test:db`),
        ],
      },
    ],
    // CANNOT TELL IS A REFUSAL. A base-moved check that fails open licenses the
    // merge it exists to question, so each unreadable input closes the gate.
    [
      "a comparison that did not fit one page",
      "unreadable",
      { truncated: true },
    ],
    ["a comparison that went dark", "unreadable", { ciBase: null }],
    ["a base branch with no tip", "unreadable", { baseTip: null }],
  ])("%s reads as %s", (_case, kind, over) => {
    const verdict = moved(over);
    expect(verdict.kind).toBe(kind);
    expect(verdict.ok).toBe(["current", "inert", "receipted"].includes(kind));
  });

  // A QUOTED RECEIPT IS NOT ONE, and the gate says it saw the line rather than
  // going quiet about it — the trade #5183 refused to make for the other
  // markers. The caller strips quoted marks; this pins that its note survives
  // into the refusal a human reads.
  it("carries the unread-marker note into its verdict", () => {
    const verdict = moved({
      unread: ` NOTE: 1 ${RECEIPT_MARKER} line(s) here QUOTE and were NOT read (#5183).`,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain("QUOTE and were NOT read");
  });
});
