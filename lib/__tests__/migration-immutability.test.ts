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
  generateManifest,
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
/** Write a registry naming `registered`, in that order, at `registryPath`. */
const writeRegistry = (
  registryPath: string,
  registered: readonly string[]
): void => {
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
};

/**
 * A throwaway versions/ directory, its registry and a manifest path — NEVER the
 * live tree, which is what everything above reads.
 */
const corpus = (
  files: Record<string, string>,
  registered: readonly string[]
): { versionsDir: string; registryPath: string; manifestPath: string } => {
  const versionsDir = makeTmpDir("manifest-corpus");
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(versionsDir, name), body, "utf8");
  }
  const registryPath = path.join(versionsDir, "index.ts");
  writeRegistry(registryPath, registered);
  // Outside versions/ in the real tree; here it just has to not end in .ts, which
  // is what `migrationFilesOnDisk` selects on.
  return {
    versionsDir,
    registryPath,
    manifestPath: path.join(versionsDir, "manifest.json"),
  };
};

describe("the manifest writer over a corpus authored to break it", () => {
  it("keys the manifest in REGISTRY order even when that is not filename order", () => {
    // The distinguishing corpus, and the reason the order case above is not just a
    // sort in disguise: a migration dated earlier that merged later registers LAST
    // and sorts FIRST. The real tree does distinguish them today — 23 of its 219
    // migrations register at a position they do not sort at, measured 2026-08-23 —
    // but that is an accident of merge history and one re-sort away from being
    // untrue, whereas this corpus separates the two rules by construction.
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

  it("ignores a comment line inside the MIGRATIONS array", () => {
    // The registry is read as TEXT, and the entry shape is matched rather than
    // comments stripped (a hand-rolled stripper is its own defect class, #3595).
    // A comment between entries must not become a phantom migration — and if the
    // entry matcher ever misses a REAL entry, the disk correspondence check turns
    // that into a loud "present in versions/ but not registered" rather than a
    // silently short manifest.
    const versionsDir = makeTmpDir("manifest-corpus");
    fs.writeFileSync(
      path.join(versionsDir, "20260801-present.ts"),
      "export const migration = 1;\n",
      "utf8"
    );
    const registryPath = path.join(versionsDir, "index.ts");
    fs.writeFileSync(
      registryPath,
      [
        'import { migration as mPresent } from "./20260801-present";',
        "",
        "export const MIGRATIONS: Migration[] = [",
        "  // The name-keyed era starts here.",
        "  mPresent,",
        "];",
        "",
      ].join("\n"),
      "utf8"
    );
    expect(Object.keys(buildManifest({ versionsDir, registryPath }))).toEqual([
      "20260801-present.ts",
    ]);
    fs.rmSync(versionsDir, { recursive: true, force: true });
  });
});

// THE REFUSAL THAT KEEPS A LAUNDERED EDIT OUT OF A GREEN TREE (#3579).
//
// The generator used to DETECT a rehashed entry, print a warning saying that
// rewriting the manifest "would only make the edit invisible" — and then write it
// anyway and exit 0. After that write there is nothing left to detect: the manifest
// IS what the edited bytes produce, so `--check` is green and so is every case
// above. The docs send people here mid-conflict, so the one-command remedy for
// "keep both sides of index.ts" doubled as a one-command remedy for "I edited a
// shipped migration", and the only signal was a line of stdout.
//
// Which is why these cases assert THE BYTES ON DISK DID NOT MOVE, not merely that
// something was printed: a warning that precedes the write is exactly what was
// there before. Same corpus discipline as above — a throwaway versions/ directory
// and its own manifest, never the live tree.
describe("the generator refuses to launder an edit to a shipped migration", () => {
  const FIRST = "20260801-first.ts";
  const SECOND = "20260802-second.ts";
  const REGISTERED = [FIRST, SECOND];

  /** A corpus whose manifest is written and agrees with the bytes: shipped. */
  const shipped = () => {
    const c = corpus(
      {
        [FIRST]: "export const migration = 1;\n",
        [SECOND]: "export const migration = 2;\n",
      },
      REGISTERED
    );
    const seed = generateManifest(c);
    expect(seed.wrote).toBe(true);
    expect(seed.exitCode).toBe(0);
    return c;
  };

  const editShipped = (versionsDir: string) =>
    fs.appendFileSync(
      path.join(versionsDir, FIRST),
      "\n// laundered edit\n",
      "utf8"
    );

  it("refuses the write and exits non-zero when a shipped migration's bytes changed", () => {
    const c = shipped();
    const before = fs.readFileSync(c.manifestPath, "utf8");
    editShipped(c.versionsDir);

    const result = generateManifest(c);
    expect(result.rehashed).toEqual([FIRST]);
    expect(result.wrote).toBe(false);
    expect(result.exitCode).toBe(1);

    // The manifest still holds the SHIPPED hash, so the immutability guard above
    // is still red on this tree. That is the whole point: the accident stays loud.
    expect(fs.readFileSync(c.manifestPath, "utf8")).toBe(before);
    expect(readManifest(c.manifestPath)[FIRST]).not.toBe(
      sha256OfMigration(FIRST, c.versionsDir)
    );
    fs.rmSync(c.versionsDir, { recursive: true, force: true });
  });

  it("names the door in the refusal, so the legitimate case is not left guessing", () => {
    // A refusal with no door is routed around within the hour — by hand-editing
    // the manifest, which is the thing this file exists to make unnecessary.
    const c = shipped();
    editShipped(c.versionsDir);
    const result = generateManifest(c);
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("REFUSING to write");
    expect(result.error).toContain("--allow-rehash");
    expect(result.error).toContain(FIRST);
    fs.rmSync(c.versionsDir, { recursive: true, force: true });
  });

  it("--check exits non-zero on a rehash, and calls it an edit rather than a stale manifest", () => {
    const c = shipped();
    editShipped(c.versionsDir);
    const result = generateManifest({ ...c, check: true });
    expect(result.exitCode).toBe(1);
    expect(result.wrote).toBe(false);
    expect(result.error).toContain("ALREADY-SHIPPED");
    // NOT the stale-manifest advice. `--check` could always tell that the file
    // disagreed with the bytes; what it used to say was "run the generator and
    // commit the result", and following that advice was the laundering.
    expect(result.error).not.toContain("and commit the result");
    fs.rmSync(c.versionsDir, { recursive: true, force: true });
  });

  it("--check does not honour --allow-rehash: it reports the tree as it is", () => {
    const c = shipped();
    editShipped(c.versionsDir);
    const result = generateManifest({ ...c, check: true, allowRehash: true });
    expect(result.exitCode).toBe(1);
    expect(result.wrote).toBe(false);
    // And for the rehash reason, not incidentally because the file is also stale.
    expect(result.error).toContain("ALREADY-SHIPPED");
    fs.rmSync(c.versionsDir, { recursive: true, force: true });
  });

  it("--allow-rehash writes, and says on stderr exactly what it rewrote", () => {
    // The one legitimate rehash: the bytes on disk are the shipped ones and the
    // MANIFEST holds the wrong side. It is a decision somebody has to type, and it
    // leaves a line in the diff for review to argue with.
    const c = shipped();
    editShipped(c.versionsDir);
    const result = generateManifest({ ...c, allowRehash: true });
    expect(result.exitCode).toBe(0);
    expect(result.wrote).toBe(true);
    expect(result.rehashed).toEqual([FIRST]);
    expect(result.error).toContain("--allow-rehash: rewrote 1");
    expect(readManifest(c.manifestPath)[FIRST]).toBe(
      sha256OfMigration(FIRST, c.versionsDir)
    );
    fs.rmSync(c.versionsDir, { recursive: true, force: true });
  });

  it("does NOT refuse the ordinary append — a new migration is `added`, not `rehashed`", () => {
    // The case that must stay one command. A refusal that also fired here would be
    // turned off within a week, taking the real refusal with it.
    const c = shipped();
    const third = "20260803-third.ts";
    fs.writeFileSync(
      path.join(c.versionsDir, third),
      "export const migration = 3;\n",
      "utf8"
    );
    writeRegistry(c.registryPath, [...REGISTERED, third]);

    const result = generateManifest(c);
    expect(result.rehashed).toEqual([]);
    expect(result.added).toEqual([third]);
    expect(result.wrote).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.error).toBeUndefined();
    expect(Object.keys(readManifest(c.manifestPath))).toEqual([
      ...REGISTERED,
      third,
    ]);
    fs.rmSync(c.versionsDir, { recursive: true, force: true });
  });
});
