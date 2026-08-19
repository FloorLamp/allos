// DB INTEGRATION TIER — the dashboard's flagged-biomarker window (#2112).
//
// `flaggedInWindow` sits inside BOTH per-member collectors the /upcoming page runs
// (collectAttentionModel and collectSuppressedAttention), so on a multi-profile view
// its cost is paid 2× per member. Two things were wrong with how it computed its
// window start:
//
//   • it spent a `SELECT datetime('now', ?)` DB ROUND-TRIP on a value that is pure
//     date arithmetic — one prepared statement per call, i.e. 2N per render;
//   • that round-trip read SQLite's REAL clock, which lib/clock.ts's freeze cannot
//     reach, even though the value meets a day-grained column (`date >= date(?)`)
//     — exactly the case the clock seam exists for.
//
// The window itself must be UNCHANGED, so this pins the boundary from both sides: a
// reading imported just inside 14 days is newly flagged, one just outside is not, and
// the collection-date half of the window (#557 fix 2) still keeps a backfill out. The
// statement-count pin is the other half — the round-trip is gone, counted rather than
// claimed.
//
// Since #2110 the heavy DEDUP+LATEST pass is HOISTED, so a prepare count no longer
// measures how often it runs: it compiles once per connection and executes without
// compiling again. The pin below counts compilations of the retired round-trip (still
// zero) and proves the heavy pass ran from its OUTPUT.
//
// The request-scoped cache() added in the same change is deliberately NOT asserted
// here: React's cache() has no dispatcher outside a server request, so in this tier it
// is identity by design (see lib/request-cache.ts). What this file guarantees is that
// the memo cannot have changed any ANSWER.
//
// Fixtures are 100% synthetic (a throwaway per-file DB via setup.ts). No AI, no
// network.

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  collectAttentionModel,
  FLAGGED_ATTENTION_WINDOW_DAYS,
} from "@/lib/queries/attention";
import { flagInSql, NOTABLE_FLAGS } from "@/lib/reference-range";

// The two statements this change is about: the retired now-read, and the heavy
// DEDUP+LATEST pass the window feeds.
//
// HOW THIS PIN DIED ONCE, AND WHY IT CANNOT AGAIN. Its only assertion about the heavy
// pass is `toBe(0)` — so a signature that matches NOTHING satisfies it, and the pin
// reads as coverage while guarding nothing. That is what happened: the signature was a
// hand-typed copy of `flag NOT IN ('normal', 'immune')`, #2937 re-spelled that clause
// as the positive `flag IN (…)` the display tiers use, and the file stayed green.
//
// Two changes, because the first alone was not enough. The signature is now BUILT from
// the same fragment the query emits (`flagInSql`), so a re-tiering cannot drift it —
// and, since that still says nothing about the SQL the production code really
// compiles (a whitespace-only re-spelling defeats it, and a self-check written against
// the same constant only confirms the regex matches its own construction), the file
// CAPTURES what `collectAttentionModel` compiles and asserts the signature against
// THAT. A positive match count is the control: "matched nothing" is now red.
const NOW_READ = /datetime\('now'/;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const FLAGGED_PREDICATE = flagInSql(NOTABLE_FLAGS);
const FLAGGED_CTE = new RegExp(
  `WITH[\\s\\S]*FROM medical_records[\\s\\S]*${escapeRe(FLAGGED_PREDICATE)}`
);

// Every SQL text the FIRST gather in this file compiles. That gather is the one that
// compiles the hoisted statements: lib/db.ts caches them in a WeakMap keyed on the
// connection HANDLE, and this tier rebinds a fresh handle per file, so the cache
// starts empty here. Captured in beforeAll, before any test has gathered.
let compiledByFirstGather: string[] = [];

function captureCompiledSql(gather: () => void): string[] {
  const captured: string[] = [];
  const real = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
    captured.push(sql);
    return real(sql);
  }) as typeof db.prepare);
  try {
    gather();
  } finally {
    vi.restoreAllMocks();
  }
  return captured;
}

