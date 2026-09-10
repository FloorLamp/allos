// DB INTEGRATION TIER — the app shell's statement budget (#5669).
//
// WHY THIS FILE EXISTS. Route meters walk Home (dashboard-placement-manifest.test.ts),
// /sleep, the Trends Overview and the Training hub, and tick-gather-budget.test.ts
// walks the notification tick. Nothing metered `app/(app)/layout.tsx`, the shell EVERY
// authenticated route pays before its page runs a statement: the identity and scope,
// the login's and profile's preferences, the activity editor's suggestions, history,
// equipment and recovery context, workout presence, the nav-relevance bits, the log
// sheet's habit days and the travel banner's zones. Owner ruling 2026-09-09: the Home
// test — fewer statements per render, downward only — applies to the surfaces opened
// daily, and the shell is the one opened on every route.
//
// LOWERING IS THE ONLY ALLOWED EDIT TO THE TABLE BELOW. A count above its recorded
// baseline is a gather this change added, and the fix is in the code in front of you,
// never in the number. A count below it is a saving, and the same change records it by
// lowering the number. There is no backstop constant beside the table because a rule
// that forbids raising is already stronger than any ceiling.
//
// WHAT THIS GATE DOES NOT COVER, because its silence would otherwise read as coverage
// (#5199). It renders ONE SHELL per persona with a request cache open and a trivial
// element in the page slot: the page inside the shell is not in this count — Home,
// /training and the others have their own meters. Every component the shell mounts is
// a client component; the walk skips them and they cannot query. The notification tick
// runs the same query layer with `cache()` degraded to identity and is
// tick-gather-budget.test.ts's; wall time is docs/internals/profiling.md's.
//
// THE TREE IS WALKED, NOT JUST THE LAYOUT FUNCTION. Today the shell gathers inline, so
// awaiting `AppLayout()` is the whole render. The walk with `resolveAsyncTree` is kept
// anyway, inside the SAME request scope, so a gather moved into a streamed section of
// the shell would still be counted — and so the positive control below can say the walk
// reached the page slot.

