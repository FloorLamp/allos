// DB INTEGRATION TIER — WHAT HAPPENS WHEN THE TICK RUNS MORE THAN ONCE AN HOUR
// (#2121 step 1).
//
// The scheduler sleeps to the hour boundary before its first tick, so intra-hour
// repetition has never been exercised in production. #2121's audit walked every
// family in tick order and found everything already idempotent under repetition
// EXCEPT four items; three of them are pinned here (the fourth is a documentation
// decision at slotDue), and they are pinned together because they are one question:
// run the tick twice inside one hour and nothing may double.
//
//   A. The pull pass polls each provider ONCE per its declared cadence window, and
//      the second tick in the window makes no external call at all.
//   B. `runCoachingEpisode` / `reconcileRestEpisode` — two calls in the same hour ≡
//      one (#2121 item 1).
//   C. `evaluateSyncRequests` — two calls in the same hour ≡ one, including the
//      supersession path whose own comment says it discusses a race it "should never
//      have seen" (#2121 item 2).
//   D. The point of the whole thing: the SECOND tick still EVALUATES. A condition
//      that becomes true between two ticks in the same hour is picked up by the
//      second one, while the providers are not re-polled.
//
// SEAM for A: the pull runners bottom out in global fetch; there is no injection
// point, so fetch is stubbed and routed by URL exactly as sync-orchestrators.test.ts
// and notify-orchestrators.test.ts do. The real registry, the real runners, the real
// recordSyncEvent all run — the guard is asserted against the calls it actually
// prevents, not against a mock of itself.
//
// Every value here is synthetic: obviously-fake tokens, fake portal names, fake
// activity ids. No PHI.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  enableWeather,
  recordSyncEvent,
  setOuraToken,
  setStravaCredentials,
  setStravaTokens,
} from "@/lib/integrations/connections";
import {
  lastPullAttemptAt,
  pullDecision,
  pullOffsetFor,
  syncIntegrations,
} from "@/lib/integrations/pull-tick";
import {
  parseSyncEventAt,
  pullCadenceMinutes,
  pullWindow,
} from "@/lib/integrations/pull-cadence";
import { getIntegration } from "@/lib/integrations/registry";
import type { IntegrationId } from "@/lib/types";
import {
  getRestEpisode,
  reconcileRestEpisode,
  runCoachingEpisode,
} from "@/lib/queries/coaching";
import type { Recommendation } from "@/lib/coaching/engine";
import {
  bindPortalIdentity,
  createPortal,
  createPortalAccount,
  accountsForPortal,
  recordPortalRunReport,
  type PortalAccount,
} from "@/lib/portals";
import { evaluateSyncRequests, listSyncRequests } from "@/lib/portal-requests";
import { STALENESS_CADENCE_DAYS } from "@/lib/sync-requests";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function syncEventCount(profileId: number, provider: string): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM integration_sync_events WHERE profile_id = ? AND provider = ?"
      )
      .get(profileId, provider) as { n: number }
  ).n;
}

// The instant a recorded attempt happened, as a Date — so a "second tick" can be
// placed in the SAME cadence window as the first deterministically, instead of
// relying on the test not straddling a wall-clock hour boundary.
function attemptInstant(profileId: number, provider: string): Date {
  const at = lastPullAttemptAt(profileId, provider);
  const ms = parseSyncEventAt(at);
  if (ms == null) throw new Error(`no recorded attempt for ${provider}`);
  return new Date(ms);
}

function plusMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60_000);
}

// When the cadence window that `d` falls in ENDS, for one (profile, source). Since
// #2567 the window boundary is phase-shifted by a stable per-(install, profile, source)
// offset, so "the end of the wall-clock hour" is no longer the same instant as "the end
// of this source's window" — and a fixture that assumed it was would be asserting the
// wrong thing about the right guard.
function windowEndMs(
  profileId: number,
  sourceId: IntegrationId,
  d: Date
): number {
  const cadence = pullCadenceMinutes(getIntegration(sourceId));
  const offset = pullOffsetFor(profileId, sourceId);
  const w = pullWindow(d.getTime(), cadence, offset);
  return (w + 1) * cadence * 60_000 + offset * 60_000;
}

