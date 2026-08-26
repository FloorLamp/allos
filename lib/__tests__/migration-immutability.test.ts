import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
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
  VERSIONS_DIR,
  buildManifest,
  generateManifest,
  migrationFilesOnDisk,
  parseManifest,
  readManifest,
  registryOrder,
  resolveShippedReference,
  runManifestCli,
  serializeManifest,
  sha256OfMigration,
} from "../migrations/manifest-source";
import { MIGRATIONS } from "../migrations/versions";
import type { ShippedReference } from "../migrations/manifest-source";

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

  // THE TEXT PARSE IS CHECKED AGAINST THE ARRAY THAT ACTUALLY RUNS.
  //
  // `registryOrder()` reads index.ts as TEXT, for a good reason (it must work on a
  // tree whose registry names a file that does not exist, where an import throws
  // before it can report). The safety argument written for it covered ONE
  // direction: an entry the matcher MISSES turns into a loud "present in versions/
  // but not registered" from `assertRegistryMatchesDisk`.
  //
  // It said nothing about the other direction, and the other direction is silent.
  // Block-comment one entry of the array while leaving its import in place — how
  // anyone would temporarily disable a migration — and `ENTRY_RE` still matches the
  // aliased line inside the comment. The text parse then reports 219 where
  // `MIGRATIONS` holds 218: the migration STOPS RUNNING on every fresh database,
  // the manifest still lists it, and the registry-order case above compares the
  // manifest to `registryOrder()`, so both are wrong in the same way and agree.
  // Measured before this case existed: the immutability suite, the db-tier runner
  // suite and eslint were all green on that tree.
  //
  // Comparing the parse to the IMPORTED array closes it, and makes the whole
  // text-parser class self-checking — any future divergence between what the
  // parser sees and what Node imports fails here, whatever caused it.
  //
  // THE COMPARISON GOES THROUGH THE MODULES, not through the filenames, because
  // a migration's `name` is NOT its filename: `044-episode-share-links.ts` is
  // named `043-episode-share-links` and `148-retire-run-milestones.ts` is named
  // `retire-run-milestones`. Both are shipped and neither can be renamed. So the
  // parse is resolved the same way Node resolves it — import each file the parser
  // named, in the order it named them, and ask each module what its migration is
  // called. That is a stronger statement than a filename comparison anyway: it
  // says the array holds exactly these modules in exactly this order.
  it("parses index.ts into exactly the array Node imports from it", async () => {
    const parsed = await Promise.all(
      registryOrder().map(async (file) => {
        const mod = (await import(
          /* @vite-ignore */ path.join(VERSIONS_DIR, file)
        )) as { migration: { name: string } };
        return mod.migration.name;
      })
    );
    expect(
      parsed,
      `${REGISTRY_REL} reads as one list of migrations when parsed as TEXT and a ` +
        `DIFFERENT list when imported. The imported array is the one that runs, so ` +
        `whatever the text parser is seeing that Node is not — a commented-out ` +
        `entry, a conditional push, a re-export — a migration is either running ` +
        `unmanifested or manifested without running.`
    ).toEqual(MIGRATIONS.map((m) => m.name));
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
    // and sorts FIRST. The real tree does distinguish them today — 24 of its 220
    // migrations register at a position they do not sort at, measured 2026-08-26 —
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

  /**
   * A corpus whose manifest is written and agrees with the bytes, AND whose
   * hashes are then declared to be what main carries.
   *
   * The second half is the part that used to be implicit and wrong. "Already
   * shipped" is now a fact about git, so a test that wants to exercise the
   * refusal has to SAY what shipped — and passing it in is exactly what stops the
   * working-tree manifest from being the answer.
   */
  const shipped = () => {
    const c = corpus(
      {
        [FIRST]: "export const migration = 1;\n",
        [SECOND]: "export const migration = 2;\n",
      },
      REGISTERED
    );
    const nothingShipped: ShippedReference = {
      manifest: {},
      source: "a corpus with no history",
      mergeBase: true,
    };
    const seed = generateManifest({ ...c, shipped: nothingShipped });
    expect(seed.wrote).toBe(true);
    expect(seed.exitCode).toBe(0);
    // Nothing was on main, so seeding the manifest is not a rehash — which is
    // also the "brand-new repo" case, and it must not refuse.
    expect(seed.rehashed).toEqual([]);
    return {
      ...c,
      shipped: {
        manifest: seed.manifest,
        source: "main, in this test",
        mergeBase: true,
      },
    };
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
    expect(result.error).toContain("already on main");
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
    expect(result.error).toContain("already on main");
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

  // THE OTHER DIRECTION, WHICH THE REFUSAL DID NOT COVER AT ALL.
  //
  // `rehashed` ranges over the files this tree HAS, so a shipped migration deleted
  // outright — file and registry entry both — was `dropped: 1`, `REHASHED: 0`, a
  // written manifest and exit 0. Measured on the real tree at the time: the whole
  // of this file stayed green on it, because manifest and versions/ still agreed
  // with each other. They had simply both forgotten.
  const deleteShipped = (c: ReturnType<typeof shipped>) => {
    fs.rmSync(path.join(c.versionsDir, FIRST));
    writeRegistry(c.registryPath, [SECOND]);
  };

  it("refuses the write when a migration that is on main is GONE from the tree", () => {
    const c = shipped();
    const before = fs.readFileSync(c.manifestPath, "utf8");
    deleteShipped(c);

    const result = generateManifest(c);
    expect(result.unshipped).toEqual([FIRST]);
    // Not caught by the rehash arm: nothing here hashes differently, because the
    // file whose hash would differ is not there to hash.
    expect(result.rehashed).toEqual([]);
    expect(result.wrote).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("REFUSING to write");
    expect(result.error).toContain("GONE from this tree");
    expect(result.error).toContain(FIRST);
    expect(fs.readFileSync(c.manifestPath, "utf8")).toBe(before);
    fs.rmSync(c.versionsDir, { recursive: true, force: true });
  });

  it("--check fails on the deletion too, and does not honour --allow-rehash", () => {
    const c = shipped();
    deleteShipped(c);
    const result = generateManifest({ ...c, check: true, allowRehash: true });
    expect(result.exitCode).toBe(1);
    expect(result.wrote).toBe(false);
    expect(result.error).toContain("GONE from this tree");
    // Not the stale-manifest advice: following that advice is what writes the
    // deletion into the file.
    expect(result.error).not.toContain("and commit the result");
    fs.rmSync(c.versionsDir, { recursive: true, force: true });
  });

  it("--allow-rehash records the deletion, and says on stderr what it dropped", () => {
    // The one legitimate case: main itself carries a migration that is being
    // reverted off it. It is a decision somebody types, and it leaves a line in
    // the diff for review to argue with.
    const c = shipped();
    deleteShipped(c);
    const result = generateManifest({ ...c, allowRehash: true });
    expect(result.exitCode).toBe(0);
    expect(result.wrote).toBe(true);
    expect(result.unshipped).toEqual([FIRST]);
    expect(result.error).toContain("dropped 1 migration(s)");
    expect(Object.keys(readManifest(c.manifestPath))).toEqual([SECOND]);
    fs.rmSync(c.versionsDir, { recursive: true, force: true });
  });

  it("does not ask about a deletion when the reference is a branch TIP, not an ancestor", () => {
    // The CI shape. `actions/checkout` leaves a PR merge commit with no merge-base
    // to find, so `resolveShippedReference` falls back to main's tip — and against
    // a TIP, a name in the reference and not in the tree is far more often a
    // migration main gained after this branch forked than one this branch deleted.
    // Asking there would red every branch that is behind main, which is most of
    // them, so the question is not asked. `rehashed` is unaffected.
    const c = shipped();
    const tip = { ...c.shipped, mergeBase: false };
    deleteShipped(c);

    const result = generateManifest({ ...c, shipped: tip });
    expect(result.unshipped).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.wrote).toBe(true);
    expect(result.report).toContain("GONE:      not asked");
    fs.rmSync(c.versionsDir, { recursive: true, force: true });
  });

  it("still catches a REHASH against a branch tip, which needs no ancestor", () => {
    const c = shipped();
    const tip = { ...c.shipped, mergeBase: false };
    editShipped(c.versionsDir);

    const result = generateManifest({ ...c, shipped: tip });
    expect(result.rehashed).toEqual([FIRST]);
    expect(result.exitCode).toBe(1);
    expect(result.wrote).toBe(false);
    fs.rmSync(c.versionsDir, { recursive: true, force: true });
  });

  it("does NOT fire on a migration THIS BRANCH added and then removed again", () => {
    // The ordinary case that must stay quiet: a migration that never reached main
    // is not in the shipped reference, so removing it is an ordinary `dropped`.
    const c = shipped();
    const third = "20260803-third.ts";
    fs.writeFileSync(
      path.join(c.versionsDir, third),
      "export const migration = 3;\n",
      "utf8"
    );
    writeRegistry(c.registryPath, [...REGISTERED, third]);
    expect(generateManifest(c).exitCode).toBe(0);

    fs.rmSync(path.join(c.versionsDir, third));
    writeRegistry(c.registryPath, REGISTERED);
    const result = generateManifest(c);
    expect(result.unshipped).toEqual([]);
    expect(result.removed).toEqual([third]);
    expect(result.wrote).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.error).toBeUndefined();
    fs.rmSync(c.versionsDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// THE GUARDS THAT WERE IMPORTED AND NEVER CALLED (#3635 R5).
//
// The adversarial pass applied the redundancy rule literally: `manifest-source.ts`
// is imported by exactly one test file and one script, so this file is the only
// tier that CAN observe it. Then it removed one guard at a time and re-ran.
// Stubbing `resolveShippedReference`'s entire git ancestor determination left
// 25 passed. So did deleting the conflict-marker branch, the `npm_config_check`
// reading, and the by-name `--allow-rehash` refusal. Every shipped-reference case
// above passes `shipped` in as a synthetic literal, so not one of them asks git
// about anything, and `parseManifest` and `runManifestCli` were imported symbols
// nothing called.
//
// So these cases drive the two entry points over REAL git repositories and a real
// argv/env, built in a temp directory. Same corpus discipline as everything above:
// never the live tree.

/** A throwaway repository with `main`, and a manifest committed on it. */
const gitCorpus = (
  manifest: Record<string, string>
): { root: string; rel: string } => {
  const root = makeTmpDir("manifest-git");
  const rel = "manifest.json";
  const run = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "corpus",
        GIT_AUTHOR_EMAIL: "corpus@example.invalid",
        GIT_COMMITTER_NAME: "corpus",
        GIT_COMMITTER_EMAIL: "corpus@example.invalid",
      },
    });
  execFileSync("git", ["init", "-q", "-b", "main", root], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  fs.writeFileSync(path.join(root, rel), serializeManifest(manifest), "utf8");
  run("add", "-A");
  run("commit", "-q", "-m", "shipped");
  return { root, rel };
};

const gitRun = (root: string, ...args: string[]): string =>
  execFileSync("git", ["-C", root, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "corpus",
      GIT_AUTHOR_EMAIL: "corpus@example.invalid",
      GIT_COMMITTER_NAME: "corpus",
      GIT_COMMITTER_EMAIL: "corpus@example.invalid",
    },
  })
    .toString("utf8")
    .trim();

describe("resolveShippedReference asks git, over real repositories", () => {
  const SHIPPED = {
    "20260801-first.ts": "a".repeat(64),
    "20260802-second.ts": "b".repeat(64),
  };

  it("reads the manifest at the MERGE-BASE, and says it found an ancestor", () => {
    // The case the whole refusal rests on and the one nothing exercised: a branch
    // that has moved on, a main that is where it was, and the hashes coming from
    // the commit they share. Stub the resolution and this reads an empty manifest
    // from a source string nobody wrote.
    const { root, rel } = gitCorpus(SHIPPED);
    const baseSha = gitRun(root, "rev-parse", "--short", "HEAD");
    gitRun(root, "checkout", "-q", "-b", "feature");
    fs.writeFileSync(path.join(root, "unrelated.txt"), "later\n", "utf8");
    gitRun(root, "add", "-A");
    gitRun(root, "commit", "-q", "-m", "branch work");
    // The branch's own manifest says something else entirely — proving the
    // reference came from the commit and not from the file on disk.
    fs.writeFileSync(
      path.join(root, rel),
      serializeManifest({ "20260801-first.ts": "z".repeat(64) }),
      "utf8"
    );

    const ref = resolveShippedReference({
      repoRoot: root,
      manifestRel: rel,
      baseRefs: ["main"],
    });
    expect(ref.manifest).toEqual(SHIPPED);
    expect(ref.mergeBase).toBe(true);
    expect(ref.source).toContain(baseSha);
    expect(ref.source).toContain("the merge-base with main");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("stamps the base commit's DATE beside its sha (#3635 R4)", () => {
    // `refs/remotes/origin/main` is only as fresh as the last fetch, and the
    // module used to call it "the hashes that are actually on main". One fetch
    // behind, a real deletion prints `GONE: 0` — asked-and-clean's own output. The
    // date is what makes the reference's age legible in the line a reviewer reads.
    const { root, rel } = gitCorpus(SHIPPED);
    const committed = gitRun(root, "show", "-s", "--format=%cI", "HEAD");
    const ref = resolveShippedReference({
      repoRoot: root,
      manifestRel: rel,
      baseRefs: ["main"],
    });
    expect(ref.source).toContain(`committed ${committed}`);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("falls back to the TIP, and says so, when the histories are unrelated", () => {
    // `mergeBase: false` is what silences the deletion question, so it has to be
    // reachable for the right reason. Two roots in one repository share no commit.
    const { root, rel } = gitCorpus(SHIPPED);
    gitRun(root, "checkout", "-q", "--orphan", "elsewhere");
    gitRun(root, "rm", "-q", "-rf", ".");
    fs.writeFileSync(path.join(root, "other.txt"), "unrelated\n", "utf8");
    gitRun(root, "add", "-A");
    gitRun(root, "commit", "-q", "-m", "unrelated root");

    const ref = resolveShippedReference({
      repoRoot: root,
      manifestRel: rel,
      baseRefs: ["main"],
    });
    expect(ref.mergeBase).toBe(false);
    expect(ref.manifest).toEqual(SHIPPED);
    expect(ref.source).toContain("it has no merge-base with HEAD");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("REFUSES when no base ref resolves — it never reads as `nothing shipped`", () => {
    // The fail-open this module exists to prevent. An empty reference means every
    // hash is new and the alarm cannot fire, so "git could not answer" must not
    // produce one.
    const { root, rel } = gitCorpus(SHIPPED);
    expect(() =>
      resolveShippedReference({
        repoRoot: root,
        manifestRel: rel,
        baseRefs: ["no-such-ref"],
      })
    ).toThrow(/none of no-such-ref resolves/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("REFUSES outside a repository rather than assuming nothing shipped", () => {
    const root = makeTmpDir("manifest-nogit");
    expect(() => resolveShippedReference({ repoRoot: root })).toThrow(
      /could not read a repository/
    );
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("answers `{}` only where git POSITIVELY says nothing shipped", () => {
    // Two of them, and they are the distinction the refusal above rests on: git
    // answering "there is nothing" is not git failing to answer.
    const empty = makeTmpDir("manifest-empty");
    execFileSync("git", ["init", "-q", "-b", "main", empty], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const noCommits = resolveShippedReference({ repoRoot: empty });
    expect(noCommits.manifest).toEqual({});
    expect(noCommits.source).toContain("no commits yet");
    expect(noCommits.mergeBase).toBe(true);
    fs.rmSync(empty, { recursive: true, force: true });

    const { root } = gitCorpus(SHIPPED);
    const absent = resolveShippedReference({
      repoRoot: root,
      manifestRel: "not-committed-here.json",
      baseRefs: ["main"],
    });
    expect(absent.manifest).toEqual({});
    expect(absent.source).toContain("nothing has shipped");
    expect(absent.mergeBase).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("carries the ancestor's hashes all the way into the deletion alarm", () => {
    // End to end with nothing passed in: the reference comes from git, and the
    // refusal fires on a migration the ancestor has and this tree does not. This
    // is the CI shape, and it is what `GONE: not asked` was standing in for.
    const { root, rel } = gitCorpus({});
    const versionsDir = path.join(root, "versions");
    fs.mkdirSync(versionsDir);
    const FIRST = "20260801-first.ts";
    const SECOND = "20260802-second.ts";
    for (const [name, body] of [
      [FIRST, "export const migration = 1;\n"],
      [SECOND, "export const migration = 2;\n"],
    ] as const) {
      fs.writeFileSync(path.join(versionsDir, name), body, "utf8");
    }
    const registryPath = path.join(versionsDir, "index.ts");
    writeRegistry(registryPath, [FIRST, SECOND]);
    const manifestPath = path.join(root, rel);
    fs.writeFileSync(
      manifestPath,
      serializeManifest(buildManifest({ versionsDir, registryPath })),
      "utf8"
    );
    gitRun(root, "add", "-A");
    gitRun(root, "commit", "-q", "-m", "two migrations shipped");
    gitRun(root, "checkout", "-q", "-b", "feature");

    fs.rmSync(path.join(versionsDir, FIRST));
    writeRegistry(registryPath, [SECOND]);
    const result = generateManifest({
      versionsDir,
      registryPath,
      manifestPath,
      repoRoot: root,
      shipped: resolveShippedReference({
        repoRoot: root,
        manifestRel: rel,
        baseRefs: ["main"],
      }),
    });
    expect(result.unshipped).toEqual([FIRST]);
    expect(result.exitCode).toBe(1);
    expect(result.wrote).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("the generator refuses a run that could not ask (#3635 R1)", () => {
  const tipCorpus = () => {
    const c = corpus(
      {
        "20260801-first.ts": "export const migration = 1;\n",
        "20260802-second.ts": "export const migration = 2;\n",
      },
      ["20260801-first.ts", "20260802-second.ts"]
    );
    const seeded = generateManifest({
      ...c,
      shipped: {
        manifest: {},
        source: "a corpus with no history",
        mergeBase: true,
      },
    });
    return {
      ...c,
      tip: {
        manifest: seeded.manifest,
        source: "main's tip, in this test",
        mergeBase: false,
      } satisfies ShippedReference,
    };
  };

  it("exits 1 on a TIP reference, instead of reporting `not asked` and 0", () => {
    // The CI defect. `.github/workflows/ci.yml` checked out at depth 1, no
    // merge-base existed, and the report's `GONE: not asked` came with exit 0 —
    // which on a green check is indistinguishable from asked-and-clean. Delete
    // this branch and a checkout with no history reports success again.
    const c = tipCorpus();
    fs.rmSync(path.join(c.versionsDir, "20260801-first.ts"));
    writeRegistry(c.registryPath, ["20260802-second.ts"]);
    // Regenerate so the manifest and the bytes agree: the only thing left for
    // `--check` to have an opinion about is the migration that is on main and
    // gone from here — which against a tip it declines to have one about.
    expect(generateManifest({ ...c, shipped: c.tip }).wrote).toBe(true);

    const asked = generateManifest({ ...c, shipped: c.tip, check: true });
    expect(asked.exitCode, "without the flag the run still reports").toBe(0);
    expect(asked.report).toContain("GONE:      not asked");

    const required = generateManifest({
      ...c,
      shipped: c.tip,
      check: true,
      requireMergeBase: true,
    });
    expect(required.exitCode).toBe(1);
    expect(required.error).toContain("CANNOT BE CHECKED");
    expect(required.error).toContain("fetch-depth: 0");
    fs.rmSync(c.versionsDir, { recursive: true, force: true });
  });

  it("stays out of the way when the reference IS an ancestor", () => {
    // A refusal that fires on the ordinary case gets a flag typed in front of it
    // by reflex, so the flag must be silent on every run that has its ancestry.
    const c = tipCorpus();
    const result = generateManifest({
      ...c,
      shipped: { ...c.tip, mergeBase: true },
      check: true,
      requireMergeBase: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.error).toBeUndefined();
    fs.rmSync(c.versionsDir, { recursive: true, force: true });
  });
});

describe("the registry gets manifest.json's conflict-marker refusal (#3635 R3)", () => {
  /** Both sides of a two-migration merge, markers and all, files on disk. */
  const conflicted = () => {
    const versionsDir = makeTmpDir("manifest-conflict");
    const A = "20260824-side-a.ts";
    const B = "20260824-side-b.ts";
    for (const [name, n] of [
      [A, 1],
      [B, 2],
    ] as const) {
      fs.writeFileSync(
        path.join(versionsDir, name),
        `export const migration = ${n};\n`,
        "utf8"
      );
    }
    const registryPath = path.join(versionsDir, "index.ts");
    fs.writeFileSync(
      registryPath,
      [
        "<<<<<<< HEAD",
        'import { migration as mA } from "./20260824-side-a";',
        "=======",
        'import { migration as mB } from "./20260824-side-b";',
        ">>>>>>> origin/main",
        "",
        "export const MIGRATIONS: Migration[] = [",
        "<<<<<<< HEAD",
        "  mA,",
        "=======",
        "  mB,",
        ">>>>>>> origin/main",
        "];",
        "",
      ].join("\n"),
      "utf8"
    );
    return {
      versionsDir,
      registryPath,
      manifestPath: path.join(versionsDir, "manifest.json"),
    };
  };

  it("refuses instead of writing a manifest for a registry that will not compile", () => {
    // Measured before this refusal existed: BOTH sides' files are on disk, so
    // `assertRegistryMatchesDisk` sees no disagreement, and the import and entry
    // regexes match straight through the marker lines. The generator printed
    // `unchanged: 220`, `new: 2`, wrote the manifest and exited 0 — over a file
    // that is not valid TypeScript, with the sentence the docs call the proof that
    // no shipped migration moved.
    const c = conflicted();
    expect(() => registryOrder(c.registryPath)).toThrow(/CONFLICT MARKERS/);
    expect(fs.existsSync(c.manifestPath)).toBe(false);
    fs.rmSync(c.versionsDir, { recursive: true, force: true });
  });

  it("names keeping BOTH sides, which is what name-keyed migrations want", () => {
    // The wrong repair is picking a side, and it is the quiet one: the dropped
    // migration simply stops running, on fresh databases only.
    const c = conflicted();
    let message = "";
    try {
      registryOrder(c.registryPath);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("BOTH sides");
    expect(message).toContain("DO NOT pick one side");
    fs.rmSync(c.versionsDir, { recursive: true, force: true });
  });

  it("is silent on a registry with no markers in it", () => {
    const versionsDir = makeTmpDir("manifest-clean");
    fs.writeFileSync(
      path.join(versionsDir, "20260801-only.ts"),
      "export const migration = 1;\n",
      "utf8"
    );
    const registryPath = path.join(versionsDir, "index.ts");
    writeRegistry(registryPath, ["20260801-only.ts"]);
    expect(registryOrder(registryPath)).toEqual(["20260801-only.ts"]);
    fs.rmSync(versionsDir, { recursive: true, force: true });
  });
});

describe("parseManifest's conflict-marker refusal, called (#3635 R5)", () => {
  const CONFLICTED = [
    "{",
    "<<<<<<< HEAD",
    '  "20260824-side-a.ts": "aaaa"',
    "=======",
    '  "20260824-side-b.ts": "bbbb"',
    ">>>>>>> origin/main",
    "}",
    "",
  ].join("\n");

  it("names `checkout --ours` and forbids the delete", () => {
    // A manifest.json conflict is not an edge case: both sides append to the same
    // tail on every two-migration merge, so git has nothing to interleave. The two
    // obvious repairs are `--ours` (right) and `rm` (wrong, and invisible for a
    // long time), so the message has to name which is which.
    let message = "";
    try {
      parseManifest(CONFLICTED, "lib/migrations/manifest.json");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("CONFLICT MARKERS");
    expect(message).toContain("git checkout --ours");
    expect(message).toContain("DO NOT DELETE IT");
  });

  it("refuses rather than falling back to `{}`", () => {
    // Swallowing an unreadable manifest as "no previous manifest" is the same
    // fail-open as deleting the file: every entry reads as new and nothing is
    // compared to anything.
    expect(() => parseManifest(CONFLICTED, "m.json")).toThrow();
    expect(() => parseManifest("{ not json", "m.json")).toThrow(
      /is not valid JSON/
    );
    expect(parseManifest('{"a.ts":"x"}', "m.json")).toEqual({ "a.ts": "x" });
  });

  it("reaches the same refusal through readManifest, off disk", () => {
    const dir = makeTmpDir("manifest-parse");
    const file = path.join(dir, "manifest.json");
    fs.writeFileSync(file, CONFLICTED, "utf8");
    expect(() => readManifest(file)).toThrow(/CONFLICT MARKERS/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("runManifestCli, driven over argv and env (#3635 R5)", () => {
  /** A corpus whose manifest is written, agrees with the bytes, and is `shipped`. */
  const cliCorpus = () => {
    const FIRST = "20260801-first.ts";
    const SECOND = "20260802-second.ts";
    const c = corpus(
      {
        [FIRST]: "export const migration = 1;\n",
        [SECOND]: "export const migration = 2;\n",
      },
      [FIRST, SECOND]
    );
    const seed = generateManifest({
      ...c,
      shipped: {
        manifest: {},
        source: "a corpus with no history",
        mergeBase: true,
      },
    });
    expect(seed.wrote).toBe(true);
    return {
      paths: {
        ...c,
        shipped: {
          manifest: seed.manifest,
          source: "main, in this test",
          mergeBase: true,
        } satisfies ShippedReference,
      },
      first: FIRST,
      versionsDir: c.versionsDir,
      manifestPath: c.manifestPath,
    };
  };

  it("reads --check out of npm's environment, and does NOT write", () => {
    // `npm run gen:migration-manifest --check` — WITHOUT the `--` — is the
    // invocation a nervous person reaches for, and npm swallows the flag before
    // it can reach process.argv. It puts it in the environment instead. Without
    // this reading, the verify-only run WRITES, which is the opposite of what was
    // asked for and leaves no trace that it happened.
    const c = cliCorpus();
    fs.appendFileSync(
      path.join(c.versionsDir, c.first),
      "\n// an edit to a shipped migration\n",
      "utf8"
    );
    const before = fs.readFileSync(c.manifestPath, "utf8");

    const result = runManifestCli({
      argv: [],
      env: { npm_config_check: "true" },
      paths: c.paths,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("FAILS");
    expect(
      fs.readFileSync(c.manifestPath, "utf8"),
      "the env --check was not read, so the run wrote the manifest it was asked to verify"
    ).toBe(before);
    fs.rmSync(c.versionsDir, { recursive: true, force: true });
  });

  it("treats npm's `false` as absent, so an unset flag does not check", () => {
    // npm writes "true"/"false"; a "false" that reached here as truthy would turn
    // every ordinary write into a verify and the tool would appear to do nothing.
    const c = cliCorpus();
    fs.writeFileSync(
      path.join(c.versionsDir, "20260803-third.ts"),
      "export const migration = 3;\n",
      "utf8"
    );
    writeRegistry(c.paths.registryPath, [
      c.first,
      "20260802-second.ts",
      "20260803-third.ts",
    ]);
    const result = runManifestCli({
      argv: [],
      env: { npm_config_check: "false" },
      paths: c.paths,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Wrote ");
    fs.rmSync(c.versionsDir, { recursive: true, force: true });
  });

  it("REFUSES an --allow-rehash that arrived only through the environment", () => {
    // The one flag that moves a hash already on main. `npm_config_*` can come from
    // an .npmrc or an exported shell variable nobody typed today, and a door that
    // opens from ambient state is not a decision anybody made. Remove this and
    // that door opens from the environment, silently, with the write succeeding.
    const c = cliCorpus();
    fs.appendFileSync(
      path.join(c.versionsDir, c.first),
      "\n// an edit to a shipped migration\n",
      "utf8"
    );
    const before = fs.readFileSync(c.manifestPath, "utf8");

    const result = runManifestCli({
      argv: [],
      env: { npm_config_allow_rehash: "true" },
      paths: c.paths,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("through npm's environment");
    expect(result.stderr).toContain("-- --allow-rehash");
    expect(result.stdout).toBe("");
    expect(
      fs.readFileSync(c.manifestPath, "utf8"),
      "an env-only --allow-rehash rewrote a hash that is on main"
    ).toBe(before);
    fs.rmSync(c.versionsDir, { recursive: true, force: true });
  });

  it("honours the same flag when it is TYPED, where review can see it", () => {
    // A refusal with no door is routed around within the hour. The point of the
    // case above is where the decision is visible, not that it is forbidden.
    const c = cliCorpus();
    fs.appendFileSync(
      path.join(c.versionsDir, c.first),
      "\n// a deliberate rehash\n",
      "utf8"
    );
    const result = runManifestCli({
      argv: ["--allow-rehash"],
      env: { npm_config_allow_rehash: "true" },
      paths: c.paths,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("--allow-rehash: rewrote 1 hash(es)");
    fs.rmSync(c.versionsDir, { recursive: true, force: true });
  });

  it("passes --require-merge-base through, from argv and from the environment", () => {
    // What CI runs. Both spellings, because npm swallows the bare one exactly as
    // it swallows `--check`.
    const c = cliCorpus();
    const tip = {
      ...c.paths,
      shipped: { ...c.paths.shipped, mergeBase: false },
    };
    for (const invocation of [
      { argv: ["--check", "--require-merge-base"], env: {} },
      {
        argv: [],
        env: {
          npm_config_check: "true",
          npm_config_require_merge_base: "true",
        },
      },
    ]) {
      const result = runManifestCli({ ...invocation, paths: tip });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("CANNOT BE CHECKED");
    }
    // And silent when the reference is an ancestor, which is every ordinary run.
    expect(
      runManifestCli({
        argv: ["--check", "--require-merge-base"],
        paths: c.paths,
      }).exitCode
    ).toBe(0);
    fs.rmSync(c.versionsDir, { recursive: true, force: true });
  });

  it("turns a thrown refusal into one message, with no stack trace", () => {
    // Every refusal below the CLI already carries its whole remedy. A stack trace
    // on top buries the one line the reader needs, and this was one of the two
    // argv-shaped defects that put the command line in a testable function.
    const c = cliCorpus();
    fs.writeFileSync(
      c.paths.registryPath,
      ["<<<<<<< HEAD", "=======", ">>>>>>> origin/main", ""].join("\n"),
      "utf8"
    );
    const result = runManifestCli({ argv: [], paths: c.paths });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("CONFLICT MARKERS");
    expect(result.stderr).not.toContain("    at ");
    fs.rmSync(c.versionsDir, { recursive: true, force: true });
  });
});
