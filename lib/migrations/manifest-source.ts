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
// from — filename sort is NOT the same list (`20260813-encounter-diagnosis-ranks`
// already sits two positions off its import order on main, which is how we know
// nothing was enforcing this).
//
// Text, not import: this must be readable by a script that refuses a tree where
// index.ts and versions/ disagree, and an import of a registry naming a file that
// does not exist throws before it can say so.
const IMPORT_RE =
  /^import\s*\{\s*migration\s+as\s+(\w+)\s*\}\s*from\s*"\.\/([^"]+)";/gm;
const ARRAY_RE = /export const MIGRATIONS:\s*Migration\[\]\s*=\s*\[([^\]]*)\]/m;

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
  const aliases = array[1]
    .split(",")
    .map((entry) => entry.replace(/\/\/[^\n]*/g, "").trim())
    .filter((entry) => entry.length > 0);
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
