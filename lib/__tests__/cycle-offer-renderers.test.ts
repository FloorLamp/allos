import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { REPO } from "./sql-scan";
import { STATEFUL_WRITE_TABLES } from "@/lib/stateful-writes";
import {
  cycleControlState,
  cycleOffer,
  END_PERIOD_LABEL,
  REOPEN_PERIOD_LABEL,
  START_PERIOD_LABEL,
} from "@/lib/cycle-plausibility";
import type { CyclePeriod } from "@/lib/cycle";

// THE #221 PIN for the cycle offer (issue #1892).
//
// Three surfaces put a one-tap period button in front of the user — the Cycle page
// control, the dashboard phase widget, and the quick-log sheet's overlay. The whole
// point of the fix is that they are RENDERERS of one state, not three implementations
// of one idea, so they can never disagree about which verb is on offer. Nothing about
// that is enforced by types: each surface could perfectly well grow its own
// `periods.some(p => p.period_end == null)`. This test is what stops it.
//
// It asserts two things, in the two ways they can be asserted:
//
//   1. STRUCTURALLY — the offer derivation has exactly one caller (the shared button),
//      each surface reaches that button rather than the predicates, and no surface
//      imports the plausibility predicates or the phase/day derivations to re-answer
//      the question locally.
//   2. BEHAVIOURALLY — the three surfaces are handed one state object and every state
//      of the machine yields one verb, which is what the e2e spec then asserts in the
//      browser.
//
// Its companion is `lib/stateful-writes.ts`, whose `cycles` entry names
// `cycleControlState` as the offer state an affordance over that table should render;
// this test is that claim, checked.

// The shared control every surface renders.
const OFFER_BUTTON = "components/cycle/PeriodOfferButton.tsx";

// The three surfaces, and what each is.
const RENDERERS = [
  {
    file: "app/(app)/medical/cycles/PeriodQuickActions.tsx",
    what: "the Cycle page's quick-action control (#1681)",
  },
  {
    file: "components/dashboard/CyclePhaseWidget.tsx",
    what: "the dashboard phase widget (#1892 — the card that used to self-hide)",
  },
  {
    file: "components/quick-entry/QuickCyclePanel.tsx",
    what: "the quick-log sheet's period overlay (#1892/#1506)",
  },
] as const;

// The predicates and derivations a surface must NOT reach for. Each is a second
// opinion waiting to happen: `canStartPeriodOn` re-answers the offer, `openPeriodIn`
// re-answers "is one open", `cycleDayOnDate`/`cyclePhaseOnDate` re-answer the state
// line the control state already carries.
const FORBIDDEN_IN_RENDERERS = [
  "canStartPeriodOn",
  "canReopenLastPeriodOn",
  "openPeriodIn",
  "lastEndedPeriodIn",
  "isStaleOpenPeriod",
  "cycleDayOnDate",
  "cyclePhaseOnDate",
  "cycleStateLine",
  "listCyclePeriods",
];

// Comments are PROSE about the code, and this file's whole subject is code that
// explains itself at length — a header saying "it used to re-derive with
// cycleDayOnDate" must not read as a re-derivation. Strip block and line comments (and
// string-quoted labels stay, which is what the label check wants).
function code(rel: string): string {
  return fs
    .readFileSync(path.join(REPO, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "");
}

function walk(dir: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next") continue;
      walk(p, out);
    } else if (
      e.isFile() &&
      (e.name.endsWith(".ts") || e.name.endsWith(".tsx"))
    ) {
      out.push(p);
    }
  }
}

// Every rendering source in the app: lib + app + components, minus the test tiers
// (which legitimately call the derivation to assert it).
function renderingSources(): string[] {
  const all: string[] = [];
  for (const dir of ["lib", "app", "components"])
    walk(path.join(REPO, dir), all);
  return all
    .map((f) => path.relative(REPO, f).split(path.sep).join("/"))
    .filter(
      (rel) => !rel.includes("__tests__") && !rel.includes("__db_tests__")
    )
    .filter(
      (rel) => !rel.includes("__action_tests__") && !rel.endsWith(".test.ts")
    );
}

function period(id: number, start: string, end: string | null): CyclePeriod {
  return { id, period_start: start, period_end: end, flow: null, note: null };
}

