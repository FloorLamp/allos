import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ONE SPELLING OF THE MANIFEST ALGORITHM, TWO READERS (#3579).
//
// `manifest.json` holds a sha-256 per shipped migration file, and its whole job is
// to prove nobody edited a migration after it shipped. It had a READER
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

export function readManifest(
  manifestPath: string = MANIFEST_PATH
): Record<string, string> {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<
    string,
    string
  >;
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
// So: a rehash REFUSES and exits non-zero, in both modes. The one legitimate
// rehash — the manifest entry is the wrong side and the bytes on disk are the
// shipped ones — gets a door with a name, `--allow-rehash`, because a refusal
// with no door is routed around within the hour and a named flag is a decision
// somebody has to type into a diff.
//
// It lives here rather than in the script body because a script body cannot be
// tested, and the refusal is the part most worth testing.

export interface GenerateManifestOptions {
  versionsDir?: string;
  registryPath?: string;
  manifestPath?: string;
  /** Verify only: report what a write would do, and never write. */
  check?: boolean;
  /**
   * Rewrite an already-shipped hash on purpose. Honoured in write mode only —
   * `--check` reports the tree as it is, and a rehash is one of the things it
   * exists to report.
   */
  allowRehash?: boolean;
}

export interface GenerateManifestResult {
  manifest: Record<string, string>;
  /** Keys the manifest gained, i.e. the ordinary "a migration was added" case. */
  added: string[];
  /** Keys the checked-in manifest has that the tree no longer does. */
  removed: string[];
  /** ALREADY-SHIPPED entries whose bytes hash differently. The alarm. */
  rehashed: string[];
  unchanged: number;
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

  const added = Object.keys(manifest).filter((f) => !(f in previous));
  const removed = Object.keys(previous).filter((f) => !(f in manifest));
  const rehashed = Object.keys(manifest).filter(
    (f) => f in previous && previous[f] !== manifest[f]
  );
  const unchanged =
    Object.keys(manifest).length - added.length - rehashed.length;

  const report = [
    `${Object.keys(manifest).length} migrations hashed from disk, in registry order.`,
    `  unchanged: ${unchanged}`,
    `  new:       ${added.length}${added.length ? ` (${added.join(", ")})` : ""}`,
    `  REHASHED:  ${rehashed.length}${rehashed.length ? ` (${rehashed.join(", ")})` : ""}`,
    `  dropped:   ${removed.length}${removed.length ? ` (${removed.join(", ")})` : ""}`,
  ].join("\n");

  const base = {
    manifest,
    added,
    removed,
    rehashed,
    unchanged,
    report,
  };

  // A REHASHED ENTRY IS THE ALARM, not a routine outcome. Shipped migrations are
  // append-only, so a file whose bytes changed is either an edit to released
  // history or a conflict resolved by editing the wrong side.
  if (rehashed.length > 0 && !(options.allowRehash && !options.check)) {
    const door = options.check
      ? `\`--allow-rehash\` writes one of these on purpose, but it is a WRITING ` +
        `flag: --check reports the tree as it is, and a rehashed entry is one of ` +
        `the things it exists to report. A tree where a shipped migration was ` +
        `edited AND the manifest regenerated is not up to date.`
      : `If the bytes on disk are the SHIPPED ones and the manifest holds the wrong ` +
        `side — you restored a file to what it shipped as, or a bad hash was ` +
        `committed — re-run with \`npm run gen:migration-manifest -- --allow-rehash\` ` +
        `to record that on purpose. Nothing else should use it.`;
    const headline = options.check
      ? `\n${rel} FAILS: ${rehashed.length} ALREADY-SHIPPED migration(s) hash ` +
        `differently than the checked-in manifest:`
      : `\nREFUSING to write ${rel}: ${rehashed.length} ALREADY-SHIPPED ` +
        `migration(s) hash differently than the checked-in manifest:`;
    return {
      ...base,
      error:
        `${headline}\n  ` +
        `${rehashed.join("\n  ")}\n` +
        `Shipped migrations are APPEND-ONLY. Revert those files and append a ` +
        `corrective migration instead — rewriting the manifest here would only ` +
        `make the edit invisible.\n${door}`,
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
    // Said on stderr even though the run succeeded: --allow-rehash rewrites
    // released history's hash, and the diff line is the whole claim.
    error:
      rehashed.length > 0
        ? `\n--allow-rehash: rewrote ${rehashed.length} ALREADY-SHIPPED hash(es) ` +
          `on purpose:\n  ${rehashed.join("\n  ")}\n` +
          `Reviewers: check those files are back to their shipped bytes, not ` +
          `carrying new work.`
        : undefined,
    wrote: true,
    exitCode: 0,
  };
}
