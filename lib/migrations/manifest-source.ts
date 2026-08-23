import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ONE SPELLING OF THE MANIFEST ALGORITHM, TWO READERS (#3579).
//
// `manifest.json` holds a sha-256 per shipped migration file, and its whole job is
// to prove nobody edited a migration FILE after it shipped. That is the whole claim
// and it stops at the file boundary: 16 shipped migrations import mutable modules
// from outside versions/ (`../../date`, `../../canonical-name`, `../../timezone`, …)
// and this manifest hashes none of them, so editing `lib/date.ts` changes what a
// shipped migration DOES on a fresh boot with every hash here unchanged. Do not try
// to close that by hashing the transitive import graph — it would re-hash most of
// lib/ on every change and the manifest would stop being reviewable. A migration
// that must be frozen against its helpers inlines them. It had a READER
// (lib/__tests__/migration-immutability.test.ts) and NO WRITER, so every migration
// merge conflict ended with a hash typed in by hand — a hash nobody computed, in
// the file whose purpose is to prove a computation.
//
// The writer is scripts/gen-migration-manifest.ts. It does NOT reimplement any of
// this: a generator that spells the hash a second time is a second source of truth
// for exactly the thing the guard exists to check, and the two drift on the first
// change to either. Both readers import from here, so a change to the algorithm
// moves both at once or neither.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const VERSIONS_DIR = path.join(REPO, "lib/migrations/versions");
export const MANIFEST_PATH = path.join(REPO, "lib/migrations/manifest.json");
export const REGISTRY_PATH = path.join(VERSIONS_DIR, "index.ts");

/** Repo-relative spellings, for messages that have to be greppable. */
export const MANIFEST_REL = "lib/migrations/manifest.json";
export const REGISTRY_REL = "lib/migrations/versions/index.ts";

// Every migration file: the closed numbered era (001-baseline.ts … 185-*.ts) and
// the name-keyed era after it (YYYYMMDD-slug.ts). index.ts is NOT frozen — it is
// edited to append each new migration — so it is excluded from both the manifest
// and the hash set.
export const LEGACY_FILE_RE = /^\d{3}-[a-z0-9-]+\.ts$/;
export const NAMED_FILE_RE = /^\d{8}-[a-z0-9-]+\.ts$/;

/** The migration files present on disk, filename-sorted. */
export function migrationFilesOnDisk(dir: string = VERSIONS_DIR): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && f !== "index.ts")
    .sort();
}

/** sha-256 over the file's RAW BYTES — no encoding, no normalisation. */
export function sha256OfMigration(
  file: string,
  dir: string = VERSIONS_DIR
): string {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(dir, file)))
    .digest("hex");
}

// REGISTRY ORDER IS THE MANIFEST'S ORDER, and it is read out of index.ts rather
// than guessed. `MIGRATIONS` is an array of import ALIASES, so the order is only
// recoverable by pairing each alias with the module specifier it was imported
// from — and filename sort is NOT the same list. Measured on main 2026-08-23: of
// 219 migrations, 23 register at a different position than they sort at, and
// `20260813-encounter-diagnosis-ranks.ts` registers 186th but sorts 188th, two
// positions off. (Import order, `MIGRATIONS` order and the manifest's key order
// agree at all 219 — those three are the same list; the sorted one is not.)
//
// Text, not import: this must be readable by a script that refuses a tree where
// index.ts and versions/ disagree, and an import of a registry naming a file that
// does not exist throws before it can say so.
const IMPORT_RE =
  /^import\s*\{\s*migration\s+as\s+(\w+)\s*\}\s*from\s*"\.\/([^"]+)";/gm;
const ARRAY_RE = /export const MIGRATIONS:\s*Migration\[\]\s*=\s*\[([^\]]*)\]/m;
// One entry per line, `  mAlias,` — the shape prettier writes and the only shape
// this array has ever held. Matching the ENTRY rather than stripping comments is
// deliberate: a hand-rolled comment stripper is its own defect class here (#3595,
// lib/__tests__/strip-comments.test.ts), and an entry this misses does not go
// silently missing — `assertRegistryMatchesDisk` then reports the file as present
// in versions/ and unregistered, which is exactly the loud failure it is for.
const ENTRY_RE = /^\s*(\w+)\s*,\s*$/gm;

