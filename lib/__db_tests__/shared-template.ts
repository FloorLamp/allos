import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Where the shared-registry DB tier keeps its pre-migrated template database.
//
// Deterministic on purpose: vitest's globalSetup builds it in the MAIN process
// while the setup file copies it from inside each WORKER, and a computed path
// both sides derive independently avoids passing a value across that boundary.
// It lives under node_modules/.cache so it is already git-ignored and is thrown
// away by a clean install.
export function templateDbPath(): string {
  return path.join(
    process.cwd(),
    "node_modules",
    ".cache",
    "allos-db-tests",
    "template.db"
  );
}

// Sidecars SQLite (and our boot lock) can leave beside the template. Cleared
// before a rebuild so a stale WAL can never be read as part of the schema.
export const TEMPLATE_SIDECARS = ["", "-wal", "-shm", ".boot-lock"] as const;

/** Where the fingerprint of the inputs that produced the template is recorded. */
export function templateKeyPath(): string {
  return templateDbPath() + ".key";
}

// WHAT THE TEMPLATE IS A FUNCTION OF.
//
// Rebuilding it costs ~0.8s — importing 191 migration modules and replaying the
// chain — and it was paid on EVERY invocation, including a developer running one
// test file, where the whole run is ~5.4s of which 0.1s is the test. Reusing it
// across runs takes that single file to ~4.0s.
//
// Reuse needs a fingerprint that cannot miss a schema change, so this hashes the
// migration sources THEMSELVES rather than a proxy for them. `manifest.json`
// would be the tempting key — every shipped migration's sha256 is already in it —
// but it only holds while the manifest is kept in step, and a key that is right
// only when another rule was followed is the #2444 shape: it reads like a guard
// and covers nothing the day someone forgets. Hashing 191 small files costs a few
// milliseconds and depends on nothing.
//
// `lib/db.ts` joins them because it owns boot ORDER, and `boot-tasks.ts` is
// inside the migrations directory already. Per-boot tasks additionally re-run
// when each file reopens its copy (see setup-shared.ts), so their EFFECTS are
// reapplied per file regardless — they are in the key for the case where a task
// changed what it bakes into the template, not for the ordinary path.
//
// EXCEPT WHERE THE TASK DOES NOT ACTUALLY RE-RUN, and there are two such cases.
// Both are the same defect in different clothes: "reapplied per file" is a claim
// about an EFFECT, and it holds only while every boot re-derives that effect from
// current code.
//
// (1) A TASK GATED ON ALREADY-DONE (issue #2817). `bootstrapAuth` opens with
// `if (count > 0) return;` — a login exists in every copied template — so on each
// per-file reopen it early-returns and never runs again. Everything it writes for
// the bootstrap admin (profile 1) is therefore baked into the template BYTES
// exactly once, when globalSetup first builds it: the `onboarding_state` marker
// (`lib/onboarding.ts`), the login's password hash (`lib/password.ts`), and the
// default-saved standard metric tiles (`lib/standard-metric-seeds.ts`). Those
// three files are in the list below for exactly that reason. Before cross-run
// caching the staleness was bounded to one `npm run test:db` process, which
// always rebuilt; now one template can be reused for days, so a change to what a
// new profile is seeded with could keep serving profile 1 the old seed
// indefinitely. The OTHER bake-once tasks (`seedTimezoneFromEnv`,
// `seedAiTiersFromEnv`, `seedSmtpFromEnv`, the install marker) derive their state
// from the ENVIRONMENT, not from a lib module, so they have no source input to
// hash. `lib/__tests__/db-template-key.test.ts` holds the guard that fails when
// bootstrapAuth grows an import this list does not cover.
//
// (2) A TASK THAT REMOVES SOMETHING, which is why the seed dataset is
// hashed too. "Effects are reapplied per file" holds for an ADD and an UPDATE —
// `seedCanonicalResultDefinitions` is an `ON CONFLICT … DO UPDATE` upsert, so a changed
// row is corrected on every boot — and fails for a DELETE, because no boot task
// removes a `seed` row it no longer has. Measured on this branch: drop an entry
// from `lib/canonical-result-definitions.json`, and a reused template still serves it
// (`{"name":"Audiologic Diagnosis","source":"seed"}`), where an uncached run
// answers `null`. So the dataset joins the key: it is the one input the
// reapply-per-file argument does not cover.
//
// WHAT THIS KEY DOES NOT COVER, stated rather than implied. It hashes direct
// inputs, not their import closures — `lib/db.ts` transitively reaches
// essentially all of `lib/`, and keying on that would rebuild on nearly every
// edit a developer running this tier has just made, which is the whole saving.
// So a dataset baked in through a module OTHER than the ones named here can still
// go stale. If you change what a boot task bakes, either add its input below or
// delete node_modules/.cache/allos-db-tests.
//
// WHY A NAMED LIST AND NOT A CLOSURE, measured rather than assumed — and the
// measurement does NOT come out the same for all five entries.
//
// ONE FIGURE, AND ITS METHOD. This comment used to carry "989" here and "~1000"
// eleven lines down for the same measurement, and neither matched. A closure size
// is not a single number: counting every reachable `.ts` puts `lib/db.ts` near a
// thousand, while a value-only walk that erases `import type` puts it in the low
// hundreds, and the count moves with every merge either way. The TYPE-INCLUSIVE
// count is the one this argument rests on, because a source-hash key would have to
// hash a type-only import like any other file. So what is stated is the shape:
//
//   • `lib/db.ts`, `lib/migrations/boot-tasks.ts` and `lib/onboarding.ts` each
//     transitively reach essentially all of `lib/` — on the order of a thousand
//     files, type-only imports counted — because `lib/` is one big import cycle.
//     Keying on any of those closures rebuilds the template on nearly every edit
//     a developer running this tier just made.
//   • `lib/password.ts` and `lib/standard-metric-seeds.ts` are LEAVES: the first
//     imports only `node:crypto`, the second only a TYPE from `better-sqlite3`.
//     Their closures are empty, so for those two a closure key would be exact and
//     cheap — the argument above does not apply to them at all.
//
// THE ZERO IS ASSERTED, THE THOUSAND IS NOT, and the split is on purpose. A
// threshold has no canonical method — nothing a reader decides changes between
// 316, 974 and 1006 — so pinning one would launder a method choice into a fact
// and go red on any PR that adds a file to `lib/`. The emptiness is binary,
// method-free, and the concession this whole argument rests on, and it goes
// silently false the first time a seed module imports `./db`. So
// `lib/__tests__/db-template-key.test.ts`'s "keeps the two leaf inputs leaves"
// holds these two to zero repo imports, and the magnitude above stays prose.
//
// The list wins anyway, for a reason that survives that split: the shape has to
// hold for whatever the NEXT bake-once input turns out to be, and `onboarding.ts`
// already shows that input can sit inside the cycle. A rule that keys on closures
// where they happen to be small and on filenames where they are not is two rules.
// So: one named list, and the guard test in `lib/__tests__/db-template-key.test.ts`
// is what keeps it complete.
//
// A wrong key is USUALLY loud — a stale template missing a column fails the tests
// that touch it, naming it — but do not read that as "cannot turn a red test
// green". The stale template can also carry an EXTRA row the current inputs no
// longer produce, and code still depending on a row you just deleted goes green
// locally and red on a cold CI checkout. Loud in the common direction, not in
// every direction.
// Exported so the guard test can assert the list against bootstrapAuth's own
// imports rather than restating it — a second copy of this list would be the
// thing that goes stale.
export const TEMPLATE_INPUT_DIRS = ["lib/migrations"];
export const TEMPLATE_INPUT_FILES = [
  "lib/db.ts",
  "lib/canonical-result-definitions.json",
  // bootstrapAuth's bake-once inputs — see (1) in the header.
  "lib/onboarding.ts",
  "lib/password.ts",
  "lib/standard-metric-seeds.ts",
];

// The path is folded in REPO-RELATIVE, never absolute: a rename must change the
// key, but the checkout's location must not. An absolute path would re-key the
// template for every worktree and silently rebuild it every time — which fails
// safe, and costs exactly the saving this exists for.
function hashFileInto(hash: crypto.Hash, root: string, file: string): void {
  hash.update(path.relative(root, file).split(path.sep).join("/"));
  hash.update(fs.readFileSync(file));
}

function walkInto(hash: crypto.Hash, root: string, dir: string): void {
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkInto(hash, root, p);
    else hashFileInto(hash, root, p);
  }
}

/**
 * Fingerprint of everything that decides the template's schema.
 *
 * Sorted so two machines walking the same tree agree — an order-dependent key
 * would rebuild at random and look like a flaky cache.
 */
export function templateKey(root = process.cwd()): string {
  const hash = crypto.createHash("sha256");
  for (const dir of TEMPLATE_INPUT_DIRS)
    walkInto(hash, root, path.join(root, dir));
  for (const file of TEMPLATE_INPUT_FILES)
    hashFileInto(hash, root, path.join(root, file));
  return hash.digest("hex");
}
