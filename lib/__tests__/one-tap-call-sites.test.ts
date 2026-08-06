// PURE TIER — the one-tap registry's SOURCE-SCAN half (#2130).
//
// The #2130 split, per the owner's mechanism direction: membership between two
// const-asserted registries is a type-level `satisfies` (the offline coverage
// record, the quick-log / palette / Telegram domain censuses), but membership
// between CODE and a registry is a call-site fact types cannot see — a component
// can hand-roll a tap without ever touching the shared helpers. So this scan
// pins the two directions the types leave open:
//
//   1. Every `useOptimisticLedger("<id>")` call site names a registry key as a
//      LITERAL. The parameter type already forces membership for literals; the
//      scan additionally refuses a non-literal first argument (a variable or a
//      cast), because an id the scan cannot read is an id nobody can census.
//   2. Every registry entry is WIRED — some component actually runs the shared
//      machinery under that id. This is the #2130 tooth that caught the audit's
//      two one-tap gaps: `mood-valence` (HowAreYouCard hand-rolled its tap) and
//      `period-lifecycle` (PeriodOfferButton, "THE one-tap period affordance",
//      ran a bare transition with no #2007 double-tap absorption).
//
// PROVEN ON THE DEFECT: on the pre-wiring tree — the two #2130 registry rows
// added, HowAreYouCard/PeriodOfferButton not yet converted — direction 2 failed
// with exactly:
//   mood-valence: declared in ONE_TAP_AFFORDANCES but no component calls
//     useOptimisticLedger("mood-valence")
//   period-lifecycle: declared in ONE_TAP_AFFORDANCES but no component calls
//     useOptimisticLedger("period-lifecycle")
// (`npx vitest run lib/__tests__/one-tap-call-sites.test.ts` on that tree.)

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ONE_TAP_AFFORDANCES } from "@/lib/one-tap";
import { REPO, relPath } from "./sql-scan";

// The tap surfaces live in components/ and app/ — a wider net than sql-scan's
// server-side sourceFiles(), because one-tap affordances are client components.
function tapSurfaceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".next") continue;
        walk(p);
      } else if (e.isFile()) {
        out.push(p);
      }
    }
  };
  walk(path.join(REPO, "components"));
  walk(path.join(REPO, "app"));
  return out.filter((f) => {
    const rel = relPath(f);
    if (!f.endsWith(".ts") && !f.endsWith(".tsx")) return false;
    if (rel.includes("__tests__") || f.endsWith(".test.ts")) return false;
    // The hook's own definition is not a call site.
    return rel !== "components/useOptimisticLedger.ts";
  });
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

interface CallSite {
  file: string;
  id: string | null; // null: first argument is not a string literal
}

// Every `useOptimisticLedger(...)` CALL in `src` (imports and prose don't
// match: the name must be followed — after an optional generic argument — by an
// opening paren). Exported shape kept simple so the fixture test below can prove
// the scan can fail (#1893).
export function ledgerCallSites(src: string, file: string): CallSite[] {
  const sites: CallSite[] = [];
  const code = stripComments(src);
  const re = /useOptimisticLedger\s*(<[^(]*)?\(\s*(["']([^"']+)["'])?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    sites.push({ file, id: m[3] ?? null });
  }
  return sites;
}

describe("every one-tap surface runs the shared machinery under a declared id (#2130)", () => {
  const keys = Object.keys(ONE_TAP_AFFORDANCES);
  const sites: CallSite[] = [];
  for (const f of tapSurfaceFiles()) {
    sites.push(...ledgerCallSites(fs.readFileSync(f, "utf8"), relPath(f)));
  }

  it("no call site hides its affordance id from the census", () => {
    const hidden = sites.filter((s) => s.id === null).map((s) => s.file);
    expect(hidden, `\n${hidden.join("\n")}\n`).toEqual([]);
  });

  it("every call site names a registered affordance", () => {
    const unknown = sites
      .filter((s) => s.id !== null && !keys.includes(s.id))
      .map((s) => `${s.file}: "${s.id}"`);
    expect(unknown, `\n${unknown.join("\n")}\n`).toEqual([]);
  });

  it("every registered affordance is wired to at least one surface", () => {
    const wired = new Set(sites.map((s) => s.id));
    const orphans = keys
      .filter((k) => !wired.has(k))
      .map(
        (k) =>
          `${k}: declared in ONE_TAP_AFFORDANCES but no component calls ` +
          `useOptimisticLedger("${k}")`
      );
    expect(orphans, `\n${orphans.join("\n")}\n`).toEqual([]);
  });

  // The guard must be able to fail (the #1893 fixture rule).
  it("FLAGS a planted non-literal call and reads a literal one", () => {
    expect(
      ledgerCallSites(`const l = useOptimisticLedger(affordanceVar);`, "f.tsx")
    ).toEqual([{ file: "f.tsx", id: null }]);
    expect(
      ledgerCallSites(
        `const l = useOptimisticLedger<Set<string>>("mobility-move");`,
        "f.tsx"
      )
    ).toEqual([{ file: "f.tsx", id: "mobility-move" }]);
    // Imports and prose are not call sites.
    expect(
      ledgerCallSites(
        `import { useOptimisticLedger } from "@/components/useOptimisticLedger";\n// through the shared useOptimisticLedger (#2041)\n`,
        "f.tsx"
      )
    ).toEqual([]);
  });
});