import { beforeAll, describe, expect, it, vi, beforeEach } from "vitest";
import { createElement, type ReactElement, type ReactNode } from "react";
import { db } from "@/lib/db";
import { PERSONAS } from "../../scripts/seed-personas";
import { personaContextFor } from "@/lib/__db_tests__/persona-fixture";
import { perTestCeiling } from "../../vitest.timeouts";
import {
  allProfileIds,
  installStatementTrace,
  loadPage,
  profilesForIds as profiles,
  requestCache,
  resolveAsyncTree,
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
/** Whether the walk ran the element in the page slot, per persona — the positive control. */
const slotReached = new Map<string, boolean>();

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// A HOOK CEILING AS A MULTIPLE (#4002), the Training hub meter's. The hook seeds every
// persona and renders the shell once each; the six renders are under a second between
// them and the seeding is the hook. Measured on the dispatch box: 7.5 s
// for the hook against a 60 000 ms ceiling on CI (4x the 15 s test budget), and this
// tier moves 3-4x per file between two green runs (#3999). The basis is a green local
// reading; nothing has timed it on the runner.
const SEED_AND_RENDER_HOOK_MS = perTestCeiling(4, "green");

describe("app shell query budget (#5669)", () => {
  beforeEach(() => vi.setSystemTime(new Date("2026-08-18T13:00:00.000Z")));
  beforeAll(async () => {
    // The instant the other route meters pin, so a trailing window is the same number
    // of days on every run.
    vi.setSystemTime(new Date("2026-08-18T13:00:00.000Z"));
    session.loginId = (
      db
        .prepare(
          "SELECT id FROM logins WHERE role = 'admin' ORDER BY id LIMIT 1"
        )
        .get() as { id: number }
    ).id;
    const trace = installStatementTrace({});
    // The layout takes `{ children }` where a page takes route props; the loader's
    // signature is the page's, so it is widened here rather than given a second loader.
    const AppLayout = (await loadPage(
      "app/(app)/layout"
    )) as unknown as (props: { children: ReactNode }) => Promise<ReactElement>;
    for (const persona of PERSONAS) {
      const before = new Set(allProfileIds());
      const profileId = newProfile(`shell:${persona.name}`);
      persona.apply(personaContextFor(profileId));
      const createdIds = allProfileIds().filter((id) => !before.has(id));
      session.accessible = profiles(createdIds);
      session.profile = session.accessible.find((p) => p.id === profileId)!;
      // The trivial page: a sync component that records the walk ran it, which is
      // how this file knows the walk went all the way down the shell's providers to
      // the slot the page renders in.
      let reached = false;
      const PageSlot = () => {
        reached = true;
        return null;
      };
      trace.clear();
      await requestCache.during(async () =>
        resolveAsyncTree(await AppLayout({ children: createElement(PageSlot) }))
      );
      counts.set(persona.name, trace.count());
      slotReached.set(persona.name, reached);
    }
  }, SEED_AND_RENDER_HOOK_MS);

  // THE RECORDED MAIN BASELINE, one cold shell render per persona, measured at landing.
  // The statements fall into these groups, heaviest first on `bodybuilder`:
  //   - settings key-value reads: the profile's, the login's and the global fallback
  //     rows, one statement per key (timezone, units, week start, age and birthdate,
  //     format prefs, the What's-new marker, RPE opt-in, onboarding, travel zones and
  //     the rest) — over a third of every persona's count, and the part that grows
  //     with the household, whose quick-entry timezones are read per writable member;
  //   - the activity editor's inputs: recent exercise counts and sets for the
  //     suggestions and history, the strength weight-seen and set-history scans, the
  //     trailing activity windows, active equipment and recently used equipment ids,
  //     the latest weight, the weight series and the most recent activity;
  //   - recovery and deload context: the active routine, injuries, niggles and the
  //     upcoming dismissals the plateau hints consult;
  //   - workout presence, plus the live activity's edit data when a persona is
  //     mid-session;
  //   - nav relevance: one existence probe each for cycles, optical prescriptions,
  //     dental procedures, practice targets and logs, progress photos, the specialty
  //     encounters and deduplicated conditions;
  //   - the import review count: pair decisions per domain, the midnight-split and
  //     duplicate body-metric scans, the sync-event sources and the connection row;
  //   - one or two reads each for the rest: the write-revision marker, the scope's
  //     profile list and login role, the log sheet's habit days, intake presence and
  //     dose schedule, substance presence and the measurements quick-entry defaults.
  // The personas differ by household size and by whether a live workout is open —
  // never by history length.
  const BASELINES: Record<string, number> = {
    bodybuilder: 72,
    "marathon-runner": 79,
    household: 79,
    pregnant: 73,
    "diabetic-cgm": 74,
    biohacker: 72,
  };

  it("app shell query budget: each persona matches its recorded main baseline", () => {
    const drift = [...counts].flatMap(([persona, count]) => {
      const baseline = BASELINES[persona];
      if (baseline === undefined) {
        return [`${persona}: ${count} statements, but no recorded baseline`];
      }
      if (count === baseline) return [];
      const delta = count - baseline;
      return [
        `${persona}: ${count} statements, baseline ${baseline} ` +
          (delta > 0
            ? `(+${delta} spent by this change — remove the gather; the baseline is not raised)`
            : `(${delta} recovered by this change — lower the baseline to ${count})`),
      ];
    });
    expect(
      drift,
      "App shell statement counts moved off the recorded baseline.\n" +
        "Each line names one persona: what it measures now, what MAIN measures, and\n" +
        "the difference — this change's own cost, not main's. Lowering a number in\n" +
        "BASELINES is the only allowed edit to it."
    ).toEqual([]);
  });

  it("renders the whole shell down to the page slot on every persona", () => {
    // THE POSITIVE CONTROL. The layout body calls about thirty gathers unconditionally,
    // each at least one statement, so a render that counted fewer than that did not run
    // the shell — a trace that was never installed, or a layout that returned before its
    // gathers — and must not read as a 40-statement saving above. The slot check says
    // the walk went through every provider to where the page renders, so a gather that
    // moves into the shell's tree below the root is still inside this meter.
    for (const [persona, count] of counts)
      expect(count, `${persona}: statements`).toBeGreaterThan(30);
    for (const [persona, reached] of slotReached)
      expect(reached, `${persona}: the walk ran the page slot`).toBe(true);
  });
});