export function registryOrder(registryPath: string = REGISTRY_PATH): string[] {
  const source = fs.readFileSync(registryPath, "utf8");
  const byAlias = new Map<string, string>();
  for (const m of source.matchAll(IMPORT_RE)) {
    byAlias.set(m[1], `${m[2]}.ts`);
  }
  const array = ARRAY_RE.exec(source);
  if (!array) {
    throw new Error(
      `Could not find the \`export const MIGRATIONS: Migration[] = […]\` array in ` +
        `${REGISTRY_REL}. The registry is read as TEXT (see manifest-source.ts) — ` +
        `if the declaration was reshaped, reshape this parser with it.`
    );
  }
  const aliases = [...array[1].matchAll(ENTRY_RE)].map((m) => m[1]);
  const unknown = aliases.filter((a) => !byAlias.has(a));
  if (unknown.length > 0) {
    throw new Error(
      `${REGISTRY_REL} lists ${unknown.join(", ")} in MIGRATIONS with no matching ` +
        `\`import { migration as … } from "./…"\` line. Either the import was lost ` +
        `in a merge or the entry is a typo.`
    );
  }
  return aliases.map((a) => byAlias.get(a)!);
}

/**
 * The manifest as it should be on disk: EVERY entry recomputed from the bytes,
 * keyed in registry order.
 *
 * Recomputing all of them is the proof. A writer that only appends the new entry
 * cannot say "no shipped migration moved during this merge" — and that sentence is
 * the entire reason the file exists.
 */
export function buildManifest(options?: {
  versionsDir?: string;
  registryPath?: string;
}): Record<string, string> {
  const dir = options?.versionsDir ?? VERSIONS_DIR;
  const registry = registryOrder(options?.registryPath ?? REGISTRY_PATH);
  const onDisk = migrationFilesOnDisk(dir);
  assertRegistryMatchesDisk(registry, onDisk);
  const manifest: Record<string, string> = {};
  for (const file of registry) manifest[file] = sha256OfMigration(file, dir);
  return manifest;
}

/**
 * REFUSE A TREE WHERE THE REGISTRY AND THE DIRECTORY DISAGREE. A migration in one
 * and not the other is a conflict resolved wrong — and mid-conflict is exactly
 * when the generator runs, so this is the check that has to fire, not the one
 * that can be skipped.
 */
export function assertRegistryMatchesDisk(
  registry: readonly string[],
  onDisk: readonly string[]
): void {
  const missingOnDisk = registry.filter((f) => !onDisk.includes(f));
  const unregistered = onDisk.filter((f) => !registry.includes(f));
  const duplicates = registry.filter((f, i) => registry.indexOf(f) !== i);
  const problems: string[] = [];
  if (missingOnDisk.length > 0) {
    problems.push(
      `registered in ${REGISTRY_REL} but not present in versions/: ` +
        missingOnDisk.join(", ")
    );
  }
  if (unregistered.length > 0) {
    problems.push(
      `present in versions/ but not registered in ${REGISTRY_REL}: ` +
        unregistered.join(", ")
    );
  }
  if (duplicates.length > 0) {
    problems.push(`registered more than once: ${duplicates.join(", ")}`);
  }
  if (problems.length > 0) {
    throw new Error(
      `The migration registry and the versions/ directory disagree, so no ` +
        `manifest can be written from them:\n  ${problems.join("\n  ")}\n` +
        `This is what a migration merge conflict resolved wrong looks like. Fix ` +
        `${REGISTRY_REL} first — keep BOTH sides of the conflict, both import ` +
        `lines and both array entries — then re-run the generator.`
    );
  }
}

/**
 * The exact bytes the manifest file carries: two-space JSON with a trailing
 * newline, which is what prettier writes and therefore what `format:check`
 * accepts. The generator and the guard both go through here so "the file is up to
 * date" is a byte comparison rather than a re-parse.
 */
export function serializeManifest(manifest: Record<string, string>): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

// A MANIFEST THAT WILL NOT PARSE IS A REFUSAL WITH INSTRUCTIONS, NOT A STACK TRACE
// (#3579 follow-up). `lib/migrations/AGENTS.md` sends people here mid-conflict, and
// `manifest.json` CONFLICTS ON EVERY TWO-MIGRATION MERGE — both sides append to the
// same tail, so git has nothing to interleave. `JSON.parse` on conflict markers threw
// a bare `SyntaxError` out of the generator, at which point the two obvious repairs
// are `git checkout --ours` (right) and `rm` (wrong, and for a long time invisible).
//
// So the message names the right one and forbids the wrong one. And it REFUSES —
// it does not fall back to `{}`. Swallowing an unreadable manifest as "no previous
// manifest" is the same fail-open as deleting the file: every entry reads as new and
// nothing is compared to anything.
const CONFLICT_MARKER_RE = /^(<{7}|={7}|>{7})/m;

