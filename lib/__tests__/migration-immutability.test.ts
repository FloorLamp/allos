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

// Every migration file: the closed numbered era (001-baseline.ts … 185-*.ts) and
// the name-keyed era after it (YYYYMMDD-slug.ts). index.ts is NOT frozen — it is
// edited to append each new migration — so it is excluded.
const LEGACY_FILE_RE = /^\d{3}-[a-z0-9-]+\.ts$/;
const NAMED_FILE_RE = /^\d{8}-[a-z0-9-]+\.ts$/;
function migrationFiles(): string[] {
  return fs
    .readdirSync(VERSIONS_DIR)
    .filter((f) => f.endsWith(".ts") && f !== "index.ts")
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

  it("every migration file uses one of the two era naming shapes", () => {
    // The numbered era is CLOSED at 185 (lib/migrations/runner.ts assertRegistry
    // refuses an id after a name-keyed migration); a new migration is
    // versions/YYYYMMDD-slug.ts with a unique slug and no number. A file matching
    // neither shape would be invisible to review conventions and ambiguous in the
    // ledger — refuse it here, at the cheapest tier.
    for (const f of files) {
      expect(
        LEGACY_FILE_RE.test(f) || NAMED_FILE_RE.test(f),
        `${f} matches neither the closed numbered era (NNN-slug.ts) nor the ` +
          `name-keyed era (YYYYMMDD-slug.ts). New migrations are date-slug ` +
          `named — see lib/migrations/runner.ts.`
      ).toBe(true);
    }
  });
});
