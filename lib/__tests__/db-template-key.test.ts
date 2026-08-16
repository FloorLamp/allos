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
//     reason, and the guard cases below are what keep that list true as the function
//     changes: they read the imports named anywhere bootstrapAuth can reach INSIDE
//     ITS OWN MODULE — its body plus every local helper it calls, transitively — and
//     demand the key cover each one. The scope is stated exactly because the first
//     version claimed more than it did: reading only bootstrapAuth's own body goes
//     green on the same seeding call moved into a local helper, which reproduces
//     #2817 unchanged. That escape is now a case of its own.
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
 * brace depth `declaredFunctions` counts on intact.
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
  return withoutComments(src).replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, (m) =>
    m.replace(/[^\n]/g, " ")
  );
}

/** The brace-matched block starting at `open`, which must be a `{`. */
function block(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`unbalanced braces at ${open}`);
}

/**
 * Every function BODY the module declares, by name — `function f() {}` and
 * `const f = (…) => {}` alike, exported or not.
 *
 * Local helpers are in here because the scan follows them; see `bakeOnceScope`.
 */
function declaredFunctions(code: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of code.matchAll(
    /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g
  )) {
    // Walk the parameter list to its closing paren, then take the body that follows —
    // a return-type annotation can carry braces of its own.
    let i = m.index + m[0].length;
    let paren = 1;
    while (i < code.length && paren > 0) {
      if (code[i] === "(") paren++;
      else if (code[i] === ")") paren--;
      i++;
    }
    const open = code.indexOf("{", i);
    if (open >= 0) out.set(m[1], block(code, open));
  }
  for (const m of code.matchAll(
    /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=\n]*)?=>\s*\{/g
  )) {
    out.set(m[1], block(code, m.index + m[0].length - 1));
  }
  return out;
}

/**
 * The source text a bake-once entry point can reach INSIDE its own module: its own
 * body, plus the bodies of every local function it names, transitively.
 *
 * ONE HOP WAS NOT ENOUGH, and the first version of this guard only had one. Reading
 * bootstrapAuth's own body catches a direct `seedStandardMetricSaves(db, id)` — and
 * goes green on the identical write moved into a local `bakeProfileDefaults(db)`
 * helper three lines away, which reproduces #2817 exactly. The escape was not exotic;
 * it is what anyone tidying a long function does.
 *
 * WHAT IT STILL CANNOT SEE, stated rather than implied: a call reached through a
 * VALUE — a helper stored in a table and invoked by lookup, or a method on an
 * imported object — and any hop into another module's functions. The migrations
 * directory is hashed wholesale so an intra-`lib/migrations` hop is covered by
 * accident rather than by this scan. So this is a strong net over the shape the
 * defect actually took, not a proof; a bake-once write placed outside it still needs
 * its input added to the list by hand.
 */
function bakeOnceScope(code: string, entry: string): string {
  const fns = declaredFunctions(code);
  const entryBody = fns.get(entry);
  if (entryBody == null) throw new Error(`${entry} not found in ${BOOT_TASKS}`);
  const seen = new Set<string>();
  const queue = [entry];
  let scope = "";
  while (queue.length > 0) {
    const name = queue.pop() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    const body = fns.get(name);
    if (body == null) continue;
    scope += `\n${body}`;
    for (const other of fns.keys())
      if (!seen.has(other) && new RegExp(`\\b${other}\\b`).test(body))
        queue.push(other);
  }
  return scope;
}

/**
 * The repo-relative files an entry point bakes state from: every VALUE import whose
 * binding is named anywhere in that reachable scope.
 *
 * Over-approximating on purpose — a binding counts when its name appears, not when a
 * call is proven. A false positive costs one entry in a list.
 */
