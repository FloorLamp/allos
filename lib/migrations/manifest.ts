// The one spelling of what lib/migrations/manifest.json contains (issue #3579).
//
// The manifest proves no shipped migration was edited, so the hash, the file set
// and the index.ts exclusion must exist ONCE: lib/__tests__/migration-immutability.test.ts
// checks the committed file against these functions, and `npm run gen:migration-manifest`
// (scripts/gen-migration-manifest.ts) writes it with the same ones. A generator
// that re-spelled sha256 would be a second source of truth for the exact thing
// the guard checks.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const VERSIONS_DIR = path.join(REPO, "lib/migrations/versions");
export const MANIFEST_PATH = path.join(REPO, "lib/migrations/manifest.json");

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

// Key order is preserved and new entries are appended, never re-sorted. The
// committed order is registry order, and emitting sorted keys turns a one-line
// append into a 30-line diff (#3579).
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