export function parseManifest(
  text: string,
  label: string
): Record<string, string> {
  try {
    return JSON.parse(text) as Record<string, string>;
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    if (CONFLICT_MARKER_RE.test(text)) {
      throw new Error(
        `${label} still has git CONFLICT MARKERS in it, so nothing can be read ` +
          `from it (${why}).\n` +
          `Resolve it with \`git checkout --ours -- ${MANIFEST_REL}\` and re-run ` +
          `the generator — it recomputes every entry from the bytes on disk, so ` +
          `either side is a fine starting point.\n` +
          `DO NOT DELETE IT. A missing manifest is not a clean slate; it is the ` +
          `one state in which nothing here has anything to compare against.`
      );
    }
    throw new Error(
      `${label} is not valid JSON (${why}).\n` +
        `Restore it with \`git checkout -- ${MANIFEST_REL}\` and re-run the ` +
        `generator. DO NOT DELETE IT — a missing manifest is not a clean slate.`
    );
  }
}

export function readManifest(
  manifestPath: string = MANIFEST_PATH
): Record<string, string> {
  const label = manifestPath === MANIFEST_PATH ? MANIFEST_REL : manifestPath;
  return parseManifest(fs.readFileSync(manifestPath, "utf8"), label);
}

// ---------------------------------------------------------------------------
// "ALREADY SHIPPED" IS A QUESTION FOR GIT, NOT FOR THE WORKING TREE.
//
// The refusal below asks "did an ALREADY-SHIPPED migration's bytes change?", and it
// used to answer that by diffing against the checked-in `manifest.json` — a file in
// the working tree, which anyone can delete. `rm lib/migrations/manifest.json &&
// npm run gen:migration-manifest` made every entry read as NEW, left `rehashed`
// empty, and wrote a manifest that blesses an edited migration. Exit 0, no stderr,
// the whole immutability suite green, and a tree byte-identical to the one
// `--allow-rehash` produces — so the committed diff could not tell a sanctioned
// rehash from a laundered one, and `rm` was the quieter of the two.
//
// The reference is therefore the manifest AS OF THE MERGE-BASE WITH origin/main:
// the hashes that are actually on main, which no working-tree operation can move.
// That fixes the other half too. A migration your own branch introduced is not in
// the merge-base manifest, so editing it after a review comment is an ordinary
// `added` and the refusal stays quiet — where before, the refusal's first genuine
// firing was on the commonest legitimate operation there is, and every sentence it
// printed was false. A guard that fires on the ordinary case is a guard that gets a
// flag typed in front of it by reflex.
//
// WHEN GIT CANNOT ANSWER, THIS REFUSES. It never degrades to "no shipped hashes,
// allow everything" — that is exactly the hole above, reopened by a fallback. The
// two `{}` answers below are the two cases where git POSITIVELY says nothing has
// shipped (no commits at all; no manifest at the base), not cases where it was not
// asked.

/** The refs consulted, in order, for "what is on main". */
const BASE_REFS = ["origin/main", "main"] as const;

export interface ShippedReference {
  /** file -> sha-256, as of the base commit. Empty only when git says so. */
  manifest: Record<string, string>;
  /** One line naming where these hashes came from. Printed in the report. */
  source: string;
}

function git(
  args: readonly string[],
  cwd: string
): { ok: boolean; stdout: string; stderr: string } {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (run.error) {
    return { ok: false, stdout: "", stderr: run.error.message };
  }
  return {
    ok: run.status === 0,
    stdout: run.stdout ?? "",
    stderr: (run.stderr ?? "").trim(),
  };
}

const CANNOT_READ =
  `Cannot determine which migrations have already SHIPPED, so this refuses ` +
  `rather than assume none have`;

