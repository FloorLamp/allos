// THE #221 PIN for the protocol lifecycle offer (issue #2135), on the shape
// `cycle-offer-renderers.test.ts` set for its structural twin.
//
// `protocols.end_date` is a three-state machine — ongoing (NULL) / resumable (ended
// inside the reopen window) / expired (ended before it) — and the states are named
// once, in the pure `protocolReopenEligibility`. Two things then depend on that one
// answer and must never disagree: the CONTROL, which decides whether the menu offers
// "Resume" or "Run again", and the WRITE CORE, which refuses a tap the control should
// never have offered. #2135's finding was that nothing stopped a second surface
// growing its own `end_date == null && daysSince(...) <= 7`.
//
// So this asserts, in the two ways it can be asserted:
//
//   1. STRUCTURALLY — the derivation has exactly one renderer and exactly one write
//      core, and the registry still names it as the offer state for the table.
//   2. BEHAVIOURALLY — every state of the machine yields one verb, including the two
//      states whose honest answer is "no resume".
//
// The write half's refusals are proven against a real database in
// lib/__action_tests__/protocol-lifecycle.actions.test.ts; this file is about the
// seam, and stays pure.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { REPO } from "./sql-scan";
import { STATEFUL_WRITE_TABLES } from "@/lib/stateful-writes";
import {
  PROTOCOL_REOPEN_WINDOW_DAYS,
  protocolReopenEligibility,
} from "@/lib/protocol-reopen";

// The surface that renders the offer, and the core that enforces it.
const CONTROL = "app/(app)/protocols/ProtocolControls.tsx";
const CORE = "lib/protocol-lifecycle.ts";

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

describe("the protocol reopen offer has ONE derivation (#2135 / #221)", () => {
  it("is called by exactly the control, the write core, and the run-again action", () => {
    // Three callers, each a different job over ONE answer: the control renders the
    // verb, the core refuses a tap that contradicts it, and runProtocolAgain is the
    // expired branch's write. A fourth would be a second opinion.
    const callers = renderingSources().filter(
      (rel) =>
        rel !== "lib/protocol-reopen.ts" &&
        /protocolReopenEligibility\(/.test(code(rel))
    );
    expect(callers.sort()).toEqual(
      [CONTROL, CORE, "app/(app)/protocols/actions.ts"].sort()
    );
  });

  it("no surface re-derives the window from the raw end date", () => {
    // The two ingredients a second implementation would reach for. The control may
    // read `end_date` for the date RANGE it prints; it may not measure elapsed days.
    for (const rel of renderingSources()) {
      if (rel === "lib/protocol-reopen.ts") continue;
      const src = code(rel);
      expect(
        src.includes("PROTOCOL_REOPEN_WINDOW_DAYS"),
        `${rel} re-derives the reopen window`
      ).toBe(false);
    }
  });

  it("the write core, not the Server Action, decides whether a resume lands", () => {
    // The #2135 defect in one assertion: the action must not read the row and judge
    // it before calling the core, because that read is outside the transaction.
    const action = code("app/(app)/protocols/actions.ts");
    expect(action).toContain("resumeProtocolCore(");
    expect(action).toContain("endProtocolCore(");
    // The two raw transitions it used to hold are gone.
    expect(action).not.toContain("SET end_date = NULL");
    expect(action).not.toContain("UPDATE protocols SET end_date = ?");
  });

  it("the stateful-write registry names protocolReopenEligibility as the offer state", () => {
    const entry = STATEFUL_WRITE_TABLES.find((t) => t.table === "protocols");
    expect(entry?.offerState).toBe("protocolReopenEligibility");
    expect(entry?.cores).toContain(CORE);
  });

  it("every state of the machine yields one verb", () => {
    // The behavioural half. `asOf` is fixed; each case is the end date that puts the
    // row in that state, so the boundary days are pinned rather than sampled.
    const asOf = "2026-04-20";
    const cases: [string, string | null, string][] = [
      ["never ended", null, "ongoing"],
      ["ended today", "2026-04-20", "eligible"],
      ["ended on the last day of the window", "2026-04-13", "eligible"],
      ["ended one day past the window", "2026-04-12", "expired"],
      ["ended long ago", "2025-11-01", "expired"],
      ["an end date in the future", "2026-04-21", "invalid"],
      ["a nonsense end date", "not-a-day", "invalid"],
    ];
    for (const [name, endedAt, expected] of cases) {
      expect(protocolReopenEligibility(endedAt, asOf).kind, name).toBe(
        expected
      );
    }
    // And the window the boundary cases were written against is the declared one.
    expect(PROTOCOL_REOPEN_WINDOW_DAYS).toBe(7);
  });
});
