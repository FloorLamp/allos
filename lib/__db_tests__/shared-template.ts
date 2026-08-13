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
// EXCEPT WHERE THE TASK REMOVES SOMETHING, which is why the seed dataset is
// hashed too. "Effects are reapplied per file" holds for an ADD and an UPDATE —
// `seedCanonicalBiomarkers` is an `ON CONFLICT … DO UPDATE` upsert, so a changed
// row is corrected on every boot — and fails for a DELETE, because no boot task
// removes a `seed` row it no longer has. Measured on this branch: drop an entry
// from `lib/canonical-biomarkers.json`, and a reused template still serves it
// (`{"name":"Audiologic Diagnosis","source":"seed"}`), where an uncached run
// answers `null`. So the dataset joins the key: it is the one input the
// reapply-per-file argument does not cover.
//
// WHAT THIS KEY DOES NOT COVER, stated rather than implied. It hashes direct
// inputs, not their import closures — `lib/db.ts` transitively reaches 989 files,
// essentially all of `lib/`, and keying on that would rebuild on nearly every
// edit a developer running this tier has just made, which is the whole saving.
// So a dataset baked in through a module OTHER than the two named here can still
// go stale. If you change what a boot task bakes, either add its input below or
// delete node_modules/.cache/allos-db-tests.
//
// A wrong key is USUALLY loud — a stale template missing a column fails the tests
// that touch it, naming it — but do not read that as "cannot turn a red test
// green". The stale template can also carry an EXTRA row the current inputs no
// longer produce, and code still depending on a row you just deleted goes green
// locally and red on a cold CI checkout. Loud in the common direction, not in
// every direction.
const TEMPLATE_INPUT_DIRS = ["lib/migrations"];
const TEMPLATE_INPUT_FILES = ["lib/db.ts", "lib/canonical-biomarkers.json"];

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
export function templateKey(): string {
  const hash = crypto.createHash("sha256");
  const root = process.cwd();
  for (const dir of TEMPLATE_INPUT_DIRS)
    walkInto(hash, root, path.join(root, dir));
  for (const file of TEMPLATE_INPUT_FILES)
    hashFileInto(hash, root, path.join(root, file));
  return hash.digest("hex");
}