export function resolveShippedReference(options?: {
  repoRoot?: string;
  manifestRel?: string;
  baseRefs?: readonly string[];
}): ShippedReference {
  const cwd = options?.repoRoot ?? REPO;
  const rel = options?.manifestRel ?? MANIFEST_REL;
  const refs = options?.baseRefs ?? BASE_REFS;

  if (!git(["rev-parse", "--git-dir"], cwd).ok) {
    throw new Error(
      `${CANNOT_READ}: \`git\` could not read a repository at ${cwd}. The shipped ` +
        `hashes are read from git (the manifest as of the merge-base with ` +
        `origin/main), because a reference in the working tree is a reference the ` +
        `edit being checked can delete.`
    );
  }

  // No commits at all: nothing CAN have shipped. This is git answering, not git
  // being unavailable — the distinction the whole refusal rests on.
  if (!git(["rev-parse", "--verify", "--quiet", "HEAD"], cwd).ok) {
    return { manifest: {}, source: "no commits yet — nothing has shipped" };
  }

  let base: string | undefined;
  let via = "";
  for (const ref of refs) {
    if (!git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd).ok) {
      continue;
    }
    const mergeBase = git(["merge-base", ref, "HEAD"], cwd);
    if (mergeBase.ok && mergeBase.stdout.trim()) {
      base = mergeBase.stdout.trim();
      via = `the merge-base with ${ref}`;
    } else {
      // Unrelated histories. `ref` itself is still a commit whose migrations
      // demonstrably shipped, and over-refusing is the safe direction.
      base = ref;
      via = `${ref} itself — it has no merge-base with HEAD`;
    }
    break;
  }
  if (!base) {
    throw new Error(
      `${CANNOT_READ}: none of ${refs.join(", ")} resolves in this checkout, so ` +
        `there is no commit to read the shipped manifest from. Run ` +
        `\`git fetch origin main\` (in CI, check out with enough history for a ` +
        `merge-base) and try again.`
    );
  }

  const shortBase =
    git(["rev-parse", "--short", base], cwd).stdout.trim() || base;

  // ls-tree rather than matching git's "does not exist" wording on stderr: an
  // absent path is empty stdout and exit 0, which separates "not there" from
  // "could not ask" without parsing prose.
  const listed = git(["ls-tree", "--name-only", base, "--", rel], cwd);
  if (!listed.ok) {
    throw new Error(
      `${CANNOT_READ}: \`git ls-tree ${base} -- ${rel}\` failed: ${listed.stderr}`
    );
  }
  if (listed.stdout.trim() === "") {
    return {
      manifest: {},
      source: `${rel} did not exist at ${shortBase} (${via}) — nothing has shipped`,
    };
  }

  const blob = git(["show", `${base}:${rel}`], cwd);
  if (!blob.ok) {
    throw new Error(
      `${CANNOT_READ}: \`git show ${base}:${rel}\` failed: ${blob.stderr}`
    );
  }
  return {
    manifest: parseManifest(blob.stdout, `${rel} as of ${shortBase}`),
    source: `${rel} as of ${shortBase} (${via})`,
  };
}

// ---------------------------------------------------------------------------
// ONE RUN OF THE GENERATOR, so its REFUSAL is behavior a test can drive.
//
// The refusal used not to be a refusal. The script detected an already-shipped
// migration whose bytes had changed, printed a warning saying that rewriting the
// manifest "would only make the edit invisible" — and then wrote it anyway and
// exited 0, which made the edit invisible. `--check` could not catch it either:
// once the manifest had been rewritten the file WAS what the bytes produce.
//
// That matters because the docs now send people here mid-conflict
// (lib/migrations/AGENTS.md, docs/orchestration/review-merge.md). A conflict
// resolved by editing the wrong side used to leave the manifest mismatched and CI
// red — a loud accident. A one-command remedy that rehashes turns the same
// accident into a fresh, correct-looking hash, with the only signal a warning in
// stdout that a mid-conflict reader is not reading.
//
// So: a rehash REFUSES and exits non-zero, in both modes. "Rehash" is measured
// against GIT (`resolveShippedReference`), not against the checked-in file — see
// that function for why, and for what `rm manifest.json` used to buy.
//
// Two consequences worth stating, because the first version of this refusal got
// both wrong. A migration THIS BRANCH introduced is not on main, so editing it
// after a review comment is an `added`, not a rehash, and nothing fires: the
// commonest legitimate operation stays one command. And the checked-in manifest
// simply holding a stale or hand-typed hash is not a rehash either — the bytes
// agree with main, so the generator just writes the correction.
//
// What is left for `--allow-rehash` is the narrow case where MAIN is wrong about
// a file. It keeps its name because a refusal with no door is routed around
// within the hour — but it is now the rare door it always claimed to be, rather
// than the one every branch has to type.
//
// It lives here rather than in the script body because a script body cannot be
// tested, and the refusal is the part most worth testing.

