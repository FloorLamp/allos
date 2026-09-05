// THE INVALIDATION PROOF for the dashboard tail memo (#5073).
//
// The speed is the receipt; THIS is the deliverable. A memo over health data fails by
// answering from before a write — a dismissed finding that comes back, a logged dose
// the coaching input has not seen — and the two signals that stop it are blind to
// different halves of the world:
//
//   - `total_changes()` sees only THIS connection's writes,
//   - `PRAGMA data_version` sees only every OTHER connection's,
//
// so a test that drives one case cannot fail when the other signal is removed. Each
// mutation below is therefore asserted twice: on the VALUE the gather returns (the
// stale read itself) and on whether the gather ran at all (the receipt). Removing
// either half of the version in lib/commit-cache.ts reds the corresponding row.
//
// THE SECOND CONNECTION IS THE CASE NOBODY WOULD THINK TO CHECK, and it is not
// hypothetical: three processes write this file (the web app, the hourly notify tick,
// the poll sidecar), and lib/tick-cache.ts names the sidecar and the Telegram poll loop
// as other-process writers of the very suppression bus these findings ride.
import Database from "better-sqlite3";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { db, dbFilePath, today, writeTx } from "@/lib/db";
import {
  installStatementTrace,
  requestCache,
} from "@/lib/__db_tests__/dashboard-render-harness";
import { collectCoachingFindings } from "@/lib/rule-findings";
import {
  gatherCoachingInput,
  getActiveProtocolSummaries,
  getHealthspanPillars,
  getScheduledAppointments,
} from "@/lib/queries";
import { getRecapCard } from "@/lib/notifications/recap-data";

vi.mock("@/lib/request-cache", async () =>
  (
    await import("@/lib/__db_tests__/dashboard-render-harness")
  ).requestCacheModule()
);

let profileId = 0;
let trace: ReturnType<typeof installStatementTrace>;

// EVERY CASE GETS ITS OWN PROFILE, because the profile id is part of the memo key and
// therefore the only reset that does not itself depend on a signal under test. A case
// that reached its cold state by WRITING would red under the mutation that removes the
// own-write signal whether or not the case was about own writes, and a falsification
// that reds everything says nothing about which half is load-bearing.
function freshProfile(label: string): void {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(label)
      .lastInsertRowid
  );
}

// THE MEMO'S OWN COST, and the reason a warm load reads 1 rather than 0. `commitCached`
// reads its version pair once per request: `PRAGMA data_version` is invisible to the
// trace (better-sqlite3's `pragma()` bypasses `db.prepare`) and `SELECT total_changes()`
// is one statement. It is not one of the six gathers' statements — it is what a warm
// load spends INSTEAD of all of them.
const VERSION_READ = 1;

/** The six gathers above the dashboard's first candidate, called as the page calls them. */
const GATHERS: { name: string; run: () => unknown }[] = [
  {
    name: "collectCoachingFindings",
    run: () => collectCoachingFindings(profileId, today(profileId), "kg"),
  },
  {
    name: "gatherCoachingInput",
    run: () => gatherCoachingInput(profileId, "kg", "km"),
  },
  { name: "getRecapCard", run: () => getRecapCard(profileId, "kg") },
  { name: "getHealthspanPillars", run: () => getHealthspanPillars(profileId) },
  {
    name: "getActiveProtocolSummaries",
    run: () => getActiveProtocolSummaries(profileId, today(profileId), "kg"),
  },
  {
    name: "getScheduledAppointments",
    run: () => getScheduledAppointments(profileId),
  },
];

/** One request: a `cache()` scope open around `fn`, returning the statements it issued. */
async function load(fn: () => void): Promise<number> {
  trace.clear();
  await requestCache.during(async () => fn());
  return trace.count();
}

/** All six gathers in one request, as a dashboard render reaches them. */
const allGathers = (): void => {
  for (const gather of GATHERS) gather.run();
};

function bookAppointment(handle: Database.Database, day: string): void {
  handle
    .prepare(
      `INSERT INTO appointments (profile_id, date, time_of_day, status, title)
       VALUES (?, ?, '09:00', 'scheduled', 'checkup')`
    )
    .run(profileId, day);
}

/** The three ways a commit reaches this process, and only these three exist. */
const MUTATIONS: { name: string; commit: (day: string) => void }[] = [
  {
    // The path #5073 named, and the one every write TRANSACTION takes.
    name: "a writeTx write on this process",
    commit: (day) => writeTx(() => bookAppointment(db, day)),
  },
  {
    // The path #5073's proposed writeTx counter would have MISSED. A single-statement
    // write needs no transaction and dozens of actions skip it — `deleteAppointment`
    // is a bare DELETE on this very table.
    name: "a bare single-statement write on this process",
    commit: (day) => bookAppointment(db, day),
  },
  {
    // The notify sidecar and the Telegram poll loop, from this process's point of
    // view: a different connection to the same file. `total_changes()` cannot see it.
    name: "a commit from a second connection to the same file",
    commit: (day) => {
      const other = new Database(dbFilePath());
      try {
        bookAppointment(other, day);
      } finally {
        other.close();
      }
    },
  },
];

describe("the dashboard tail memo is invalidated by commits (#5073)", () => {
  beforeAll(() => {
    profileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('tail memo 5073')").run()
        .lastInsertRowid
    );
    trace = installStatementTrace();
  });

  // THE COLD COUNT IS THE CONTROL, and without it this whole file is vacuous: a memo
  // that returned nothing at all would satisfy "the warm load issues no statements"
  // exactly as well as one that works.
  it.each(GATHERS)(
    "$name: a second load with no write in between issues none of its statements",
    async ({ name, run }) => {
      freshProfile(`tail memo cold/warm ${name}`);
      const cold = await load(run);
      const warm = await load(run);
      expect(cold).toBeGreaterThan(VERSION_READ);
      expect(warm).toBe(VERSION_READ);
    }
  );

  it.each(MUTATIONS)(
    "$name makes the next load recompute rather than answer from before it",
    async ({ name, commit }) => {
      freshProfile(`tail memo ${name}`);
      const day = today(profileId);
      let booked = 0;
      await load(() => {
        allGathers();
      });
      // The memo is warm: this load reads every gather and issues nothing.
      const warm = await load(() => {
        booked = getScheduledAppointments(profileId).length;
        allGathers();
      });
      expect(warm).toBe(VERSION_READ);

      commit(day);

      let bookedAfter = 0;
      const recompute = await load(() => {
        bookedAfter = getScheduledAppointments(profileId).length;
        allGathers();
      });
      // The VALUE, not only the receipt: the appointment the commit booked is on the
      // next load's answer. This is the assertion a stale memo fails.
      expect(bookedAfter).toBe(booked + 1);
      expect(recompute).toBeGreaterThan(VERSION_READ);
    }
  );

  it("is a passthrough with no request open, like cache() and tickCached", () => {
    freshProfile("tail memo passthrough");
    trace.clear();
    getScheduledAppointments(profileId);
    const first = trace.count();
    trace.clear();
    getScheduledAppointments(profileId);
    expect(first).toBeGreaterThan(0);
    expect(trace.count()).toBe(first);
  });
});
