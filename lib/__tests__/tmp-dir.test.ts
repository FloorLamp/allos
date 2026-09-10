import { readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  RETIRED_TMP_PREFIXES,
  STALE_AFTER_MS,
  TMP_PREFIX,
  makeTmpDir,
  sweepStaleTmpEntries,
} from "./tmp-dir";

// The stale sweep and the maker (#3248, #3591). The census that refused a raw
// mkdtemp in the test tiers is an ESLint rule now (eslint.config.mjs); what stays
// is the behaviour no rule can see. The sweep is the one mechanism that survives a
// killed process, and its predicate has already deleted another lane's data on
// this box once, so both of its bounds get a real filesystem.

describe("the stale sweep", () => {
  // The sweep is the WHOLE mechanism — the one thing that survives a killed
  // process, which is how runs end on this box — so it gets a real filesystem
  // rather than a mock, and both of its bounds are exercised: what it reclaims and
  // what it must not touch.
  it("reclaims entries past the threshold and leaves live ones alone", () => {
    const root = makeTmpDir("tmp-sweep-corpus");
    const now = Date.now();
    const plant = (name: string, ageMs: number): string => {
      const full = path.join(root, name);
      fs.mkdirSync(full, { recursive: true });
      writeFileSync(path.join(full, "test.db"), "x");
      const seconds = (now - ageMs) / 1000;
      utimesSync(full, seconds, seconds);
      return full;
    };
    const stale = plant(
      `${TMP_PREFIX}db-shared-aaaaaa`,
      STALE_AFTER_MS + 60_000
    );
    const live = plant(`${TMP_PREFIX}db-shared-bbbbbb`, 30_000);
    // A file, not a directory: `allos-takeout-*.zip` leaks as plain files.
    const staleFile = path.join(root, `${TMP_PREFIX}takeout-test-1234.zip`);
    writeFileSync(staleFile, "zip");
    const old = (now - STALE_AFTER_MS - 60_000) / 1000;
    utimesSync(staleFile, old, old);
    // Someone else's temp entry, aged past the threshold. Not ours to delete.
    const foreign = plant("hsperfdata_root", STALE_AFTER_MS + 60_000);
    // AND TWO THAT CONTAIN `allos-` WITHOUT STARTING WITH IT, which is the pair
    // that tells `startsWith` apart from `includes`. `hsperfdata_root` alone
    // cannot: it shares no substring with the prefix, so it stays alive under
    // BOTH predicates and the permissive one ships green. Measured 2026-08-23 —
    // relaxing the filter to `includes` deletes exactly these two and the census
    // stays 8 passed. The names are the real collateral this predicate has already
    // destroyed on this box during #3248's own development: a sibling lane's cache
    // and another lane's scratch directory.
    const nested = plant("lens-allos-cache", STALE_AFTER_MS + 60_000);
    const dotted = plant("sibling.allos-scratch", STALE_AFTER_MS + 60_000);

    expect(
      sweepStaleTmpEntries(root, now),
      "The sweep reclaimed a different number of entries than the two it is " +
        "supposed to see. More than two means the prefix filter has widened to " +
        "entries it does not own — `lens-allos-cache` and `sibling.allos-scratch` " +
        "below are the pair that catches that."
    ).toBe(2);

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(staleFile)).toBe(false);
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(foreign)).toBe(true);
    expect(
      [nested, dotted].filter((p) => !fs.existsSync(p)),
      "The sweep deleted an entry that only CONTAINS the shared prefix. It is " +
        "matching a substring where it must match a leading one, and everything " +
        "else in /tmp with `allos-` anywhere in its name is now in scope."
    ).toEqual([]);
    // Sweeping the same root again is a no-op, not a second count.
    expect(sweepStaleTmpEntries(root, now)).toBe(0);
  });

  // THE RETIRED PREFIXES (#3591), which the sweep honours alongside `allos-`.
  //
  // This is the fixture that has to be right, because the change it guards is a
  // WIDENING of the predicate that has already destroyed another lane's data on
  // this box. Several lanes run test tiers here at once — six worktrees on this
  // container as of 2026-08-23 — and all of them keep state in `/tmp`, so the
  // corpus is planted inside a directory only this process can see — never the
  // live `/tmp`, where a create-then-unlink lands inside a sibling's read window
  // and kills unrelated tests with ENOENT (#3557).
  //
  // For EVERY entry on the list there is a near-miss that CONTAINS it without
  // starting with it, and those names are the point: `fact-census-` must not
  // reach `artifact-census-`, `nul-census-` must not reach `annul-census-`.
  // Ablated 2026-08-23 — relaxing `isSweepableTmpName` to `includes` deletes all
  // seven and reds this test; dropping any one prefix from the list strands its
  // own entry and reds it from the other side; dropping a trailing dash from a
  // list entry deletes `fact-censuses-*`.
  it("reclaims the retired prefixes and stops at their near-misses", () => {
    const root = makeTmpDir("tmp-retired-corpus");
    const outside = makeTmpDir("tmp-retired-outside");
    const now = Date.now();
    const STALE = STALE_AFTER_MS + 60_000;
    const plant = (name: string, ageMs: number): string => {
      const full = path.join(root, name);
      fs.mkdirSync(full, { recursive: true });
      writeFileSync(path.join(full, "fixture.txt"), "x");
      const seconds = (now - ageMs) / 1000;
      utimesSync(full, seconds, seconds);
      return full;
    };

    // Every name the sweep MUST reclaim: one directory per retired prefix, past
    // the threshold, plus an `allos-` entry so the two halves are seen composing.
    const reclaim = [
      ...RETIRED_TMP_PREFIXES.map((prefix) => plant(`${prefix}aaaaaa`, STALE)),
      plant(`${TMP_PREFIX}retired-neighbour-aaaaaa`, STALE),
    ];

    // Every name the sweep MUST LEAVE ALONE, each stale so that AGE cannot be
    // what saves it — only the predicate can.
    //
    // The near-misses are one per list entry, in the two shapes that matter: a
    // longer word ending in the prefix (`artifact-census-`, `annul-census-`,
    // `seafood-rebuild-`, `unlogged-via-*`), and a leading segment
    // (`pre-dose-scan-census-`, `no-gitleaks-range-`). `fact-censuses-` is the
    // third shape: the prefix with its TRAILING DASH replaced by more word, which
    // is what makes the dash in each list entry load-bearing.
    const nearMisses = [
      "pre-dose-scan-census-aaaaaa",
      "artifact-census-aaaaaa",
      "fact-censuses-aaaaaa",
      "seafood-rebuild-aaaaaa",
      "no-gitleaks-range-aaaaaa",
      "unlogged-via-census-aaaaaa",
      "unlogged-via-wiring-aaaaaa",
      "annul-census-aaaaaa",
    ].map((name) => plant(name, STALE));
    // A sibling lane's browser profile, the shape this box actually has in
    // `/tmp`, and the kind of directory the `includes` relaxation destroyed.
    const foreign = plant("playwright_chromiumdev_profile-Xk2p9q", STALE);
    // Younger than the threshold under a retired prefix: a run may be using it.
    const young = plant("nul-census-live01", 30_000);
    // A symlink OUT of the corpus. Named so no predicate matches it, stale, and
    // pointing at a directory with contents: if the sweep ever followed a link
    // out of the temp root, this is where it would leave the damage.
    const linkTarget = path.join(outside, "keep-me");
    fs.mkdirSync(linkTarget, { recursive: true });
    writeFileSync(path.join(linkTarget, "payload.txt"), "keep");
    const bystanderLink = path.join(root, "chromium-profile-link");
    fs.symlinkSync(linkTarget, bystanderLink);
    // And one symlink the sweep DOES own by name: the link goes, its target does
    // not. `lstat`, not `stat`, is the whole of that difference.
    const ownedLink = path.join(root, "nul-census-lnkaaa");
    fs.symlinkSync(linkTarget, ownedLink);
    const old = (now - STALE) / 1000;
    for (const link of [bystanderLink, ownedLink]) {
      fs.lutimesSync(link, old, old);
    }

    expect(
      sweepStaleTmpEntries(root, now),
      "The sweep reclaimed a different number of entries than the " +
        `${reclaim.length + 1} it owns here. More than that means the predicate ` +
        "has widened past whole-prefix matching and the near-misses below are " +
        "in scope; fewer means a retired prefix is not on the list."
    ).toBe(reclaim.length + 1);

    expect(
      reclaim.filter((p) => fs.existsSync(p)),
      "A retired prefix planted past the threshold survived the sweep, so it " +
        "is not on RETIRED_TMP_PREFIXES — or is spelled differently there."
    ).toEqual([]);
    expect(
      nearMisses.filter((p) => !fs.existsSync(p)),
      "The sweep deleted a name that only CONTAINS a retired prefix. It is " +
        "matching a substring where it must match a leading one, and every " +
        "neighbour in /tmp whose name mentions one of these words is now in scope."
    ).toEqual([]);
    expect(fs.existsSync(foreign)).toBe(true);
    expect(fs.existsSync(young)).toBe(true);
    expect(fs.lstatSync(bystanderLink).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(ownedLink)).toBe(false);
    expect(
      readFileSync(path.join(linkTarget, "payload.txt"), "utf8"),
      "The sweep followed a symlink out of the temp root and deleted what it " +
        "pointed at. It must lstat, never stat."
    ).toBe("keep");
  });

  it("survives a root that does not exist", () => {
    expect(sweepStaleTmpEntries(path.join("/nonexistent-xyz-77", "t"))).toBe(0);
  });
});

describe("makeTmpDir", () => {
  it("names the directory so the sweep and the check-in can both see it", () => {
    const dir = makeTmpDir("census-demo");
    expect(path.basename(dir)).toMatch(
      new RegExp(`^${TMP_PREFIX}census-demo-`)
    );
    expect(statSync(dir).isDirectory()).toBe(true);
  });

  it("refuses a label that would break the shared prefix", () => {
    expect(() => makeTmpDir("Allos/../escape")).toThrow(/label must be/);
    expect(() => makeTmpDir("")).toThrow(/label must be/);
  });
});