// A LATER tick that is still the same poll opportunity for EVERY named source. Each
// source has its own phase, so the instant has to sit inside the intersection of their
// windows — which is non-empty by construction, because `d` is in all of them.
// Windows are fixed buckets, not "minutes since", so "30 minutes later" is not
// necessarily the same window; a fixture that assumed it was would be testing the wall
// clock rather than the guard.
function lateInSameWindow(
  d: Date,
  profileId: number,
  ...sourceIds: IntegrationId[]
): Date {
  const ends = sourceIds.map((id) => windowEndMs(profileId, id, d));
  return new Date(Math.min(...ends) - 1_000);
}

// ── A. The pull pass ─────────────────────────────────────────────────────────

// Every pull provider a profile can be connected to, stubbed at its own host. The
// counter is per HOST, which is the quantity #2121 is actually about: outbound calls
// to someone else's API.
function stubProviders(): Map<string, number> {
  const calls = new Map<string, number>();
  const bump = (host: string) => calls.set(host, (calls.get(host) ?? 0) + 1);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes("strava.com")) {
        bump("strava");
        // An empty activity page: a complete, quiet run.
        return new Response("[]", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.includes("ouraring.com")) {
        bump("oura");
        return new Response(JSON.stringify({ data: [], next_token: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.includes("open-meteo.com")) {
        bump("weather");
        return new Response(
          JSON.stringify({ hourly: {}, daily: {}, timezone: "UTC" }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      throw new Error(`unexpected outbound URL: ${u}`);
    })
  );
  return calls;
}

// A profile connected to two pull providers, with a still-valid Strava token so no
// refresh call is made (this is about poll cadence, not token refresh).
function connectedProfile(tag: string): number {
  const p = newProfile(`Tick ${tag}`);
  setOuraToken(p, "oura-test-token");
  setStravaCredentials(p, "strava-client", "strava-secret");
  setStravaTokens(p, {
    accessToken: "strava-access",
    refreshToken: "strava-refresh",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  return p;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the pull pass, run twice in one hour", () => {
  it("polls each provider ONCE per cadence window and makes no call on the second tick", async () => {
    const calls = stubProviders();
    const p = connectedProfile("once");

    const first = await syncIntegrations(p, new Date());
    expect(first.polled.sort()).toEqual(["oura", "strava"]);
    expect(first.skipped).toEqual([]);
    const afterFirst = new Map(calls);
    expect(afterFirst.get("strava")).toBeGreaterThan(0);
    expect(afterFirst.get("oura")).toBeGreaterThan(0);

    // The second tick, placed later in the SAME cadence window by construction,
    // whatever the wall clock happens to read.
    const second = await syncIntegrations(
      p,
      lateInSameWindow(attemptInstant(p, "strava"), p, "strava", "oura")
    );
    expect(second.polled).toEqual([]);
    expect(second.skipped.sort()).toEqual(["oura", "strava"]);
    // THE ASSERTION THE ISSUE IS ABOUT: not one extra outbound call.
    expect(calls).toEqual(afterFirst);
    // And not one extra event row, so the 90-day sync-event history does not grow
    // with the tick rate either.
    expect(syncEventCount(p, "strava")).toBe(1);
    expect(syncEventCount(p, "oura")).toBe(1);
  });

  it("polls again once the window turns over", async () => {
    const calls = stubProviders();
    const p = connectedProfile("turnover");

    await syncIntegrations(p, new Date());
    const attempt = attemptInstant(p, "oura");
    // Anywhere else inside the window: still held.
    expect(
      (
        await syncIntegrations(
          p,
          lateInSameWindow(attempt, p, "strava", "oura")
        )
      ).polled
    ).toEqual([]);
    // Past it: polled.
    const next = await syncIntegrations(p, plusMinutes(attempt, 61));
    expect(next.polled.sort()).toEqual(["oura", "strava"]);
    expect(calls.get("oura")).toBeGreaterThan(1);
  });

  it("is per provider, not per tick", async () => {
    const calls = stubProviders();
    const p = connectedProfile("perprovider");
    await syncIntegrations(p, new Date());
    const ouraCalls = calls.get("oura")!;

    // Backdate ONLY Strava's recorded attempt. Oura's window is still closed, so a
    // tick now must poll Strava and leave Oura alone — the guard is keyed on
    // (profile, provider), not on "did this tick already sync something".
    db.prepare(
      `UPDATE integration_sync_events
          SET at = datetime(at, '-3 hours')
        WHERE profile_id = ? AND provider = 'strava'`
    ).run(p);

    const out = await syncIntegrations(p, new Date());
    expect(out.polled).toEqual(["strava"]);
    expect(out.skipped).toEqual(["oura"]);
    expect(calls.get("oura")).toBe(ouraCalls);
  });

  it("polls a provider that has never been polled, and a disconnected one never", async () => {
    const calls = stubProviders();
    const p = connectedProfile("first");
    // Weather is connected but has no home location, so its runner no-ops without a
    // network call — it still counts as a poll opportunity spent, which is the honest
    // accounting: the guard rations the ATTEMPT.
    enableWeather(p);
    const out = await syncIntegrations(p, new Date());
    expect(out.polled).toContain("weather");
    expect(calls.get("weather")).toBeUndefined();

    // Withings is not connected at all, so it is never even considered.
    expect(out.polled).not.toContain("withings");
    expect(out.skipped).not.toContain("withings");
  });

  it("gives a provider with no declared cadence the safe hourly default", async () => {
    // Health Connect declares no `pull` facet at all (it is push), so it declares no
    // cadence either — the case every FUTURE provider starts in. Its recorded events
    // still resolve against the default, and the default is hourly.
    const p = newProfile("Tick default");
    recordSyncEvent(p, "health-connect", { ok: true });
    const attempt = attemptInstant(p, "health-connect");
    expect(
      pullDecision(
        p,
        "health-connect",
        lateInSameWindow(attempt, p, "health-connect")
      )
    ).toEqual({ poll: false, reason: "same-window" });
    expect(
      pullDecision(p, "health-connect", plusMinutes(attempt, 61 + 59))
    ).toEqual({ poll: true, reason: "window-open" });
  });

  it("rations a FAILED poll like a successful one", async () => {
    // A failed run spent an API call, and the case where a remote is rate-limiting or
    // down is exactly the one where retrying on every tick is worst. The failure is
    // recorded as an event, so the window closes on it too.
    const p = connectedProfile("failing");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 }))
    );
    const first = await syncIntegrations(p, new Date());
    expect(first.polled.sort()).toEqual(["oura", "strava"]);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM integration_sync_events WHERE profile_id = ? AND ok = 0"
        )
        .get(p)
    ).toEqual({ n: 2 });

    const second = await syncIntegrations(
      p,
      lateInSameWindow(attemptInstant(p, "strava"), p, "strava", "oura")
    );
    expect(second.polled).toEqual([]);
  });

  // ── #2567: the poll no longer aims at the top of the hour ──────────────────
  it("gives each (profile, source) a stable window offset off the epoch boundary", () => {
    // Weather lost 209 of 289 runs to 503s in the first ~5 seconds of each hour: the
    // cadence buckets are epoch-aligned, so an hourly source fires on the tick at
    // :00:00 with no jitter anywhere. The offset shifts the BOUNDARY, so the first tick
    // inside a fresh window is no longer the top-of-hour one.
    const p = connectedProfile("offset");
    const weather = pullOffsetFor(p, "weather");
    expect(weather).toBeGreaterThan(0);
    expect(weather).toBeLessThan(60);
    // Stable — asked twice, the same answer, because a moving offset is a moving
    // window boundary.
    expect(pullOffsetFor(p, "weather")).toBe(weather);
    // Seeded per (install, profile, source), so an instance's sources are spread
    // rather than moving together. Asserted as a SPREAD over many keys, never as
    // "these two differ": two hashes into 51 slots collide often enough that pinning
    // one pair would be a coin flip in CI. The exact per-seed values are pinned in
    // lib/__tests__/pull-cadence.test.ts, where the seeds are fixed.
    const spread = new Set(
      [p, connectedProfile("offset-b"), connectedProfile("offset-c")].flatMap(
        (id) =>
          (["weather", "strava", "oura", "withings"] as const).map((source) =>
            pullOffsetFor(id, source)
          )
      )
    );
    expect(spread.size).toBeGreaterThan(4);
  });

  it("still polls exactly once per hour with the boundary shifted", () => {
    // THE BOUND THE OFFSET MAY NOT WEAKEN, asserted against the real recorded-attempt
    // path rather than the pure simulation: a tick anywhere inside the shifted window
    // is held, and the first tick past it polls.
    const p = connectedProfile("offset-bound");
    recordSyncEvent(p, "weather", { ok: true });
    const attempt = attemptInstant(p, "weather");
    expect(pullDecision(p, "weather", attempt)).toEqual({
      poll: false,
      reason: "same-window",
    });
    expect(
      pullDecision(p, "weather", lateInSameWindow(attempt, p, "weather"))
    ).toEqual({ poll: false, reason: "same-window" });
    expect(
      pullDecision(
        p,
        "weather",
        new Date(windowEndMs(p, "weather", attempt) + 1_000)
      )
    ).toEqual({ poll: true, reason: "window-open" });
  });
});