export interface GenerateManifestOptions {
  versionsDir?: string;
  registryPath?: string;
  manifestPath?: string;
  /** Where to ask git what has shipped. Defaults to this repo. */
  repoRoot?: string;
  /**
   * The shipped hashes, if the caller already has them. Omitted, they are read
   * from git (`resolveShippedReference`) — NEVER from the working-tree manifest,
   * which is the file the edit being checked can delete.
   */
  shipped?: ShippedReference;
  /** Verify only: report what a write would do, and never write. */
  check?: boolean;
  /**
   * Move released history on purpose — rewrite an already-shipped hash, or drop
   * an already-shipped migration. Honoured in write mode only: `--check` reports
   * the tree as it is, and both of those are things it exists to report.
   */
  allowRehash?: boolean;
}

export interface GenerateManifestResult {
  manifest: Record<string, string>;
  /** Keys the manifest gained, i.e. the ordinary "a migration was added" case. */
  added: string[];
  /** Keys the checked-in manifest has that the tree no longer does. */
  removed: string[];
  /**
   * Keys whose hash moved against the CHECKED-IN manifest. Ordinary on a branch —
   * it is what editing a migration you yourself added looks like. `rehashed` is
   * the subset that is also on main, and that one is the alarm.
   */
  edited: string[];
  /**
   * Entries that are on main AND hash differently now. The alarm — measured
   * against `shipped`, so deleting the working-tree manifest does not empty it.
   */
  rehashed: string[];
  /**
   * Entries that are on main and are GONE here. The other half of the same
   * alarm: `rehashed` only ranges over files this tree still has, so a shipped
   * migration deleted outright fell through it entirely.
   */
  unshipped: string[];
  unchanged: number;
  /** Where the shipped hashes came from, for the report and for review. */
  shipped: ShippedReference;
  /** What the caller prints to stdout. */
  report: string;
  /** What the caller prints to stderr, when there is something to say. */
  error?: string;
  wrote: boolean;
  exitCode: 0 | 1;
}

