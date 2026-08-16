// The DB tier's template cache is only as honest as its key.
//
// `templateKey()` decides whether the migrated template on disk may be reused, so
// an input it does not hash is an input that can go stale silently. The migration
// sources are the obvious half, and the two halves that were missed both come from
// the same false premise — "boot tasks re-run per file, so their effects are
// reapplied":
//
//   • it is true of an ADD and an UPDATE and false of a DELETE. Nothing removes a
//     `seed` row the dataset no longer has, so a reused template keeps serving it.
//     Measured before that guard existed: dropping an entry from
//     lib/canonical-result-definitions.json and re-running the tier still returned
//     `{"name":"Audiologic Diagnosis","source":"seed"}` from the cached template,
//     where the same experiment without the cache answered `null`.
//   • and it is false outright for a task GATED ON ALREADY-DONE (#2817).
//     `bootstrapAuth` returns early once a login exists, which it does in every
//     copied template, so what it bakes for profile 1 is written into the template
//     bytes exactly once and never re-derived. Its inputs are hashed for that
//     reason, and the last case below is what keeps that list true as the function
//     changes: it reads bootstrapAuth's OWN imports out of the source and demands
//     the key cover each one.
//
// These cases assert the KEY, not the cache's behaviour — the key is the cheap,
// pure thing, and it is what decides everything downstream.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  TEMPLATE_INPUT_DIRS,
  TEMPLATE_INPUT_FILES,
  templateKey,
} from "@/lib/__db_tests__/shared-template";

const BOOT_TASKS = "lib/migrations/boot-tasks.ts";

/**
 * Source with comments and string bodies blanked out.
 *
 * Comments are prose, and prose says names it does not call: bootstrapAuth's own
 * "the admin now exists" made the scan below charge `now` (lib/clock.ts) to the
 * key, an input the function never reads. Blanking rather than deleting keeps the
 * brace depth `functionBody` counts on intact.
 */
function withoutComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

/**
 * …and with string bodies blanked too, so a brace inside a SQL literal cannot
 * throw off the brace count. Import specifiers are gone here, so this is the
 * shape for reading a function BODY, never for reading the import list.
 */
