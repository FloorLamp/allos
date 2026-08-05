// THE SHARED-CADENCE COMPLETENESS GUARD (issue #2089).
//
// #2036 gave the app one nudge-cadence decision and four adapters over it. What it did
// not give was a BOUNDARY: nothing said which families must ride the engine, so a family
// outside it carried private cadence code that nobody could distinguish from an
// oversight. #2033 is the bill for that — the workout nudge decided privately and got it
// wrong.
//
// So this test does for `planNudgeCadence` what lib/__tests__/reconcile-registry.test.ts
// does for the button and prose registries: it makes membership TOTAL. Every registered
// notification kind either declares the engine as its cadence owner (naming the adapter)
// or declares the mechanism that owns it instead, with a written reason — and a kind
// that never answered fails the build.
//
// The second half is the REFLECTION tooth, in the house style (read the source as text,
// no DB, no network): the set of modules that actually call `planNudgeCadence` must be
// exactly the set the registry declares. A new family adopting the engine cannot ship
// without joining the declaration, and a declaration cannot claim an adapter that does
// not exist.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  KIND_CADENCE,
  SHARED_CADENCE_KINDS,
  cadenceEntryFor,
  ridesNudgeCadence,
} from "@/lib/notifications/cadence-registry";
import {
  ALL_NOTIFICATION_KINDS,
  isSafetyKind,
} from "@/lib/notifications/kinds";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const LIB = path.join(REPO, "lib");
const NOTIFY_DIR = path.join(LIB, "notifications");

/** Every production .ts under lib/, repo-relative, excluding the three test tiers. */
function libSources(): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith("__")) continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      if (entry.name.endsWith(".test.ts")) continue;
      out.push({
        rel: path.relative(REPO, full),
        text: fs.readFileSync(full, "utf8"),
      });
    }
  };
  walk(LIB);
  return out;
}