// ── B. runCoachingEpisode (#2121 item 1) ─────────────────────────────────────

function restRec(id = "rest-sleep"): Recommendation {
  return {
    id,
    kind: "rest",
    title: "Rest or take it easy today",
    detail: "Synthetic rest signal for the repetition pin.",
    tone: "caution",
  };
}

describe("runCoachingEpisode — two calls in the same hour ≡ one (#2121 item 1)", () => {
  it("re-running on a day the episode OPENED does not restart or bump it", () => {
    const p = newProfile("Rest open");
    const day = today(p);

    const first = reconcileRestEpisode(p, [restRec()], day);
    expect(first).toEqual({
      startDate: day,
      lastDate: day,
      reasonId: "rest-sleep",
    });
    const stored = getRestEpisode(p);

    const second = reconcileRestEpisode(p, [restRec()], day);
    expect(second).toEqual(first);
    expect(getRestEpisode(p)).toEqual(stored);
  });

  it("re-running on a CONTINUING day keeps the start date, so the day count cannot drift", () => {
    // The real repetition hazard: the marker carries "Nth day", and a second tick that
    // reset startDate to today would silently demote a 3rd-day episode to a 1st-day
    // one — a user-visible change, from nothing but the scheduler running faster.
    const p = newProfile("Rest continue");
    const day = today(p);
    const yesterday = shiftDateStr(day, -1);

    reconcileRestEpisode(p, [restRec()], yesterday);
    const advanced = reconcileRestEpisode(p, [restRec()], day);
    expect(advanced).toEqual({
      startDate: yesterday,
      lastDate: day,
      reasonId: "rest-sleep",
    });

    for (let tick = 0; tick < 4; tick++) {
      expect(reconcileRestEpisode(p, [restRec()], day)).toEqual(advanced);
    }
    expect(getRestEpisode(p)).toEqual(advanced);
  });

  it("re-running on a day with no rest signal leaves it cleared, not flapping", () => {
    const p = newProfile("Rest clear");
    const day = today(p);
    reconcileRestEpisode(p, [restRec()], day);

    expect(reconcileRestEpisode(p, [], day)).toBeNull();
    expect(reconcileRestEpisode(p, [], day)).toBeNull();
    expect(getRestEpisode(p)).toBeNull();
  });

  it("the whole gather→rank→reconcile path is stable across repeated ticks", () => {
    // The function the tick actually calls, on a real (empty) profile: whatever it
    // decides, it must decide the same thing the second time within the hour.
    const p = newProfile("Rest whole");
    const first = runCoachingEpisode(p);
    const stored = getRestEpisode(p);
    expect(runCoachingEpisode(p)).toEqual(first);
    expect(getRestEpisode(p)).toEqual(stored);
  });
});

