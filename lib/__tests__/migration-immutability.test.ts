import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { makeTmpDir } from "./tmp-dir";

import {
  LEGACY_FILE_RE,
  MANIFEST_PATH,
  MANIFEST_REL,
  NAMED_FILE_RE,
  REGISTRY_REL,
  buildManifest,
  migrationFilesOnDisk,
  readManifest,
  registryOrder,
  serializeManifest,
  sha256OfMigration,
} from "../migrations/manifest-source";

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
//
// THE ALGORITHM IS NOT SPELLED HERE (#3579). The hash, the file set, the exclusion
// of index.ts and the ordering all come from ../migrations/manifest-source, which
// is also what scripts/gen-migration-manifest.ts writes the file with. Before that
// module existed this test WAS the only spelling, and the manifest had no writer at
// all — so a migration conflict ended with a hash typed in by hand, in the file
// whose entire purpose is to prove a computation. Re-spelling sha-256 here would put
// the guard and its writer on two sources of truth for the one thing being checked,
// and they would drift on the first change to either.

describe("migration immutability — hash manifest", () => {
  const manifest = readManifest();
  const files = migrationFilesOnDisk();

  it("has at least the baseline migration", () => {
    expect(files).toContain("001-baseline.ts");
  });

  it("every shipped migration matches its manifest hash (append-only)", () => {
    for (const f of files) {
      expect(
        sha256OfMigration(f),
        `${f} has changed since it was committed. Shipped migrations are ` +
          `APPEND-ONLY — do not edit a released migration; append a NEW ` +
          `corrective migration instead. If this is a brand-new migration, run ` +
          `\`npm run gen:migration-manifest\` and commit the result.`
      ).toBe(manifest[f]);
    }
  });

  it("manifest and versions/ are in exact correspondence (no stale or missing entries)", () => {
    expect(Object.keys(manifest).sort()).toEqual(files);
  });

  // KEY ORDER IS REGISTRY ORDER, AND NOW SOMETHING ENFORCES IT (#3579).
  //
  // The correspondence assertion above sorts BOTH sides, so until this case existed
  // a manifest whose keys were in any order at all passed it. That is a fail-open
  // with a cost that shows up mid-merge: with order free-floating, regenerating the
  // file emits sorted keys and turns a one-line append into a whole-file re-sort,
  // and a re-sorted manifest is unreviewable exactly when review matters most —
  // during a migration conflict, which is when it gets rewritten.
  //
  // Registry order is NOT filename order, even though the two coincide today. A
  // migration dated 20260801 that merges after one dated 20260815 registers LAST and
  // sorts in the MIDDLE; the day that happens, sorting the manifest silently
  // disagrees with the array that decides what actually runs.
  it("keys the manifest in registry order, not merely in some order", () => {
    expect(
      Object.keys(manifest),
      `${MANIFEST_REL}'s keys are not in the order ${REGISTRY_REL} registers the ` +
        `migrations in. Run \`npm run gen:migration-manifest\` — do not hand-sort ` +
        `it, and do not "fix" this by re-sorting the registry, which would reorder ` +
        `the migrations themselves.`
    ).toEqual(registryOrder());
  });

  // THE WHOLE FILE, BYTE FOR BYTE, against what the writer produces. The cases above
  // each check one property; this one says the checked-in file IS the generator's
  // output, which is the property that makes hand-editing unnecessary. It also
  // refuses a tree where index.ts and versions/ disagree — `buildManifest` throws on
  // that, which is what a migration conflict resolved wrong looks like.
  it("is byte-identical to what `npm run gen:migration-manifest` writes", () => {
    expect(
      fs.readFileSync(MANIFEST_PATH, "utf8"),
      `${MANIFEST_REL} is not what hashing the tree produces. Run ` +
        `\`npm run gen:migration-manifest\` and commit the result; if that rewrites ` +
        `an ALREADY-SHIPPED entry it will say so, and that is an edit to released ` +
        `history rather than a stale manifest.`
    ).toBe(serializeManifest(buildManifest()));
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

// THE WRITER'S REFUSALS, over a corpus authored to break it (#3579).
//
// Everything above reads the REAL tree, which complies — so on its own it says
// nothing about what `buildManifest` can SEE. These build a throwaway versions/
// directory and registry and hand them to the same function the generator calls.
//
// The registry/disk disagreement is not a hypothetical: this script's whole reason
// to exist is being run mid-merge, and "a migration in index.ts that is not in
// versions/" is precisely what a migration conflict resolved wrong leaves behind.
describe("the manifest writer over a corpus authored to break it", () => {
  const corpus = (
    files: Record<string, string>,
    registered: readonly string[]
  ): { versionsDir: string; registryPath: string } => {
    const versionsDir = makeTmpDir("manifest-corpus");
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(versionsDir, name), body, "utf8");
    }
    const registryPath = path.join(versionsDir, "index.ts");
    const alias = (f: string) => `m${f.replace(/[^a-z0-9]/gi, "")}`;
    fs.writeFileSync(
      registryPath,
      [
        ...registered.map(
          (f) =>
            `import { migration as ${alias(f)} } from "./${f.replace(/\.ts$/, "")}";`
        ),
        "",
        "export const MIGRATIONS: Migration[] = [",
        ...registered.map((f) => `  ${alias(f)},`),
        "];",
        "",
      ].join("\n"),
      "utf8"
    );
    return { versionsDir, registryPath };
  };

  it("keys the manifest in REGISTRY order even when that is not filename order", () => {
    // The distinguishing corpus, and the reason the order case above is not just a
    // sort in disguise: a migration dated earlier that merged later registers LAST
    // and sorts FIRST. Today's tree cannot tell the two rules apart; this can.
    const { versionsDir, registryPath } = corpus(
      {
        "20260815-later-date.ts": "export const migration = 1;\n",
        "20260801-earlier-date.ts": "export const migration = 2;\n",
      },
      ["20260815-later-date.ts", "20260801-earlier-date.ts"]
    );
    const built = buildManifest({ versionsDir, registryPath });
    expect(Object.keys(built)).toEqual([
      "20260815-later-date.ts",
      "20260801-earlier-date.ts",
    ]);
    expect(Object.keys(built)).not.toEqual(Object.keys(built).sort());
    // And the hashes are the file bytes, not the names.
    expect(built["20260801-earlier-date.ts"]).toBe(
      createHash("sha256").update("export const migration = 2;\n").digest("hex")
    );
    fs.rmSync(versionsDir, { recursive: true, force: true });
  });

  it("refuses a migration registered in index.ts but absent from versions/", () => {
    const { versionsDir, registryPath } = corpus(
      { "20260801-present.ts": "export const migration = 1;\n" },
      ["20260801-present.ts", "20260802-lost-in-the-merge.ts"]
    );
    expect(() => buildManifest({ versionsDir, registryPath })).toThrow(
      /not present in versions\/: 20260802-lost-in-the-merge\.ts/
    );
    fs.rmSync(versionsDir, { recursive: true, force: true });
  });

  it("refuses a migration file that index.ts never registers", () => {
    const { versionsDir, registryPath } = corpus(
      {
        "20260801-present.ts": "export const migration = 1;\n",
        "20260802-unregistered.ts": "export const migration = 2;\n",
      },
      ["20260801-present.ts"]
    );
    expect(() => buildManifest({ versionsDir, registryPath })).toThrow(
      /not registered in .*index\.ts: 20260802-unregistered\.ts/
    );
    fs.rmSync(versionsDir, { recursive: true, force: true });
  });

  it("refuses a registry that lists the same migration twice", () => {
    // What "keep BOTH sides" looks like when it is done to the array without
    // noticing the entry was already there.
    const { versionsDir, registryPath } = corpus(
      { "20260801-present.ts": "export const migration = 1;\n" },
      ["20260801-present.ts", "20260801-present.ts"]
    );
    expect(() => buildManifest({ versionsDir, registryPath })).toThrow(
      /registered more than once: 20260801-present\.ts/
    );
    fs.rmSync(versionsDir, { recursive: true, force: true });
  });

  it("refuses a registry whose array entry has no import line", () => {
    const versionsDir = makeTmpDir("manifest-corpus");
    fs.writeFileSync(
      path.join(versionsDir, "20260801-present.ts"),
      "export const migration = 1;\n",
      "utf8"
    );
    const registryPath = path.join(versionsDir, "index.ts");
    fs.writeFileSync(
      registryPath,
      "export const MIGRATIONS: Migration[] = [\n  mOrphan,\n];\n",
      "utf8"
    );
    expect(() => buildManifest({ versionsDir, registryPath })).toThrow(
      /mOrphan.*with no matching/s
    );
    fs.rmSync(versionsDir, { recursive: true, force: true });
  });
});