// Strip comments so the module headers — which name `planNudgeCadence` in prose all
// over this domain — are not read as call sites.
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** The modules that really adapt the shared engine: they import it and they call it. */
function plannerModules(): string[] {
  return libSources()
    .filter(({ text }) => {
      const code = stripComments(text);
      return (
        /import[\s\S]*?planNudgeCadence[\s\S]*?from\s+"\.\/nudge-cadence"/.test(
          code
        ) && /planNudgeCadence[<(]/.test(code)
      );
    })
    .map(({ rel }) => rel)
    .sort();
}

const DECLARED_PLANNERS = [
  ...new Set(
    KIND_CADENCE.flatMap((e) =>
      e.cadence === "nudge-cadence" ? [e.planner] : []
    )
  ),
].sort();

describe("the shared-cadence membership declaration (#2089)", () => {
  it("every notification kind declares what owns its cadence", () => {
    const declared = new Set(KIND_CADENCE.map((e) => e.kind as string));
    const undeclared = ALL_NOTIFICATION_KINDS.filter((k) => !declared.has(k));
    expect(
      undeclared,
      `kinds with no cadence declaration: ${undeclared.join(", ")} — add a ` +
        `KIND_CADENCE entry saying whether this family's cadence rides ` +
        `planNudgeCadence (naming its adapter) or which mechanism owns it instead, ` +
        `and why`
    ).toEqual([]);
  });

  it("no STALE declaration — every declared kind is still a real kind", () => {
    const known = new Set<string>(ALL_NOTIFICATION_KINDS);
    const stale = KIND_CADENCE.filter((e) => !known.has(e.kind)).map(
      (e) => e.kind
    );
    expect(stale, `retired kinds still declared: ${stale.join(", ")}`).toEqual(
      []
    );
  });

  it("no duplicate kinds", () => {
    const seen = new Set<string>();
    for (const e of KIND_CADENCE) {
      expect(seen.has(e.kind), `duplicate declaration for "${e.kind}"`).toBe(
        false
      );
      seen.add(e.kind);
    }
  });

  it("both answers carry a real reason — including every exemption", () => {
    for (const e of KIND_CADENCE) {
      expect(e.why.length, `${e.kind} needs a real reason`).toBeGreaterThan(40);
    }
  });

  it("an exemption NAMES the mechanism that owns the decision", () => {
    // The vocabulary is the check: an exemption cannot be spelled as a bare "no", it
    // has to pick the owner a reader can go and read.
    const OWNERS = new Set([
      "user-schedule",
      "item-clock",
      "per-subject-event",
      "on-demand",
      "not-dispatched",
    ]);
    for (const e of KIND_CADENCE) {
      if (e.cadence === "nudge-cadence") continue;
      expect(OWNERS.has(e.cadence), `${e.kind}: ${e.cadence}`).toBe(true);
    }
  });

  it("the lookup fails safe for an unknown kind", () => {
    // A kind that slipped past this scan keeps whatever decides it today rather than
    // being claimed by an engine nobody reasoned about.
    expect(ridesNudgeCadence("not-a-kind")).toBe(false);
    expect(ridesNudgeCadence(null)).toBe(false);
    expect(ridesNudgeCadence(undefined)).toBe(false);
    expect(cadenceEntryFor("not-a-kind")).toBeNull();
  });
});

describe("the reflection tooth: the declaration matches the real import graph", () => {
  it("every declared adapter exists and actually calls planNudgeCadence", () => {
    for (const rel of DECLARED_PLANNERS) {
      expect(
        fs.existsSync(path.join(REPO, rel)),
        `${rel} is declared as a cadence adapter but does not exist`
      ).toBe(true);
    }
    expect(DECLARED_PLANNERS).toEqual(plannerModules());
  });

  it("a module that adopts the engine cannot ship unregistered", () => {
    // The failing direction, stated as the message a future author will read: the
    // equality above is what turns "someone wired planNudgeCadence into a fifth
    // domain" into a red test instead of a silent second boundary.
    const undeclared = plannerModules().filter(
      (rel) => !DECLARED_PLANNERS.includes(rel)
    );
    expect(
      undeclared,
      `these modules call planNudgeCadence but no KIND_CADENCE entry names them: ` +
        `${undeclared.join(", ")} — declare the kind they send as "nudge-cadence" ` +
        `with this module as its planner`
    ).toEqual([]);
  });

  it("each adapter is wired into a real dispatcher", () => {
    // A planner nothing sends through would be a declaration about dead code.
    const dispatchers = fs
      .readdirSync(NOTIFY_DIR)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) =>
        stripComments(fs.readFileSync(path.join(NOTIFY_DIR, f), "utf8"))
      );
    for (const rel of DECLARED_PLANNERS) {
      const spec = `"../${path.basename(rel, ".ts")}"`;
      expect(
        dispatchers.some((text) => text.includes(spec)),
        `no lib/notifications module imports ${rel}`
      ).toBe(true);
    }
  });

  it("the four #2036 families are the members, and they are care/coaching tier", () => {
    expect([...SHARED_CADENCE_KINDS].sort()).toEqual([
      "followup",
      "illness-care",
      "preventive",
      "refill",
    ]);
  });
});

describe("safety standing is untouched", () => {
  it("no SAFETY kind rides the shared engine", () => {
    // The planner's freeze rule is a suppression-bus lookup. A safety signal that an
    // Upcoming dismissal could silence is the one policy AGENTS.md forbids moving, so
    // membership for a safety kind would be a policy change wearing a refactor's hat.
    const offenders = ALL_NOTIFICATION_KINDS.filter(
      (k) => isSafetyKind(k) && ridesNudgeCadence(k)
    );
    expect(offenders, `safety kinds declared as members: ${offenders}`).toEqual(
      []
    );
  });

  it("the safety kinds name their own timing contract", () => {
    for (const kind of ["dose", "escalation", "redose"] as const) {
      const entry = cadenceEntryFor(kind);
      expect(entry?.cadence, kind).toMatch(/user-schedule|item-clock/);
    }
  });
});