export function generateManifest(
  options: GenerateManifestOptions = {}
): GenerateManifestResult {
  const manifestPath = options.manifestPath ?? MANIFEST_PATH;
  const rel = manifestPath === MANIFEST_PATH ? MANIFEST_REL : manifestPath;

  const manifest = buildManifest({
    versionsDir: options.versionsDir,
    registryPath: options.registryPath,
  });
  const next = serializeManifest(manifest);
  const exists = fs.existsSync(manifestPath);
  const previous = exists ? readManifest(manifestPath) : {};
  const current = exists ? fs.readFileSync(manifestPath, "utf8") : "";

  // TWO BASELINES, AND THEY ANSWER DIFFERENT QUESTIONS.
  //
  // The working-tree manifest answers "what does this write CHANGE?" — the
  // added/dropped/unchanged lines, which are what a merge wants to read.
  //
  // The shipped reference answers "is this an edit to RELEASED history?" — and
  // that one cannot come from the working tree, because the working tree is what
  // the edit is in.
  const shipped =
    options.shipped ?? resolveShippedReference({ repoRoot: options.repoRoot });

  const added = Object.keys(manifest).filter((f) => !(f in previous));
  const removed = Object.keys(previous).filter((f) => !(f in manifest));
  const edited = Object.keys(manifest).filter(
    (f) => f in previous && previous[f] !== manifest[f]
  );
  const rehashed = Object.keys(manifest).filter(
    (f) => f in shipped.manifest && shipped.manifest[f] !== manifest[f]
  );
  // DELETING A SHIPPED MIGRATION IS NOT A MILDER VERSION OF EDITING ONE.
  //
  // `rehashed` ranges over the files this tree HAS, so a shipped migration removed
  // outright — file deleted, registry entry deleted — produced `dropped: 1`,
  // `REHASHED: 0`, a written manifest and exit 0. Measured on this repo's tree:
  // the whole immutability suite stayed green on it, because the manifest and
  // versions/ still agreed with each other. They had simply both forgotten.
  //
  // A database that already applied it keeps the schema the migration made and the
  // applied row naming it; a fresh one now gets neither. That is the two-schemas
  // outcome the append-only rule exists to prevent, reached from the other side,
  // so it refuses through the same door.
  const unshipped = Object.keys(shipped.manifest).filter(
    (f) => !(f in manifest)
  );
  const unchanged = Object.keys(manifest).length - added.length - edited.length;

  // The first four lines PARTITION the tree against the checked-in manifest —
  // unchanged + new + edited is the total — so a file cannot fall between them
  // the way it did when "unchanged" was quietly netted against the alarm. The two
  // UPPERCASE lines are not part of that partition: they are the same tree
  // measured against MAIN, in both directions — a shipped file whose hash moved,
  // and a shipped file that is not here at all — and they print last, next to the
  // line naming where main's hashes were read.
  const list = (files: readonly string[]) =>
    files.length ? ` (${files.join(", ")})` : "";
  const report = [
    `${Object.keys(manifest).length} migrations hashed from disk, in registry order.`,
    `  unchanged: ${unchanged}`,
    `  new:       ${added.length}${list(added)}`,
    `  edited:    ${edited.length}${list(edited)}`,
    `  dropped:   ${removed.length}${list(removed)}`,
    `  REHASHED:  ${rehashed.length}${list(rehashed)}`,
    `  GONE:      ${unshipped.length}${list(unshipped)}`,
    `Shipped hashes read from ${shipped.source} — REHASHED and GONE are the ` +
      `two lines measured against it.`,
  ].join("\n");

  const base = {
    manifest,
    added,
    removed,
    edited,
    rehashed,
    unshipped,
    unchanged,
    shipped,
    report,
  };

  // A SHIPPED MIGRATION THAT MOVED OR VANISHED IS THE ALARM, not a routine
  // outcome. Shipped migrations are append-only, so a file whose bytes changed is
  // either an edit to released history or a conflict resolved by editing the wrong
  // side — and a file that is GONE is the same edit with the evidence taken away.
  if (
    (rehashed.length > 0 || unshipped.length > 0) &&
    !(options.allowRehash && !options.check)
  ) {
    const door = options.check
      ? `\`--allow-rehash\` records one of these on purpose, but it is a WRITING ` +
        `flag: --check reports the tree as it is, and a rehashed entry is one of ` +
        `the things it exists to report. A tree where a shipped migration was ` +
        `edited AND the manifest regenerated is not up to date.`
      : `\`npm run gen:migration-manifest -- --allow-rehash\` records it anyway, ` +
        `for the one case where main itself is wrong about these files. It is not ` +
        `the remedy for "I need to change this migration" — that is a new ` +
        `migration.`;
    const clauses: string[] = [];
    if (rehashed.length > 0) {
      clauses.push(
        `${rehashed.length} migration(s) already on main hash differently here:` +
          `\n  ${rehashed.join("\n  ")}`
      );
    }
    if (unshipped.length > 0) {
      clauses.push(
        `${unshipped.length} migration(s) on main are GONE from this tree:` +
          `\n  ${unshipped.join("\n  ")}`
      );
    }
    const headline = options.check
      ? `\n${rel} FAILS: `
      : `\nREFUSING to write ${rel}: `;
    const consequence =
      unshipped.length > 0
        ? `Migrations that have landed are APPEND-ONLY, in both directions. A ` +
          `database that already ran one will never run it again, so an edit ` +
          `reaches only the databases that have not — and a DELETION reaches none ` +
          `of them: every database that applied it keeps the schema it made and ` +
          `the applied row naming it, while every fresh one is now built without ` +
          `either. Restore those files and append a corrective migration.`
        : `Migrations that have landed are APPEND-ONLY: a database that already ` +
          `ran one will never run it again, so an edit reaches only the databases ` +
          `that have not. Revert those files and append a corrective migration.`;
    return {
      ...base,
      error:
        `${headline}${clauses.join("\n")}\n` +
        `Shipped hashes read from ${shipped.source}, which is why deleting ` +
        `${rel} does not make this go away.\n` +
        `${consequence}\n${door}`,
      wrote: false,
      exitCode: 1,
    };
  }

  if (options.check) {
    if (current === next) {
      return {
        ...base,
        report: `${report}\n\n${rel} is up to date.`,
        wrote: false,
        exitCode: 0,
      };
    }
    return {
      ...base,
      error:
        `\n${rel} is NOT what the bytes on disk produce. Run ` +
        `\`npm run gen:migration-manifest\` and commit the result.`,
      wrote: false,
      exitCode: 1,
    };
  }

  if (current === next) {
    return {
      ...base,
      report: `${report}\n\n${rel} already up to date — nothing written.`,
      wrote: false,
      exitCode: 0,
    };
  }

  fs.writeFileSync(manifestPath, next, "utf8");
  return {
    ...base,
    report: `${report}\n\nWrote ${rel}.`,
    // Said on stderr even though the run succeeded: --allow-rehash moves released
    // history, and the diff line is the whole claim.
    error:
      rehashed.length > 0 || unshipped.length > 0
        ? [
            rehashed.length > 0 &&
              `\n--allow-rehash: rewrote ${rehashed.length} hash(es) that are ` +
                `already on main, on purpose:\n  ${rehashed.join("\n  ")}`,
            unshipped.length > 0 &&
              `\n--allow-rehash: dropped ${unshipped.length} migration(s) that ` +
                `are on main, on purpose:\n  ${unshipped.join("\n  ")}`,
            `Reviewers: these migrations differ from ${shipped.source}. Every ` +
              `database that already ran them keeps the OLD behaviour, and a ` +
              `deleted one keeps both the schema it made and the applied row ` +
              `naming it while fresh databases get neither — so the diff has to ` +
              `be one that does not change what they did.`,
          ]
            .filter((line): line is string => typeof line === "string")
            .join("\n")
        : undefined,
    wrote: true,
    exitCode: 0,
  };
}

