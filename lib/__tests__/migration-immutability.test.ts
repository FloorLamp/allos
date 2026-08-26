import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import {
  hashMigration,
  hashMigrations,
  main,
  MANIFEST_PATH,
  migrationFiles,
  planManifest,
  readManifest,
  serializeManifest,
} from "../migrations/manifest";

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

// The file set, the hash and the index.ts exclusion come from
// lib/migrations/manifest.ts, so this guard and `npm run gen:migration-manifest`
// cannot disagree about what they are checking (#3579).

// Every migration file: the closed numbered era (001-baseline.ts … 185-*.ts) and
// the name-keyed era after it (YYYYMMDD-slug.ts).
const LEGACY_FILE_RE = /^\d{3}-[a-z0-9-]+\.ts$/;
const NAMED_FILE_RE = /^\d{8}-[a-z0-9-]+\.ts$/;

describe("migration immutability — hash manifest", () => {
  const manifest = readManifest();
  const files = migrationFiles();

  it("has at least the baseline migration", () => {
    expect(files).toContain("001-baseline.ts");
  });

  it("every shipped migration matches its manifest hash (append-only)", () => {
    for (const f of files) {
      expect(
        hashMigration(f),
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

describe("migration manifest generator (npm run gen:migration-manifest)", () => {
  it("reproduces the committed manifest byte for byte", () => {
    // Recomputing every hash from disk and getting the committed file back is the
    // whole claim the manifest makes: no shipped migration has moved. It also
    // pins the generator's output format, so running it never reformats the file.
    const plan = planManifest(readManifest(), hashMigrations());
    expect({
      added: plan.added,
      removed: plan.removed,
      changed: plan.changed,
    }).toEqual({ added: [], removed: [], changed: [] });
    expect(serializeManifest(plan.next)).toBe(
      fs.readFileSync(MANIFEST_PATH, "utf8")
    );
  });

  it("reports an edited shipped migration instead of adopting its new hash", () => {
    // What an edited shipped migration looks like to the generator: the file on
    // disk hashes differently than the entry that shipped with it. The planned
    // manifest holds the disk hash, so refusing on a non-empty `changed` is the
    // only thing between that edit and a clean-looking manifest.
    const current = hashMigrations();
    const committed = readManifest();
    const edited = "001-baseline.ts";
    const plan = planManifest(
      { ...committed, [edited]: "0".repeat(64) },
      current
    );
    expect(plan.changed).toEqual([edited]);
    expect(plan.added).toEqual([]);
    expect(plan.next[edited]).toBe(current[edited]);
  });
});

describe("migration manifest generator — the refusal, executed", () => {
  // The refusal is the whole point of the generator, and until this ran nothing
  // executed it: deleting the entire refusal block left the pure suite green, and
  // under that mutant an edited shipped migration writes at exit 0 (#3824 review).
  // So this drives `main()` — scripts/gen-migration-manifest.ts is `process.exit(
  // main())` — and asserts the code AND that the file on disk was not touched.
  //
  // Driven in-process rather than by spawning the script, because an end-to-end
  // spawn would have to edit a real shipped migration in the working tree: this
  // tier runs files in parallel against one checkout, so the guard above would red
  // on the neighbour's edit, and a failing run would leave the repo dirty.
  const BASELINE = "001-baseline.ts";
  const without = (hashes: Record<string, string>, file: string) =>
    Object.fromEntries(Object.entries(hashes).filter(([f]) => f !== file));

  it.each([
    [
      "a shipped migration was edited",
      (hashes: Record<string, string>) => ({
        ...hashes,
        [BASELINE]: "0".repeat(64),
      }),
    ],
    [
      "a shipped migration's file is gone",
      (hashes: Record<string, string>) => without(hashes, BASELINE),
    ],
    [
      "a shipped migration was renamed, which is an edit under cover",
      (hashes: Record<string, string>) => ({
        ...without(hashes, BASELINE),
        "001-baselines.ts": "0".repeat(64),
      }),
    ],
  ])("refuses and writes nothing when %s", (_case, corrupt) => {
    const committed = fs.readFileSync(MANIFEST_PATH, "utf8");
    const silenced = vi.spyOn(console, "error").mockImplementation(() => {});
    let code: number;
    let after: string;
    try {
      code = main(corrupt(hashMigrations()));
    } finally {
      after = fs.readFileSync(MANIFEST_PATH, "utf8");
      // If the refusal ever regresses, main() writes — to the REAL manifest, since
      // this suite runs against the repo itself. Put the committed bytes back
      // before the assertion below reports the regression.
      if (after !== committed) fs.writeFileSync(MANIFEST_PATH, committed);
      silenced.mockRestore();
    }
    expect({ code, wrote: after !== committed }).toEqual({
      code: 1,
      wrote: false,
    });
  });
});
