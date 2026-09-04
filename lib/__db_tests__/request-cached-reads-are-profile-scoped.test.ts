// DB INTEGRATION TIER — the request-cached dashboard reads, held to BOTH halves of
// what a memo has to be (#3369 item 2).
//
// Eight reads that one dashboard render asked the same question of more than once now
// go through `cache()` at their existing author. A memo like that has two ways to be
// wrong and they fail in opposite directions, so one assertion cannot watch both:
//
//   • IT CAN STOP COLLAPSING — the wrap is removed, a caller starts spelling its
//     arguments differently, a default argument sneaks back inside the memo — and
//     nothing goes red, because answering correctly twice is still answering
//     correctly. The query meter's baseline is what catches that as a number; the
//     `one profile asking twice` table below catches it as a fact about ONE read, so
//     a red names the read instead of naming the persona.
//   • IT CAN COLLAPSE TOO FAR — a key that does not carry `profile_id` — and that is
//     a cross-profile data leak wearing a performance win's clothes. A household
//     render asks every one of these questions of several profiles; if the memo
//     answered Riley's question with the acting profile's row, the count would look
//     BETTER and the dashboard would be showing one person another person's health.
//
// So the table runs each read for two profiles inside ONE request scope and requires
// two different answers, and then runs it twice for one profile and requires one
// statement. Both go through the same memo the query meter counts through — the
// harness's `requestCache`, installed over `lib/request-cache` exactly as the meter
// installs it — because a control that re-queries instead of re-using proves nothing.
//
// PROVEN ABLE TO FAIL by dropping the arguments from that memo's key (one line in
// `dashboard-render-harness.ts`, the forgery of exactly the defect above): all eight
// rows of the first table go red and the second table stays green, which is the
// signature the two tables exist to tell apart.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { db, today } from "@/lib/db";
import {
  installStatementTrace,
  requestCache,
} from "@/lib/__db_tests__/dashboard-render-harness";
import { getLatestBodyMetricDated, getWeights } from "@/lib/queries/metrics";
import { getOutcomeGoals } from "@/lib/queries/training/outcome-goals";
import { getFoodDailyServingTotals } from "@/lib/queries/nutrition";
import { getActiveMedicationFamilies } from "@/lib/queries/intake/prn-family";
import { getActiveRoutine } from "@/lib/routines";
import {
  getEpisodeRowForDate,
  mostRecentClosedEpisodeRow,
} from "@/lib/illness-episode-store";

vi.mock("@/lib/request-cache", async () =>
  (
    await import("@/lib/__db_tests__/dashboard-render-harness")
  ).requestCacheModule()
);

// One row per wrapped read: how to give this profile an answer only it has, and how to
// ask. `ask` returns the identifying part of the answer, so a leak reads as two
// profiles reporting one string rather than as a deep-equality diff nobody can scan.
const READS: {
  name: string;
  seed: (profileId: number, mark: string, day: string) => void;
  ask: (profileId: number, day: string) => string | undefined;
}[] = [
  {
    name: "getActiveRoutine",
    seed: (id, mark) =>
      db
        .prepare(
          "INSERT INTO routines (name, source, active, profile_id) VALUES (?, 'custom', 1, ?)"
        )
        .run(`routine ${mark}`, id),
    ask: (id) => getActiveRoutine(id)?.name,
  },
  {
    name: "getWeights",
    seed: (id, mark, day) =>
      db
        .prepare(
          "INSERT INTO body_metrics (profile_id, date, weight_kg) VALUES (?, ?, ?)"
        )
        .run(id, day, 70 + Number(mark)),
    ask: (id) => String(getWeights(id)[0]?.weight_kg),
  },
  {
    name: "getLatestBodyMetricDated",
    // Shares the weight row seeded above — the two reads are separate memo entries
    // over one table, which is the arrangement a shared key would silently merge.
    seed: () => {},
    ask: (id) => String(getLatestBodyMetricDated(id, "weight")?.value),
  },
  {
    name: "getOutcomeGoals",
    seed: (id, mark) =>
      db
        .prepare("INSERT INTO goals (profile_id, title) VALUES (?, ?)")
        .run(id, `goal ${mark}`),
    ask: (id) => getOutcomeGoals(id)[0]?.title,
  },
  {
    name: "getFoodDailyServingTotals",
    seed: (id, mark, day) =>
      db
        .prepare(
          "INSERT INTO food_daily_totals (profile_id, date, group_key, servings) VALUES (?, ?, ?, ?)"
        )
        .run(id, day, "vegetables", 1 + Number(mark)),
    ask: (id, day) => String(getFoodDailyServingTotals(id, day)[0]?.servings),
  },
  {
    name: "getActiveMedicationFamilies",
    seed: (id, mark) =>
      db
        .prepare(
          "INSERT INTO intake_items (profile_id, name, kind, active) VALUES (?, ?, 'medication', 1)"
        )
        .run(id, `medicine ${mark}`),
    ask: (id) => getActiveMedicationFamilies(id)[0]?.members[0]?.name,
  },
  {
    name: "getEpisodeRowForDate",
    seed: (id, mark, day) =>
      db
        .prepare(
          "INSERT INTO illness_episodes (profile_id, situation, start_date, end_date) VALUES (?, ?, ?, NULL)"
        )
        .run(id, `open situation ${mark}`, day),
    ask: (id, day) => getEpisodeRowForDate(id, day)?.situation,
  },
  {
    name: "mostRecentClosedEpisodeRow",
    // Closed well before `day`, so it cannot answer the open read above by accident.
    seed: (id, mark) =>
      db
        .prepare(
          "INSERT INTO illness_episodes (profile_id, situation, start_date, end_date) VALUES (?, ?, '2020-01-05', '2020-01-09')"
        )
        .run(id, `closed situation ${mark}`),
    ask: (id) => mostRecentClosedEpisodeRow(id)?.situation,
  },
];

describe("request-cached dashboard reads are scoped to one profile (#3369)", () => {
  let first = 0;
  let second = 0;
  let day = "";
  let trace: ReturnType<typeof installStatementTrace>;

  beforeAll(() => {
    const newProfile = (name: string) =>
      Number(
        db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
          .lastInsertRowid
      );
    first = newProfile("cache scope one");
    second = newProfile("cache scope two");
    day = today(first);
    for (const [index, profileId] of [first, second].entries())
      for (const read of READS) read.seed(profileId, String(index + 1), day);
    trace = installStatementTrace();
  });

  it.each(READS.map((read) => [read.name, read] as const))(
    "%s: two profiles asking in one request get their own answer",
    (_name, read) => {
      const answers = requestCache.during(async () => ({
        one: read.ask(first, day),
        two: read.ask(second, day),
        oneAgain: read.ask(first, day),
      }));
      return answers.then(({ one, two, oneAgain }) => {
        expect(one).toBeDefined();
        expect(one).not.toEqual(two);
        // …and the second profile's read did not evict the first one's answer.
        expect(oneAgain).toEqual(one);
      });
    }
  );

  it.each(READS.map((read) => [read.name, read] as const))(
    "%s: one profile asking twice in one request issues one statement",
    async (_name, read) => {
      await requestCache.during(async () => {
        trace.clear();
        read.ask(first, day);
        const firstAsk = trace.count();
        // A read that issued nothing would make the repeat trivially free, so the
        // memo would be untested. This is the positive control for the count below.
        expect(firstAsk).toBeGreaterThan(0);
        read.ask(first, day);
        expect(trace.count()).toEqual(firstAsk);
      });
    }
  );
});