function codeOnly(src: string): string {
  return withoutComments(src).replace(
    /(["'`])(?:\\.|(?!\1)[^\\])*\1/g,
    (m) => m.replace(/[^\n]/g, " ")
  );
}

/** The source text of one top-level `function <name>(...) { ... }` body. */
function functionBody(src: string, name: string): string {
  const start = src.indexOf(`export function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in ${BOOT_TASKS}`);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`unbalanced braces reading ${name}`);
}

/**
 * The VALUE imports of a module, as `{ binding -> specifier }`.
 *
 * `import type` statements are skipped: a type erases at build time and bakes
 * nothing into a database, so hashing its module would rebuild the template for
 * an edit that cannot change a byte of it.
 */
function valueImports(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /import\s+(?!type\s)([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const clause = m[1];
    const spec = m[2];
    for (const raw of clause.replace(/[{}]/g, " ").split(",")) {
      const name = raw.trim().split(/\s+as\s+/).pop()?.trim();
      // A `{ type Foo }` inline specifier erases too.
      if (!name || /^type\b/.test(raw.trim())) continue;
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.set(name, spec);
    }
  }
  return out;
}

/** A relative specifier resolved to its repo-relative source file, or null. */
function resolveLibFile(spec: string): string | null {
  if (!spec.startsWith(".")) return null; // node: builtin or package
  const base = path.posix.normalize(
    path.posix.join(path.posix.dirname(BOOT_TASKS), spec)
  );
  for (const cand of [base, `${base}.ts`, `${base}.json`, `${base}/index.ts`]) {
    if (fs.existsSync(path.join(process.cwd(), cand))) return cand;
  }
  return null;
}

/** Is this repo-relative file already an input to `templateKey()`? */
function coveredByKey(file: string): boolean {
  return (
    TEMPLATE_INPUT_FILES.includes(file) ||
    TEMPLATE_INPUT_DIRS.some((d) => file.startsWith(`${d}/`))
  );
}

/**
 * Run `fn` with `file` temporarily edited, always restoring the original.
 *
 * The edit is asserted to have CHANGED the source. A `.replace()` whose target has
 * since been reworded is a silent no-op, and a no-op edit produces an unchanged
 * key — which is the exact assertion these cases make, so the test would go green
 * while proving nothing.
 */
function withEdited(file: string, edit: (src: string) => string): string {
  const abs = path.join(process.cwd(), file);
  const original = fs.readFileSync(abs, "utf8");
  const edited = edit(original);
  if (edited === original) {
    throw new Error(
      `the probe edit to ${file} changed nothing — its target has moved, and ` +
        `this case can no longer tell a covered input from an uncovered one`
    );
  }
  try {
    fs.writeFileSync(abs, edited);
    return templateKey();
  } finally {
    fs.writeFileSync(abs, original);
  }
}

describe("the DB template cache key", () => {
  it("is stable when nothing changes", () => {
    expect(templateKey()).toBe(templateKey());
  });

  it("changes when a migration changes", () => {
    // The half that was never in doubt, asserted so the walk itself cannot
    // silently stop reading the migrations directory.
    const before = templateKey();
    const after = withEdited(
      "lib/migrations/versions/index.ts",
      (s) => s + "\n// orchestrator probe\n"
    );
    expect(after).not.toBe(before);
  });

  it("changes when the seed dataset a boot task bakes changes", () => {
    // The half that was missed. A REMOVAL is the case that matters: an upsert
    // corrects a changed row on every boot, and nothing deletes a stale one.
    const before = templateKey();
    const after = withEdited("lib/canonical-result-definitions.json", (s) => {
      const parsed = JSON.parse(s) as { definitions: { name: string }[] };
      parsed.definitions.pop();
      return JSON.stringify(parsed, null, 2) + "\n";
    });
    expect(
      after,
      "dropping a canonical biomarker must invalidate the template, or the " +
        "cached one keeps serving a seed row the dataset no longer has"
    ).not.toBe(before);
  });

  it("changes when what bootstrapAuth bakes for profile 1 changes", () => {
    // The #2817 case, and the reason it is a DIFFERENT failure from the dataset
    // one above. `seedStandardMetricSaves` runs inside bootstrapAuth, which is
    // gated on `if (count > 0) return` — a login exists in every copied template,
    // so this never re-runs on a per-file reopen and its output is frozen into the
    // template bytes at build time. Editing the seeded tile list must therefore
    // rebuild, or profile 1 keeps serving the old set for as long as the cache
    // survives (days, now that it is reused across invocations).
    const before = templateKey();
    const after = withEdited("lib/standard-metric-seeds.ts", (s) =>
      s.replace(`"volume",`, `"volume",\n  "sleep",`)
    );
    expect(
      after,
      "changing the standard metric seeds must invalidate the template, or " +
        "profile 1 keeps the tiles baked in when the cache was first built"
    ).not.toBe(before);
  });

  it("changes when the initial onboarding state changes", () => {
    // The same gate, the other thing bootstrapAuth bakes: profile 1's
    // `onboarding_state` row is written once, from `initialOnboardingState()`.
    const before = templateKey();
    const after = withEdited("lib/onboarding.ts", (s) =>
      s.replace("basicsComplete: false,", "basicsComplete: true,")
    );
    expect(after).not.toBe(before);
  });

  it("covers every module bootstrapAuth bakes state from", () => {
    // THE GUARD. The two cases above pin today's three inputs; this one is what
    // fails when bootstrapAuth grows a FOURTH. Adding an import that decides what
    // profile 1 is seeded with, without adding it to the key, reproduces #2817
    // exactly — and silently, because the stale row is a row that still exists.
    //
    // Over-approximating is deliberate: a binding is charged to the key whenever
    // its name appears anywhere in the function body. A false positive costs one
    // entry in a list; a false negative is the bug.
    const src = fs.readFileSync(
      path.join(process.cwd(), BOOT_TASKS),
      "utf8"
    );
    const body = functionBody(codeOnly(src), "bootstrapAuth");
    const uncovered: string[] = [];
    for (const [binding, spec] of valueImports(withoutComments(src))) {
      if (!new RegExp(`\\b${binding}\\b`).test(body)) continue;
      const file = resolveLibFile(spec);
      if (file && !coveredByKey(file)) uncovered.push(`${binding} (${file})`);
    }
    expect(
      uncovered,
      "bootstrapAuth is gated on `if (count > 0) return`, so it runs ONCE per " +
        "template and its output is frozen into the template bytes. Every " +
        "module it reads state from must be in TEMPLATE_INPUT_FILES, or " +
        "editing that module leaves a cached template serving profile 1 the " +
        "old value indefinitely (issue #2817)."
    ).toEqual([]);
  });

  it("reads bootstrapAuth's imports at all", () => {
    // The guard above passes vacuously if the source scan silently stops finding
    // anything — a rename, a moved file, a regex that no longer matches. So the
    // scan's own inputs are asserted: the known bake-once dependencies must be
    // among what it charges to the key.
    const src = fs.readFileSync(
      path.join(process.cwd(), BOOT_TASKS),
      "utf8"
    );
    const body = functionBody(codeOnly(src), "bootstrapAuth");
    const seen = [...valueImports(withoutComments(src))]
      .filter(([binding]) => new RegExp(`\\b${binding}\\b`).test(body))
      .map(([, spec]) => resolveLibFile(spec))
      .filter((f): f is string => f != null);
    expect(seen).toEqual(
      expect.arrayContaining([
        "lib/password.ts",
        "lib/standard-metric-seeds.ts",
        "lib/onboarding.ts",
      ])
    );
  });

  it("restores every file it edits", () => {
    // The cases above write to tracked files. If one ever failed to restore, the
    // damage would be a corrupted dataset in someone's working tree, so the
    // restoration is asserted rather than trusted to a finally block nobody reads.
    expect(templateKey()).toBe(templateKey());
    const parsed = JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), "lib/canonical-result-definitions.json"),
        "utf8"
      )
    ) as { definitions: unknown[] };
    expect(parsed.definitions.length).toBeGreaterThan(100);
  });
});
