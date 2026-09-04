// THE DASHBOARD PROFILER (#5010) — wall time, per-statement time and a CPU profile
// for one render over a real database. Run through `scripts/profile-dashboard.ts`,
// which sets the PROBE_* environment; without PROBE_DB the whole file is skipped, so
// `npm run test:db` never pays for it and never touches a snapshot.
//
// It shares `dashboard-render-harness.ts` with the query meter, so what it renders is
// exactly what the meter counts. The first render warms the module graph and is
// reported but not profiled; the CPU profile covers the renders after it.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, it, vi } from "vitest";
import { db, reopenDatabaseForTests } from "@/lib/db";
import {
  adminLoginId,
  allProfileIds,
  installStatementTrace,
  loadDashboard,
  loadPage,
  pageProps,
  profilesForIds,
  renderDashboard,
  renderPage,
  resolveAsyncTree,
  requestCache,
  session,
  withCpuProfile,
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
vi.mock("@/lib/ai-log", async (importActual) =>
  (await import("@/lib/__db_tests__/dashboard-render-harness")).aiLogModule(
    await importActual()
  )
);
vi.mock("@/lib/recommendation-engine", async (importActual) =>
  (
    await import("@/lib/__db_tests__/dashboard-render-harness")
  ).recommendationEngineModule(await importActual())
);

const PROBE_DB = process.env.PROBE_DB;
const previousDbPath = process.env.ALLOS_DB_PATH;
const previousTestNow = process.env.ALLOS_TEST_NOW;

describe.skipIf(!PROBE_DB)("dashboard profile over a database copy", () => {
  beforeAll(() => {
    process.env.ALLOS_DB_PATH = PROBE_DB;
    process.env.ALLOS_TEST_NOW =
      process.env.PROBE_NOW ?? new Date().toISOString();
    reopenDatabaseForTests();
    session.loginId = adminLoginId();
    const ids = allProfileIds();
    const wanted = Number(process.env.PROBE_PROFILE ?? ids[0]);
    session.accessible = profilesForIds(ids);
    session.profile =
      session.accessible.find((profile) => profile.id === wanted) ?? null;
    if (!session.profile)
      throw new Error(`profile ${wanted} is not in this database`);
  });

  afterAll(() => {
    vi.restoreAllMocks();
    if (previousDbPath === undefined) delete process.env.ALLOS_DB_PATH;
    else process.env.ALLOS_DB_PATH = previousDbPath;
    if (previousTestNow === undefined) delete process.env.ALLOS_TEST_NOW;
    else process.env.ALLOS_TEST_NOW = previousTestNow;
  });

  it("renders, times every statement, and writes a CPU profile", async () => {
    const out = process.env.PROBE_OUT ?? path.dirname(PROBE_DB!);
    const renders = Number(process.env.PROBE_RENDERS ?? 3);
    const trace = installStatementTrace({ timing: true });
    const pagePath = process.env.PROBE_PAGE;
    const render = pagePath
      ? (() => {
          const props = pageProps(
            JSON.parse(process.env.PROBE_ROUTE_PARAMS ?? "{}"),
            JSON.parse(process.env.PROBE_PARAMS ?? "{}")
          );
          return async () => renderPage(await loadPage(pagePath), props);
        })()
      : await (async () => {
          const Dashboard = await loadDashboard();
          return async () => renderDashboard(Dashboard);
        })();
    const timings: {
      wall: number;
      statements: number;
      sqlMs: number;
      components: number;
      skipped: string[];
    }[] = [];
    const renderOnce = async () => {
      trace.clear();
      const started = performance.now();
      const tree = await render();
      const resolved = await requestCache.during(() => resolveAsyncTree(tree));
      const wall = performance.now() - started;
      const stats = trace.stats();
      timings.push({
        wall: Math.round(wall),
        statements: trace.count(),
        sqlMs: Math.round(stats.reduce((sum, s) => sum + s.ms, 0)),
        components: resolved.components,
        skipped: resolved.skipped,
      });
    };
    await renderOnce();
    const { profile } = await withCpuProfile(async () => {
      for (let i = 1; i < renders; i += 1) await renderOnce();
    });
    const stats = trace.stats();
    const report = {
      page: pagePath ?? "app/(app)/page",
      db: PROBE_DB,
      now: process.env.ALLOS_TEST_NOW,
      profileId: session.profile!.id,
      renders: timings,
      statements: stats
        .map((s) => ({
          sql: s.sql,
          count: s.count,
          ms: Math.round(s.ms * 10) / 10,
          callers: [...s.callers.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([caller, ms]) => ({ caller, ms: Math.round(ms * 10) / 10 })),
        }))
        .sort((a, b) => b.ms - a.ms),
    };
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "profile.json"), JSON.stringify(report));
    fs.writeFileSync(
      path.join(out, "render.cpuprofile"),
      JSON.stringify(profile)
    );
    // The handle on the copy is released so the script can remove it.
    db.close();
  }, 300_000);
});
