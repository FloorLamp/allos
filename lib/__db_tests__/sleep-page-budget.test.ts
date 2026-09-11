// DB INTEGRATION TIER — the /sleep route's statement budget (#3993).
//
// WHY THIS FILE EXISTS. Two budget gates walk a route today: the dashboard
// (dashboard-placement-manifest.test.ts, `QUERY_CEILING = 269`) and the Trends Overview
// (trends-overview-budget.test.ts). Neither walks /sleep — and #3993 put an
// `effectiveSituationResolver` inside `bedtimeSupplementsByWakeDay`, which /sleep renders
// for every night of its history. That made the sleep page's cost a number taken on
// trust: nothing in the suite could say whether the route can reach the same ceiling the
// dashboard is held to. It can be measured, so it is.
//
// WHAT THIS GATE DOES NOT COVER, because its silence would otherwise read as coverage
// (#5199). It walks ONE ROUTE RENDER with a request cache open. It says nothing about
// the notification tick, which runs the same query layer with `cache()` degraded to
// identity — that is tick-gather-budget.test.ts — and nothing about wall time, which is
// docs/internals/profiling.md's reading.
//
// THE CEILING IS THE DASHBOARD'S, borrowed rather than re-derived — so it FOLLOWS the
// dashboard's, which is the half this file had stopped doing. It was written at 274,
// the dashboard moved to 279 and then to 269 (#5435 §7's cutover acceptance), and a
// borrowed number that stops tracking its source is a second opinion wearing a
// citation. /sleep is a single domain page against the dashboard's whole placement
// census, so it has no business costing what the dashboard costs; 269 is a backstop it
// should not come near, and the recorded per-persona counts below are the real gate.
// Both are asserted, for the reason the dashboard's own comment gives: a recorded
// number catches drift, a backstop catches the thing nobody thought to record.

import { beforeAll, describe, expect, it, vi, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { PERSONAS } from "../../scripts/seed-personas";
import { personaContextFor } from "@/lib/__db_tests__/persona-fixture";
import {
  allProfileIds,
  installStatementTrace,
  loadPage,
  pageProps,
  profilesForIds as profiles,
  renderPage,
  session,
} from "@/lib/__db_tests__/dashboard-render-harness";

vi.mock("@/lib/request-cache", async () =>
  (
    await import("@/lib/__db_tests__/dashboard-render-harness")
  ).requestCacheModule()
);
vi.mock("@/lib/auth", async (importActual) =>
  (await import("@/lib/__db_tests__/dashboard-render-harness")).authModule(
    await importActual()
  )
);
vi.mock("@/lib/scope", async (importActual) =>
  (await import("@/lib/__db_tests__/dashboard-render-harness")).scopeModule(
    await importActual(),
    await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth")
  )
);

const counts = new Map<string, number>();

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

describe("/sleep route query budget (#3993)", () => {
  beforeEach(() => vi.setSystemTime(new Date("2026-08-18T13:00:00.000Z")));
  beforeAll(async () => {
    vi.setSystemTime(new Date("2026-08-18T13:00:00.000Z"));
    session.loginId = (
      db
        .prepare(
          "SELECT id FROM logins WHERE role = 'admin' ORDER BY id LIMIT 1"
        )
        .get() as { id: number }
    ).id;
    const trace = installStatementTrace({});
    const SleepPage = await loadPage("app/(app)/sleep/page");
    for (const persona of PERSONAS) {
      const before = new Set(allProfileIds());
      const profileId = newProfile(`sleep:${persona.name}`);
      persona.apply(personaContextFor(profileId));
      const createdIds = allProfileIds().filter((id) => !before.has(id));
      session.accessible = profiles(createdIds);
      session.profile = session.accessible.find((p) => p.id === profileId)!;
      trace.clear();
      await renderPage(SleepPage, pageProps());
      counts.set(persona.name, trace.count());
    }
  }, 120_000);

  // Recorded render counts: #5157 lowers every persona by five (69→64, 110→105).
  // The new outcome resolver reuses the chart's one-argument trend cache entry;
  // the old insight passed (profileId, undefined), missing that entry. Its duplicate
  // pass read profile timezone, fallback instance timezone, timezone_switches and
  // free_days. These fixtures set no profile timezone. The timezone reader uses its
  // own React.cache, outside this harness's request-cache mock, so both timezone
  // reads count here; the nested sleep-session reader already hits the shared cache.
  // The fifth saving is the old unconditional situation_events read: none of these
  // personas has a sufficient trailing SRI comparison, so the new note stops first.
  // These are this harness's statement counts, not a production-query savings claim.
  const BASELINES: Record<string, number> = {
    bodybuilder: 64,
    "marathon-runner": 64,
    household: 64,
    pregnant: 64,
    "diabetic-cgm": 64,
    biohacker: 105,
  };

  // The dashboard's backstop, borrowed and kept in step with it (#5435 §7 lowered it
  // to 269). /sleep is one domain page; reaching this would mean it costs what the
  // entire dashboard census costs. The heaviest persona is 105 against it — the answer
  // to the question nobody had asked, which was whether this route could exceed a
  // ceiling no gate applies to it.
  const QUERY_CEILING = 269;

  it("stays at its recorded per-persona counts", () => {
    expect(Object.fromEntries(counts)).toEqual(BASELINES);
  });

  it("no persona reaches the dashboard's backstop", () => {
    for (const [persona, count] of counts)
      expect(
        count,
        `${persona}: ${count} against ${QUERY_CEILING}`
      ).toBeLessThan(QUERY_CEILING);
  });
});