describe("the cycle offer has ONE derivation and three renderers (#1892 / #221)", () => {
  it("every surface renders the shared button and none re-derives the offer", () => {
    for (const { file, what } of RENDERERS) {
      const src = code(file);
      expect(src, `${what} must render the shared offer button`).toContain(
        "PeriodOfferButton"
      );
      // It takes the state as DATA — it does not fetch or compute it.
      expect(src, `${what} must take CycleControlState as data`).toContain(
        "CycleControlState"
      );
      for (const banned of FORBIDDEN_IN_RENDERERS) {
        expect(src, `${what} re-derives via ${banned}`).not.toContain(banned);
      }
      // And it never calls the derivation itself — that is the shared button's job.
      expect(src, `${what} calls cycleOffer directly`).not.toContain(
        "cycleOffer("
      );
    }
  });

  it("cycleOffer has exactly one caller in the app: the shared button", () => {
    const callers = renderingSources().filter(
      (rel) =>
        rel !== "lib/cycle-plausibility.ts" && /cycleOffer\(/.test(code(rel))
    );
    expect(callers).toEqual([OFFER_BUTTON]);
  });

  it("cycleControlState is resolved on the SERVER, once per surface, and nowhere else", () => {
    // Each renderer is handed the state; the three places that RESOLVE it are the
    // three server entry points. A fourth caller would mean a surface deciding for
    // itself when to compute the offer — the seam this pin exists to keep shut.
    const callers = renderingSources().filter(
      (rel) =>
        rel !== "lib/cycle-plausibility.ts" &&
        /cycleControlState\(/.test(code(rel))
    );
    expect(callers.sort()).toEqual(
      [
        // The dashboard page (the widget, in both its derived and CTA states).
        "app/(app)/page.tsx",
        // The Cycle page.
        "app/(app)/medical/cycles/page.tsx",
        // The quick-entry gather, ON OPEN (never a layout-time snapshot).
        "app/(app)/quick-entry-actions.ts",
      ].sort()
    );
  });

  it("the verb comes from the exported labels — no surface spells it itself", () => {
    const labels = [START_PERIOD_LABEL, END_PERIOD_LABEL, REOPEN_PERIOD_LABEL];
    for (const { file, what } of RENDERERS) {
      const src = code(file);
      for (const label of labels) {
        expect(src, `${what} hard-codes the label "${label}"`).not.toContain(
          `"${label}"`
        );
      }
    }
    const button = code(OFFER_BUTTON);
    for (const label of labels) {
      expect(button, "the shared button hard-codes a label").not.toContain(
        `"${label}"`
      );
    }
  });

  it("the widget and the sheet show the SAME verb in every state", () => {
    // The behavioural half of the pin: every surface is handed the same
    // CycleControlState and runs it through cycleOffer, so this asserts what the e2e
    // spec asserts in the browser — one state, one verb — over every state the machine
    // has, including the one where the honest answer is "no button".
    const cases: [string, CyclePeriod[], string | null][] = [
      ["no history", [], START_PERIOD_LABEL],
      ["open period", [period(1, "2026-04-18", null)], END_PERIOD_LABEL],
      [
        "just ended",
        [period(1, "2026-04-16", "2026-04-20")],
        REOPEN_PERIOD_LABEL,
      ],
      [
        "inside the plausible gap",
        [period(1, "2026-04-11", "2026-04-15")],
        null,
      ],
      [
        "past the gap",
        [period(1, "2026-04-01", "2026-04-05")],
        START_PERIOD_LABEL,
      ],
    ];
    for (const [name, periods, expected] of cases) {
      // ONE server-resolved state; each surface is handed this exact object.
      const state = cycleControlState(periods, "2026-04-20");
      expect(cycleOffer(state)?.label ?? null, name).toBe(expected);
    }
  });

  it("the stateful-write registry still names cycleControlState as the offer state", () => {
    // The registry (#1893) is where a reviewer looks for the derivation an affordance
    // over `cycles` should render. If that name drifts, this pin points at the wrong
    // thing.
    const entry = STATEFUL_WRITE_TABLES.find((t) => t.table === "cycles");
    expect(entry?.offerState).toBe("cycleControlState");
  });
});
