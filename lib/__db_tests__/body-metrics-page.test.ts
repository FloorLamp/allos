// DB INTEGRATION TIER — the paged body-metrics history read (#2530).
//
// The Trends body History table is deliberately ALL-TIME: it is the record editor, so
// a stray row you want to delete has to stay reachable even when it sits outside the
// window the charts above are showing. That makes the PAGE its only bound, and before
// this the read had none — `getBodyMetricsWithSource(profileId, ALL_ROWS)` serialized
// every row a profile had ever recorded into every render of the census.
//
// What is pinned here: the page is a real LIMIT/OFFSET (not a slice of everything),
// the order is total so no row straddles or falls through a page boundary, the total
// counts the whole ledger, an out-of-range page lands on the last real one, and the
// read stays profile-scoped.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { getBodyMetricsOnDate, getBodyMetricsPage } from "@/lib/queries";

const ROWS = 25;
const FIRST_DAY = "2026-01-01";

let profileId: number;
let otherId: number;

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// body_metrics keys on (profile_id, date, source), so several rows on ONE day are
// several SOURCES reporting it — which is exactly the case the page order has to be
// total for.
function insert(
  profile: number,
  date: string,
  weightKg: number,
  source = "manual"
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO body_metrics (profile_id, date, weight_kg, source)
         VALUES (?, ?, ?, ?)`
      )
      .run(profile, date, weightKg, source).lastInsertRowid
  );
}

beforeAll(() => {
  profileId = newProfile("BodyPage");
  otherId = newProfile("BodyPageOther");
  for (let i = 0; i < ROWS; i++) {
    insert(profileId, shiftDateStr(FIRST_DAY, i), 80 + i / 10);
  }
  // Another profile's ledger, which must never reach this one's pages.
  insert(otherId, FIRST_DAY, 60);
});

describe("getBodyMetricsPage (#2530)", () => {
  it("returns one page of rows plus the total of the whole ledger", () => {
    const first = getBodyMetricsPage(profileId, 1, 10);
    expect(first.rows).toHaveLength(10);
    expect(first.total).toBe(ROWS);
    expect(first.page).toBe(1);
    // Newest first: the last day seeded leads.
    expect(first.rows[0].date).toBe(shiftDateStr(FIRST_DAY, ROWS - 1));
  });

  it("pages disjointly and completely over the ledger", () => {
    const seen: number[] = [];
    for (let page = 1; page <= 3; page++) {
      seen.push(...getBodyMetricsPage(profileId, page, 10).rows.map((r) => r.id));
    }
    expect(seen).toHaveLength(ROWS); // 10 + 10 + 5, no gaps and no repeats
    expect(new Set(seen).size).toBe(ROWS);
  });

  it("orders same-day rows totally, so a page boundary cannot drop or duplicate one", () => {
    const crowded = newProfile("BodyPageSameDay");
    const day = "2026-03-03";
    const ids = [
      insert(crowded, day, 70, "manual"),
      insert(crowded, day, 71, "withings"),
      insert(crowded, day, 72, "oura"),
      insert(crowded, day, 73, "fitbit-takeout"),
    ];
    const one = getBodyMetricsPage(crowded, 1, 2);
    const two = getBodyMetricsPage(crowded, 2, 2);
    expect([...one.rows, ...two.rows].map((r) => r.id)).toEqual(
      [...ids].reverse()
    );
  });

  it("clamps a page past the end onto the last real page", () => {
    const last = getBodyMetricsPage(profileId, 99, 10);
    expect(last.page).toBe(3);
    expect(last.rows).toHaveLength(5);
    // …and an empty ledger still reads as page 1 of 1 rather than a negative offset.
    const empty = getBodyMetricsPage(newProfile("BodyPageEmpty"), 4, 10);
    expect(empty).toMatchObject({ total: 0, page: 1 });
    expect(empty.rows).toEqual([]);
  });

  it("is profile-scoped", () => {
    const mine = getBodyMetricsPage(profileId, 3, 10);
    const owners = new Set(
      (
        db
          .prepare(
            `SELECT DISTINCT profile_id AS p FROM body_metrics WHERE id IN (${mine.rows
              .map(() => "?")
              .join(",")})`
          )
          .all(...mine.rows.map((r) => r.id)) as { p: number }[]
      ).map((r) => r.p)
    );
    expect([...owners]).toEqual([profileId]);
    expect(getBodyMetricsPage(otherId, 1, 10).total).toBe(1);
  });
});

describe("getBodyMetricsOnDate (#2530)", () => {
  it("answers about a day regardless of which history page is open", () => {
    const day = shiftDateStr(FIRST_DAY, 0); // the OLDEST row — page 3 of the table
    const rows = getBodyMetricsOnDate(profileId, day);
    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe(day);
    expect(getBodyMetricsOnDate(profileId, "2020-01-01")).toEqual([]);
  });
});