// ── C/D. evaluateSyncRequests (#2121 item 2) + the point of the split ────────

const todayFor = (profileId: number) => today(profileId);

function portalFixture(tag: string): {
  profileId: number;
  account: PortalAccount;
  anchor: string;
} {
  const profileId = newProfile(`Portal ${tag}`);
  const portal = createPortal(`Portal ${tag}`, "mychart");
  if (!portal.ok) throw new Error("fixture portal");
  expect(createPortalAccount(portal.id, `Login${tag}`).ok).toBe(true);
  const account = accountsForPortal(portal.id).find(
    (a) => a.name === `Login${tag}`
  )!;
  expect(bindPortalIdentity(account.id, `PATIENT ${tag}`, profileId).ok).toBe(
    true
  );
  return { profileId, account, anchor: today(profileId) };
}

// One reported run, backdated far enough that the login reads as stale. Moves the
// report's `at` and its check-clock stamps together, the way a real report writes them.
function staleReportedRun(account: PortalAccount, at: string): void {
  recordPortalRunReport(account, {
    ok: true,
    status: "nothing-new",
    message: null,
    discovered: 0,
  });
  db.prepare(
    `UPDATE portal_run_reports
        SET at = ?,
            checked_at = CASE WHEN checked_at IS NULL THEN NULL ELSE ? END,
            checked_ok_at = CASE WHEN checked_ok_at IS NULL THEN NULL ELSE ? END
      WHERE account_id = ?`
  ).run(at, at, at, account.id);
}

