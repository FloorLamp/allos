import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  ADULT_ONLY_WRITE_CORES,
  ADULT_ONLY_MUTATION_MARKERS,
} from "../adult-only-writes";

// Adult-only write-gate scanner (issue #2107). The registry in
// lib/adult-only-writes.ts explains WHY this exists; this file is the teeth.
//
// THE RULE: in a registered module, every EXPORTED function whose body mutates must
// call that module's declared life-stage gate. #2107 was a shared write core reached
// from a second surface that never asked — narrowing the two known callers would have
// left the next one to rediscover it, so the refusal lives in the core and this scan
// is what keeps a NEW mutating export from being added without it.
//
// Reads are untouched: a function with no mutation marker needs no gate. Exemptions
// are declared in the registry with a written reason and are reaped here (an entry
// naming a function that no longer exists, or that no longer mutates, fails) — an
// exemption that quietly stops describing the code is the same class of defect as the
// gate it excuses.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

interface ExportedFn {
  name: string;
  body: string;
}

// Every exported function DECLARATION in a module, with its body source. Exported
// consts holding arrow functions are picked up too, so the rule can't be dodged by
// changing the declaration form.
function exportedFunctions(file: string): ExportedFn[] {
  const src = fs.readFileSync(path.join(REPO, file), "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const out: ExportedFn[] = [];
  const isExported = (node: ts.Node): boolean =>
    ts
      .getCombinedModifierFlags(node as ts.Declaration)
      .valueOf() &
      ts.ModifierFlags.Export.valueOf()
      ? true
      : false;

  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && isExported(stmt)) {
      out.push({ name: stmt.name.text, body: stmt.getText(sf) });
      continue;
    }
    if (ts.isVariableStatement(stmt) && isExported(stmt.declarationList)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        if (
          ts.isArrowFunction(decl.initializer) ||
          ts.isFunctionExpression(decl.initializer)
        ) {
          out.push({ name: decl.name.text, body: decl.getText(sf) });
        }
      }
    }
  }
  return out;
}

function mutates(body: string): boolean {
  return ADULT_ONLY_MUTATION_MARKERS.some((m) => body.includes(m));
}

describe("adult-only write gate (issue #2107)", () => {
  it("registers at least one gated core", () => {
    expect(ADULT_ONLY_WRITE_CORES.length).toBeGreaterThan(0);
  });

  for (const core of ADULT_ONLY_WRITE_CORES) {
    describe(core.file, () => {
      it("exists and defines its declared gate", () => {
        const full = path.join(REPO, core.file);
        expect(fs.existsSync(full)).toBe(true);
        const src = fs.readFileSync(full, "utf8");
        // The gate is matched by NAME below, so a rename that misses the registry
        // would turn every check into a vacuous "nothing calls a function that does
        // not exist". Prove the name is real first.
        expect(src).toMatch(
          new RegExp(`function\\s+${core.gate}\\s*\\(`)
        );
      });

      it("gates every exported function that mutates", () => {
        const fns = exportedFunctions(core.file);
        const exempt = new Set(core.exempt.map((e) => e.fn));
        const ungated = fns
          .filter((f) => mutates(f.body))
          .filter((f) => !f.body.includes(`${core.gate}(`))
          .map((f) => f.name)
          .filter((n) => !exempt.has(n));
        expect(
          ungated,
          `${core.file}: these exported writes never ask ${core.gate}() — ` +
            `call the gate, or declare the exemption with a reason in ` +
            `lib/adult-only-writes.ts`
        ).toEqual([]);
      });

      it("has at least one gated write (the rule is not vacuous)", () => {
        const fns = exportedFunctions(core.file);
        const gated = fns.filter(
          (f) => mutates(f.body) && f.body.includes(`${core.gate}(`)
        );
        expect(gated.length).toBeGreaterThan(0);
      });

      it("reaps stale exemptions", () => {
        const fns = new Map(exportedFunctions(core.file).map((f) => [f.name, f]));
        for (const e of core.exempt) {
          const fn = fns.get(e.fn);
          expect(fn, `${core.file}: exempt ${e.fn} no longer exists`).toBeDefined();
          expect(
            fn && mutates(fn.body),
            `${core.file}: exempt ${e.fn} no longer mutates — drop the exemption`
          ).toBe(true);
          expect(e.why.length).toBeGreaterThan(30);
        }
      });
    });
  }
});
