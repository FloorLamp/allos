import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// Immutability guard for shipped migrations (issue #119). A shipped migration file
// is APPEND-ONLY: once released it is frozen, and a bug is fixed by appending a
// corrective migration, never by editing history (an edit would silently change
// the schema not-yet-stamped DBs receive). This recomputes the sha-256 of each
// `versions/NNN-*.ts` file and compares it to the checked-in manifest; a mismatch
// fails CI with "shipped migrations are append-only — add a NEW migration". Adding
// a migration requires adding its hash line in the SAME diff, so review sees both.
//
// Pure (reads source as bytes, no DB/network), so it lives in the unit tier — the
// same way the phi-scan / profile-scoping tests read the repo's own source.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const VERSIONS_DIR = path.join(REPO, "lib/migrations/versions");
const MANIFEST = path.join(REPO, "lib/migrations/manifest.json");

// The numbered migration files (001-baseline.ts, 002-*.ts, …). index.ts is NOT
// frozen — it is edited to append each new migration — so it is excluded.
function migrationFiles(): string[] {
  return fs
    .readdirSync(VERSIONS_DIR)
    .filter((f) => /^\d{3}-.*\.ts$/.test(f))
    .sort();
}

function sha256(file: string): string {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(VERSIONS_DIR, file)))
    .digest("hex");
}

describe("migration immutability — hash manifest", () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as Record<
    string,
    string
  >;
  const files = migrationFiles();

  it("has at least the baseline migration", () => {
    expect(files).toContain("001-baseline.ts");
  });

  it("every shipped migration matches its manifest hash (append-only)", () => {
    for (const f of files) {
      expect(
        sha256(f),
        `${f} has changed since it was committed. Shipped migrations are ` +
          `APPEND-ONLY — do not edit a released migration; append a NEW ` +
          `corrective migration instead. If this is a brand-new migration, add ` +
          `its hash to lib/migrations/manifest.json in the same change.`
      ).toBe(manifest[f]);
    }
  });

  it("manifest and versions/ are in exact correspondence (no stale or missing entries)", () => {
    expect(Object.keys(manifest).sort()).toEqual(files);
  });
});
