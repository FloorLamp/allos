// The one spelling of what lib/migrations/manifest.json contains (issue #3579).
//
// The manifest proves no shipped migration was edited, so the hash, the file set
// and the index.ts exclusion must exist ONCE: lib/__tests__/migration-immutability.test.ts
// checks the committed file against these functions, and `npm run gen:migration-manifest`
// (scripts/gen-migration-manifest.ts) writes it with the same ones. A generator
// that re-spelled sha256 would be a second source of truth for the exact thing
// the guard checks.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const VERSIONS_DIR = path.join(REPO, "lib/migrations/versions");
const MANIFEST_IN_REPO = "lib/migrations/manifest.json";
export const MANIFEST_PATH = path.join(REPO, MANIFEST_IN_REPO);

// index.ts is the registry, not a migration: it is edited on every append, so it
// is not frozen and carries no manifest entry.
export function migrationFiles(): string[] {
  return fs
    .readdirSync(VERSIONS_DIR)
    .filter((f) => f.endsWith(".ts") && f !== "index.ts")
    .sort();
}

export function hashMigration(file: string): string {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(VERSIONS_DIR, file)))
    .digest("hex");
}

export function readManifest(): Record<string, string> {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as Record<
    string,
    string
  >;
}

/**
 * The manifest as HEAD carries it, or null when HEAD carries none.
 *
 * The generator compares against THIS, not against `readManifest()`. The working
 * tree copy is not a record of what shipped: mid-merge it holds conflict markers
 * and does not parse at all — the exact case the generator is documented for —
 * and any entry a botched resolution drops from it makes an already-shipped
 * migration look brand new, so its edited hash gets adopted at exit 0. HEAD
 * always parses and always holds every shipped key.
 */
export function readCommittedManifest(): Record<string, string> | null {
  const git = (...args: string[]) =>
    spawnSync("git", args, { cwd: REPO, encoding: "utf8" });
  // Two calls, because `git show` failing on its own is ambiguous: it means
  // EITHER "HEAD carries no manifest" — a repo before the first one is committed,
  // where nothing has shipped and there is nothing to freeze — OR "git could not
  // answer". Reading the second as an empty manifest would silently switch the
  // refusal off, so rev-parse settles which one it is first.
  const head = git("rev-parse", "--verify", "--quiet", "HEAD");
  if (head.error) throw head.error;
  if (head.status !== 0) return null;
  const show = git("show", `HEAD:${MANIFEST_IN_REPO}`);
  return show.status === 0
    ? (JSON.parse(show.stdout) as Record<string, string>)
    : null;
}

/** Every migration file on disk, hashed, keyed by filename. */
export function hashMigrations(): Record<string, string> {
  return Object.fromEntries(migrationFiles().map((f) => [f, hashMigration(f)]));
}

export interface ManifestPlan {
  /** The manifest to write, in key order. */
  next: Record<string, string>;
  /** Files with no entry yet — a new migration. */
  added: string[];
  /** Entries with no file. */
  removed: string[];
  /**
   * Entries whose file hashes differently than the committed manifest says: a
   * SHIPPED migration was edited. The generator refuses on this rather than
   * writing the new hash, because writing it is precisely the laundering the
   * manifest exists to prevent.
   */
  changed: string[];
}

// Key order is preserved and new entries are appended, never re-sorted: the
// committed order is registry order, and emitting sorted keys turns a one-line
// append into a 30-line diff (#3579). Appended keys are in FILENAME order, which
// is registry order only when one migration arrives at a time — a two-migration
// merge diverges from versions/index.ts. Nothing reads manifest order, so the
// writer does not carry ordering machinery to close that gap.
export function planManifest(
  previous: Record<string, string>,
  current: Record<string, string>
): ManifestPlan {
  const kept = Object.keys(previous).filter((f) => f in current);
  const added = Object.keys(current).filter((f) => !(f in previous));
  return {
    next: Object.fromEntries(
      [...kept, ...added].map((f) => [f, current[f]] as const)
    ),
    added,
    removed: Object.keys(previous).filter((f) => !(f in current)),
    changed: kept.filter((f) => previous[f] !== current[f]),
  };
}

export function serializeManifest(manifest: Record<string, string>): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * The generator: `npm run gen:migration-manifest`. Returns a process exit code.
 *
 * It lives here rather than in scripts/gen-migration-manifest.ts so the refusal
 * can be executed by a test — that script is an entry point, and a refusal
 * nothing can run is a refusal nothing checks (#3824 review). `current` is a
 * parameter for the same reason: the hashes are the only thing the writer reads
 * from disk, so injecting them is the whole seam a test needs.
 */
export function main(
  current: Record<string, string> = hashMigrations()
): number {
  const committed = readCommittedManifest();
  const plan = planManifest(committed ?? {}, current);

  // "SHIPPED" HERE MEANS "HEAD CARRIES THIS MANIFEST ENTRY", which on a feature branch is
  // your OWN commit — so this cannot tell a migration you committed an hour ago from one
  // that ran on somebody's instance in April, and it refuses both. That is the right
  // direction to be wrong in, but it costs an hour if you meet it without knowing.
  // `git show origin/main:<file>` (empty ⇒ never merged, so nothing has ever run it) is
  // what tells the two apart. For a migration that is genuinely still unmerged, the route
  // is to commit the entry's REMOVAL and then regenerate — it is then `added`, not
  // `changed`. Do that only with the origin/main check in hand and recorded.
  if (plan.changed.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `REFUSING to write ${MANIFEST_IN_REPO}: ${plan.changed.length} ` +
        `SHIPPED migration(s) hash differently than the committed manifest:\n` +
        plan.changed.map((f) => `  ${f}`).join("\n") +
        `\n\nShipped migrations are APPEND-ONLY. Restore the file(s) and append a ` +
        `corrective migration instead. Writing these hashes would launder the edit ` +
        `the manifest exists to catch.`
    );
    return 1;
  }

  // An entry HEAD carries with no file behind it is a shipped migration that was
  // deleted or renamed. Migrations are append-only, so that is always a violation
  // — and dropping the entry is how a rename smuggles an edit past the
  // immutability guard, which only checks the files that are still there.
  if (plan.removed.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `REFUSING to write ${MANIFEST_IN_REPO}: ${plan.removed.length} ` +
        `SHIPPED migration(s) in the committed manifest have no file:\n` +
        plan.removed.map((f) => `  ${f}`).join("\n") +
        `\n\nShipped migrations are APPEND-ONLY — they are never deleted or ` +
        `renamed. Restore the file name(s); a rename that dropped its entry ` +
        `would carry any edit past the immutability guard.`
    );
    return 1;
  }

  const next = serializeManifest(plan.next);
  const onDisk = fs.existsSync(MANIFEST_PATH)
    ? fs.readFileSync(MANIFEST_PATH, "utf8")
    : null;
  fs.writeFileSync(MANIFEST_PATH, next);

  const count = Object.keys(plan.next).length;
  // eslint-disable-next-line no-console
  console.log(
    [
      // Said out loud, because it is the one state where the generator freezes
      // nothing: with no committed manifest to compare against, every hash is
      // simply adopted.
      committed === null
        ? `no manifest in HEAD — writing the first one; nothing is frozen yet`
        : null,
      ...plan.added.map((f) => `added entry: ${f}`),
      onDisk === next
        ? `${MANIFEST_IN_REPO} already current (${count} hashes recomputed)`
        : `wrote ${MANIFEST_IN_REPO} (${count} entries)`,
    ]
      .filter((line) => line !== null)
      .join("\n")
  );
  return 0;
}