function countPrepareSet(...signatures: RegExp[]): { calls: () => number }[] {
  const counts = signatures.map(() => 0);
  const real = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
    signatures.forEach((s, i) => {
      if (s.test(sql)) counts[i]++;
    });
    return real(sql);
  }) as typeof db.prepare);
  return signatures.map((_, i) => ({ calls: () => counts[i] }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  db.prepare(
    "INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'timezone', 'UTC')"
  ).run(id);
  return id;
}

// A flagged lab reading whose IMPORT stamp and COLLECTION date are set independently,
// which is what makes the two halves of the window separately testable.
function addFlaggedLab(
  profileId: number,
  name: string,
  opts: { createdDaysAgo: number; collectedDaysAgo: number }
): void {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, value_num, unit, canonical_name, flag,
        created_at)
     VALUES (?, ?, 'lab', ?, '1', 1, 'mg/dL', ?, 'high',
             datetime('now', ?))`
  ).run(
    profileId,
    shiftDateStr(today(profileId), -opts.collectedDaysAgo),
    name,
    name,
    `-${opts.createdDaysAgo} days`
  );
}

function flaggedTitles(profileId: number): string[] {
  return collectAttentionModel(profileId, today(profileId))
    .filter((i) => i.domain === "biomarker-flag")
    .map((i) => i.title);
}

describe("flagged-biomarker attention window (#2112)", () => {
  let pWindow: number;
  let pQuiet: number;

  beforeAll(() => {
    pWindow = newProfile("FW-Window");
    pQuiet = newProfile("FW-Quiet");

    // Imported and collected two days ago — comfortably inside both halves.
    addFlaggedLab(pWindow, "Ferritin fw", {
      createdDaysAgo: 2,
      collectedDaysAgo: 2,
    });
    // Imported one day INSIDE the window's far edge.
    addFlaggedLab(pWindow, "Vitamin D fw", {
      createdDaysAgo: FLAGGED_ATTENTION_WINDOW_DAYS - 1,
      collectedDaysAgo: FLAGGED_ATTENTION_WINDOW_DAYS - 1,
    });
    // Imported one day OUTSIDE it.
    addFlaggedLab(pWindow, "Magnesium fw", {
      createdDaysAgo: FLAGGED_ATTENTION_WINDOW_DAYS + 1,
      collectedDaysAgo: FLAGGED_ATTENTION_WINDOW_DAYS + 1,
    });
    // A HISTORY BACKFILL: imported today, collected years ago. The collection-date
    // half of the window (#557 fix 2) keeps it out.
    addFlaggedLab(pWindow, "Zinc fw", {
      createdDaysAgo: 0,
      collectedDaysAgo: 900,
    });
    // pQuiet has nothing flagged at all.

    // FIRST gather of the file, instrumented: this is where the hoisted statements
    // are compiled, so it is the only moment their text can be observed.
    compiledByFirstGather = captureCompiledSql(() =>
      collectAttentionModel(pWindow, today(pWindow))
    );
  });

  it("the flagged-pass signature matches SQL the gather really compiles", () => {
    // THE CONTROL for the `toBe(0)` assertion below. Without it, a signature that
    // matches nothing — because a tier was re-spelled, or a clause was rewrapped —
    // passes that assertion and the pin silently stops pinning.
    const matched = compiledByFirstGather.filter((sql) =>
      FLAGGED_CTE.test(sql)
    );
    expect(
      matched.length,
      `No statement compiled by collectAttentionModel matches the flagged-pass ` +
        `signature. Either the pass stopped running, or its SQL was re-spelled and ` +
        `this signature no longer describes it — in which case the zero-compile ` +
        `assertion below is vacuous. Compiled texts:\n${compiledByFirstGather.join("\n---\n")}`
    ).toBeGreaterThanOrEqual(1);
    // …and it is the statement this file means: the profile-scoped flagged read.
    expect(matched[0]).toContain("profile_id = ?");
    expect(matched[0]).toContain("category = 'lab'");
  });

  it("keeps the 14-day boundary exactly where the SQL round-trip put it", () => {
    const titles = flaggedTitles(pWindow).join(" | ");
    expect(titles).toContain("Ferritin fw");
    expect(titles).toContain("Vitamin D fw");
    expect(titles).not.toContain("Magnesium fw");
    expect(titles).not.toContain("Zinc fw");
  });

  it("reports nothing for a profile with no flagged readings", () => {
    expect(flaggedTitles(pQuiet)).toEqual([]);
  });

  it("computes the window start with no DB round-trip", () => {
    // Warm the per-connection statement cache first, so this test does not depend on
    // whether an earlier test in the file already compiled the heavy pass.
    collectAttentionModel(pWindow, today(pWindow));

    const [nowRead, flaggedCte] = countPrepareSet(NOW_READ, FLAGGED_CTE);
    const flagged = collectAttentionModel(pWindow, today(pWindow)).filter(
      (i) => i.domain === "biomarker-flag"
    );
    // The `SELECT datetime('now', ?)` that used to run once per flaggedInWindow call
    // — i.e. twice per member per /upcoming render — is gone entirely.
    expect(nowRead.calls()).toBe(0);
    // The heavy pass it feeds no longer COMPILES per gather either (#2110 hoisted it,
    // so it compiles once per connection). That it still RUNS is proven by its output
    // rather than by a compile count — the two stopped being the same measurement.
    expect(flaggedCte.calls()).toBe(0);
    expect(flagged.map((i) => i.title).join(" | ")).toContain("Ferritin fw");
  });
});