beforeEach(() => {
  db.exec("DELETE FROM portal_sync_requests");
});

describe("evaluateSyncRequests — two calls in the same hour ≡ one (#2121 item 2)", () => {
  it("raises once and writes nothing on the repeat", () => {
    const f = portalFixture("rep");
    staleReportedRun(
      f.account,
      `${shiftDateStr(f.anchor, -(STALENESS_CADENCE_DAYS + 5))} 09:00:00`
    );

    const first = evaluateSyncRequests(todayFor);
    expect(first.staleness).toBeGreaterThanOrEqual(1);
    const row = listSyncRequests().find((r) => r.accountId === f.account.id)!;

    // Four more ticks in the same hour. Each one re-reads the same still-stale facts —
    // the condition has NOT gone away, which is exactly why this is the interesting
    // case: the guard has to be the supersession rule, not "the condition cleared".
    for (let tick = 0; tick < 4; tick++) {
      expect(evaluateSyncRequests(todayFor)).toEqual({
        staleness: 0,
        postVisit: 0,
      });
    }
    // Byte-identical row: same reason, same created_at, same expiry. A repeat that
    // bumped created_at would silently extend the request's life every tick.
    expect(
      listSyncRequests().find((r) => r.accountId === f.account.id)
    ).toEqual(row);
  });

  it("does not re-run the supersession decision it was never meant to race", () => {
    // The comment at this call site says the pass is global precisely so the
    // supersession rule is not asked to sort out a race it "should never have seen".
    // Re-running intra-hour is a new input pattern for that rule, so: an open
    // higher-salience request must survive the repeat untouched, and a lower-salience
    // creator must not be able to demote it by being run more often.
    const f = portalFixture("sup");
    staleReportedRun(
      f.account,
      `${shiftDateStr(f.anchor, -(STALENESS_CADENCE_DAYS + 5))} 09:00:00`
    );
    // A visit yesterday makes the higher-salience post-visit creator fire too.
    db.prepare(
      `INSERT INTO appointments (profile_id, title, date, time_of_day, status)
       VALUES (?, 'Synthetic visit', ?, '09:00', 'scheduled')`
    ).run(f.profileId, shiftDateStr(f.anchor, -1));

    evaluateSyncRequests(todayFor);
    const settled = listSyncRequests().find(
      (r) => r.accountId === f.account.id
    )!;
    expect(settled.reason).toBe("post-visit");

    for (let tick = 0; tick < 3; tick++) {
      expect(evaluateSyncRequests(todayFor)).toEqual({
        staleness: 0,
        postVisit: 0,
      });
      expect(
        listSyncRequests().find((r) => r.accountId === f.account.id)
      ).toEqual(settled);
    }
  });
});

describe("the point of the split: dues still evaluate on every tick", () => {
  it("a condition that appears BETWEEN two ticks in one hour is picked up by the second, with no re-poll", async () => {
    const calls = stubProviders();
    const p = connectedProfile("split");
    const f = portalFixture("split");

    // Tick 1: providers polled, nothing due.
    await syncIntegrations(p, new Date());
    const afterFirstPoll = new Map(calls);
    evaluateSyncRequests(todayFor);
    const raisedFor = () =>
      listSyncRequests().some((r) => r.accountId === f.account.id);
    expect(raisedFor()).toBe(false);

    // Between the ticks, the condition becomes true.
    staleReportedRun(
      f.account,
      `${shiftDateStr(f.anchor, -(STALENESS_CADENCE_DAYS + 5))} 09:00:00`
    );

    // Tick 2, inside the same cadence window. THE WHOLE POINT: the due evaluation runs
    // again and finds it, while the pull pass makes no call at all. Before the split
    // these were one cadence, so this ask cost a full round of provider polls; a finer
    // tick would have multiplied them.
    const secondPull = await syncIntegrations(
      p,
      lateInSameWindow(attemptInstant(p, "strava"), p, "strava", "oura")
    );
    expect(secondPull.polled).toEqual([]);
    expect(calls).toEqual(afterFirstPoll);
    evaluateSyncRequests(todayFor);
    expect(raisedFor()).toBe(true);
  });
});
