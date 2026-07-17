import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Anti-rot guard for the identity-registry doc (issue #860 Track D). The doc
// (docs/internals/identity-registry.md) is the index of the canonical identity /
// collapse functions (#482) + the cross-cutting identity registries. A doc that names
// a symbol which has since been renamed or deleted is worse than none — a reader (or an
// agent) reaches for a function that no longer exists. This test parses the doc and
// asserts everything it names still resolves in the code:
//
//   • every `symbol()` call-span is an exported function/const somewhere under lib/;
//   • every ALL_CAPS_UNDERSCORE code-span is an exported const;
//   • every `lib/....ts` path it cites exists.
//
// It is deliberately the HONEST half of the completeness contract: it cannot prove a
// NEW identity function was added WITH a doc entry (there is no single machine-
// enumerable registry of "identity functions" to diff against — they live across many
// modules), so that direction stays a review convention, noted in the doc. Pure — fs
// only, no DB/network.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DOC = path.join(REPO, "docs/internals/identity-registry.md");
const LIB = path.join(REPO, "lib");

// Every `export function X` / `export const X` name declared anywhere under lib/.
function collectExports(): Set<string> {
  const names = new Set<string>();
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        // Skip the test tiers — the doc names production symbols only.
        if (ent.name === "__tests__" || ent.name === "__db_tests__") continue;
        if (ent.name === "__action_tests__") continue;
        walk(p);
      } else if (ent.name.endsWith(".ts")) {
        const src = fs.readFileSync(p, "utf8");
        for (const m of src.matchAll(
          /export\s+(?:async\s+)?(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/g
        )) {
          names.add(m[1]);
        }
      }
    }
  };
  walk(LIB);
  return names;
}

describe("identity-registry doc — anti-rot", () => {
  const doc = fs.readFileSync(DOC, "utf8");
  const exports = collectExports();

  it("names only functions/consts that are still exported under lib/", () => {
    // `symbol()` call-spans in backticks — the functions the doc points at.
    const fnNames = new Set(
      [...doc.matchAll(/`([A-Za-z_$][\w$]*)\(\)`/g)].map((m) => m[1])
    );
    expect(fnNames.size).toBeGreaterThan(10); // the doc really does name many
    for (const name of fnNames) {
      expect(
        exports.has(name),
        `identity-registry.md names \`${name}()\` but no \`export function/const ${name}\` exists under lib/ (renamed or deleted?)`
      ).toBe(true);
    }
  });

  it("names only ALL_CAPS registries that are still exported under lib/", () => {
    // ALL_CAPS_UNDERSCORE code-spans — the registry consts (REASON_CODES, …).
    const constNames = new Set(
      [...doc.matchAll(/`([A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+)`/g)].map((m) => m[1])
    );
    for (const name of constNames) {
      expect(
        exports.has(name),
        `identity-registry.md names \`${name}\` but it is not exported under lib/`
      ).toBe(true);
    }
  });

  it("cites only files that exist", () => {
    const paths = new Set(
      [...doc.matchAll(/`(lib\/[\w./-]+\.ts)`/g)].map((m) => m[1])
    );
    expect(paths.size).toBeGreaterThan(5);
    for (const rel of paths) {
      expect(
        fs.existsSync(path.join(REPO, rel)),
        `identity-registry.md cites ${rel} but it does not exist`
      ).toBe(true);
    }
  });
});
