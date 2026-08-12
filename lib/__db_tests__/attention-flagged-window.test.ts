// DB INTEGRATION TIER — the attention hero's flagged-biomarker window (#2112).
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

// The two statements this change is about: the retired now-read, and the heavy
// DEDUP+LATEST pass the window feeds.
const NOW_READ = /datetime\('now'/;
const FLAGGED_CTE = /WITH[\s\S]*FROM medical_records[\s\S]*flag NOT IN \('normal', 'immune'\)/;

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
    const [nowRead, flaggedCte] = countPrepareSet(NOW_READ, FLAGGED_CTE);
    collectAttentionModel(pWindow, today(pWindow));
    // The `SELECT datetime('now', ?)` that used to run once per flaggedInWindow call
    // — i.e. twice per member per /upcoming render — is gone entirely.
    expect(nowRead.calls()).toBe(0);
    // The heavy pass it feeds still runs, once, for this one gather.
    expect(flaggedCte.calls()).toBe(1);
  });
});