// ---------------------------------------------------------------------------
// THE COMMAND LINE, HERE RATHER THAN IN THE SCRIPT BODY, for the same reason the
// refusal is: a script body cannot be tested, and two of the defects this fixes
// were in argv handling and in what a thrown error looks like.
//
// `npm run gen:migration-manifest --check` — WITHOUT the `--` — is the invocation
// a nervous person reaches for, and npm swallows the flag: it never reaches
// `process.argv`, so the verify-only run WROTE. npm does put it in the
// environment as `npm_config_check`, so that is read too.
//
// The two flags are NOT treated alike, and the asymmetry is the point.
// `--check` is read from the environment because mis-reading it can only make the
// tool do LESS (check instead of write). `--allow-rehash` is not: it is the one
// door that lets released history's hash move, `npm_config_*` can also arrive
// from an .npmrc or an exported shell variable nobody typed today, and a door
// that opens from ambient state is not a decision anybody made. So an
// env-only `--allow-rehash` is refused, by name, pointing at the `--` form.

export interface ManifestCliResult {
  stdout: string;
  stderr?: string;
  exitCode: 0 | 1;
}

/** npm writes "true"/"false"; anything else came from a person and counts. */
const npmFlag = (value: string | undefined): boolean =>
  value !== undefined && value !== "" && value !== "false";

export function runManifestCli(invocation: {
  argv: readonly string[];
  env?: Record<string, string | undefined>;
}): ManifestCliResult {
  const argv = invocation.argv;
  const env = invocation.env ?? {};

  if (
    !argv.includes("--allow-rehash") &&
    npmFlag(env.npm_config_allow_rehash)
  ) {
    return {
      stdout: "",
      stderr:
        `\n--allow-rehash reached this run through npm's environment rather ` +
        `than the command line, and this is the one flag that is not accepted ` +
        `that way: it moves a hash that is already on main.\n` +
        `Type it where it is visible: ` +
        `\`npm run gen:migration-manifest -- --allow-rehash\`.`,
      exitCode: 1,
    };
  }

  const options: GenerateManifestOptions = {
    check: argv.includes("--check") || npmFlag(env.npm_config_check),
    allowRehash: argv.includes("--allow-rehash"),
  };

  let result: GenerateManifestResult;
  try {
    result = generateManifest(options);
  } catch (error) {
    // buildManifest's registry/disk refusal, readManifest's conflict-marker
    // refusal and resolveShippedReference's "git could not answer" all arrive
    // here. Each already carries the whole remedy in its message; a stack trace
    // on top of it buries the one line the reader needs.
    return {
      stdout: "",
      stderr: `\n${error instanceof Error ? error.message : String(error)}`,
      exitCode: 1,
    };
  }
  return {
    stdout: result.report,
    stderr: result.error,
    exitCode: result.exitCode,
  };
}