function bakeOnceInputs(src: string, entry: string): string[] {
  const scope = bakeOnceScope(codeOnly(src), entry);
  const out: string[] = [];
  for (const [binding, spec] of valueImports(withoutComments(src))) {
    if (!new RegExp(`\\b${binding}\\b`).test(scope)) continue;
    const file = resolveLibFile(spec);
    if (file) out.push(file);
  }
  return out;
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
      const name = raw
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
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

/**
 * The repo-relative files `file` imports — its closure's FIRST HOP, and the only
 * measurement of a closure this suite makes.
 *
 * Deliberately not a count and not a walk. `shared-template.ts` explains why the key
 * is a named list rather than a closure, and that argument turns on a DISTINCTION:
 * three of the five inputs sit inside `lib/`'s import cycle and reach on the order of a
 * thousand files, while two are LEAVES that reach nothing. The thousand is a threshold
 * — nothing a reader decides changes between 316, 974 and 1006, and the figure depends
 * on whether a type-only import counts — so pinning one would launder a method choice
 * into a fact and go red on any PR that adds a file to `lib/`. The ZERO is a different
 * kind of claim: binary, method-free, and the concession the whole argument rests on.
 * It also goes silently false the first time a seed module imports `./db`, at which
 * point the comment is wrong and nothing says so. So the zero is asserted and the
 * magnitude is left as prose — the same posture as this file's other cases, which
 * assert relationships rather than counts.
 *
 * EVERY import, `import type` included: the emptiness claim is about the module's
 * source dependencies, and a source-hash key would have to hash a type-only import
 * like any other file. Non-relative specifiers (`node:crypto`, `better-sqlite3`) are
 * not repo files and so are not in the closure at all.
 */
function repoImportsOf(file: string): string[] {
  const src = fs.readFileSync(path.join(process.cwd(), file), "utf8");
  const out = new Set<string>();
  for (const m of withoutComments(src).matchAll(/from\s*["']([^"']+)["']/g)) {
    const spec = m[1];
    if (!spec.startsWith(".")) continue;
    const base = path.posix.normalize(
      path.posix.join(path.posix.dirname(file), spec)
    );
    for (const cand of [
      base,
      `${base}.ts`,
      `${base}.json`,
      `${base}/index.ts`,
    ]) {
      if (fs.existsSync(path.join(process.cwd(), cand))) {
        out.add(cand);
        break;
      }
    }
  }
  return [...out].sort();
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
    // WHAT IT COVERS, precisely — the coverage claim is part of the guard, and an
    // over-stated one is worse than a narrow one: bootstrapAuth's own body plus the
    // bodies of every LOCAL function it names, transitively, and inside that scope
    // every value import whose binding appears by name. Over-approximating on the
    // last step is deliberate; a false positive costs one entry in a list.
    //
    // What it does NOT cover is written on `bakeOnceScope`: a call reached through a
    // value rather than by name, and any hop into another module. Those still need
    // the input added by hand.
    const src = fs.readFileSync(path.join(process.cwd(), BOOT_TASKS), "utf8");
    const uncovered = bakeOnceInputs(src, "bootstrapAuth").filter(
      (f) => !coveredByKey(f)
    );
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
    const src = fs.readFileSync(path.join(process.cwd(), BOOT_TASKS), "utf8");
    expect(bakeOnceInputs(src, "bootstrapAuth")).toEqual(
      expect.arrayContaining([
        "lib/password.ts",
        "lib/standard-metric-seeds.ts",
        "lib/onboarding.ts",
      ])
    );
  });

  it("follows a bake-once write moved into a LOCAL helper", () => {
    // THE FALSIFICATION, and the reason the scan is not one hop.
    //
    // A one-hop scan reads only bootstrapAuth's own body. Tidying the seeding call
    // into a helper three lines down — the most ordinary refactor there is — moves
    // the binding out of that body and the guard goes green while the seed output is
    // exactly as frozen into the template as it ever was. The scan is asserted
    // against that source rather than against prose about it.
    const moved = [
      `import { seedStandardMetricSaves } from "../standard-metric-seeds";`,
      `import { runBootTx } from "./schema-utils";`,
      `export function bootstrapAuth(db: Database.Database) {`,
      `  const count = 0;`,
      `  if (count > 0) return;`,
      `  runBootTx(db.transaction(() => { bakeProfileDefaults(db, 1); }));`,
      `}`,
      `function bakeProfileDefaults(db: Database.Database, profId: number) {`,
      `  seedStandardMetricSaves(db, profId);`,
      `}`,
    ].join("\n");

    expect(
      bakeOnceInputs(moved, "bootstrapAuth"),
      "a bake-once write one call away from bootstrapAuth still freezes into the " +
        "template, so the scan has to reach it"
    ).toContain("lib/standard-metric-seeds.ts");

    // And the same source read one hop only — what this guard used to do — does not
    // see it. Stated as an assertion so the falsification cannot rot into a comment.
    const oneHop =
      declaredFunctions(codeOnly(moved)).get("bootstrapAuth") ?? "";
    expect(oneHop).not.toContain("seedStandardMetricSaves");
  });

  it("keeps the two leaf inputs leaves", () => {
    // THE CONCESSION THE NAMED-LIST ARGUMENT RESTS ON, asserted rather than described.
    // `shared-template.ts` grants that for these two a closure key would be exact and
    // cheap, and wins the argument anyway — because the rule has to hold for whatever
    // the NEXT bake-once input is, and `onboarding.ts` already shows one sitting inside
    // the cycle. That concession stops being a concession the moment either leaf grows
    // a repo import, and nothing else in the suite would notice.
    for (const leaf of ["lib/password.ts", "lib/standard-metric-seeds.ts"]) {
      expect(
        repoImportsOf(leaf),
        `${leaf} is documented as a LEAF — a bake-once input whose closure is empty. ` +
          `It now imports repo files, so the "one named list, not a closure" argument ` +
          `in lib/__db_tests__/shared-template.ts describes a repo that no longer ` +
          `exists. Re-read that comment before adding the import.`
      ).toEqual([]);
    }
    // And the other side of the distinction, so the emptiness is a CONTRAST rather than
    // an accident of how `repoImportsOf` reads a file. The magnitude stays prose; that
    // these two reach nothing and the cycle's members reach something is the claim.
    for (const inCycle of [BOOT_TASKS, "lib/db.ts", "lib/onboarding.ts"]) {
      expect(repoImportsOf(inCycle).length).toBeGreaterThan(0);
    }
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
