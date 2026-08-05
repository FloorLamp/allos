// PURE TIER — the poll-cadence decision that decouples "how often do we call an
// external API" from "how often does the tick run" (#2121 step 1).
//
// The property under test is a QUOTA BOUND, so it is asserted as one: for a run of
// ticks at a given rate, count the polls the decision function admits and check the
// count against the cadence, not against a hand-picked pair of instants.
//
// Every timestamp here is a synthetic UTC instant. No PHI, no credentials.

import { describe, it, expect } from "vitest";
import {
  DEFAULT_PULL_CADENCE_MINUTES,
  parseSyncEventAt,
  pullCadenceMinutes,
  pullWindow,
  shouldPollNow,
} from "@/lib/integrations/pull-cadence";
import { INTEGRATIONS, PULL_INTEGRATIONS } from "@/lib/integrations/registry";
import type { IntegrationDef } from "@/lib/types";

// A registry-shaped def with only the fields the cadence reader looks at.
function def(cadenceMinutes?: number): IntegrationDef {
  return {
    id: "strava",
    name: "Test provider",
    kind: "oauth",
    status: "available",
    blurb: "",
    dataTypes: [],
    pull:
      cadenceMinutes === undefined
        ? { revalidates: [] }
        : { cadenceMinutes, revalidates: [] },
  };
}

// SQLite's datetime('now') shape — the form every sync event is actually stamped in.
function sqlStamp(iso: string): string {
  return iso.replace("T", " ").replace("Z", "");
}

describe("pullCadenceMinutes", () => {
  it("reads the provider's declared cadence", () => {
    expect(pullCadenceMinutes(def(15))).toBe(15);
    expect(pullCadenceMinutes(def(240))).toBe(240);
  });

  it("falls back to the safe hourly default when none is declared", () => {
    expect(pullCadenceMinutes(def())).toBe(DEFAULT_PULL_CADENCE_MINUTES);
    expect(DEFAULT_PULL_CADENCE_MINUTES).toBe(60);
  });

  it("defaults for an unknown provider rather than throwing", () => {
    // The registry can carry a connection row for a retired or hand-inserted id; the
    // guard must still state a cadence for it, and the safe one is hourly.
    expect(pullCadenceMinutes(undefined)).toBe(DEFAULT_PULL_CADENCE_MINUTES);
  });

  it("ignores a nonsensical declaration instead of obeying it", () => {
    // 0 would mean "poll on every tick" — the exact failure the guard exists to
    // prevent — so a registry typo must not be able to express it.
    expect(pullCadenceMinutes(def(0))).toBe(DEFAULT_PULL_CADENCE_MINUTES);
    expect(pullCadenceMinutes(def(-30))).toBe(DEFAULT_PULL_CADENCE_MINUTES);
    expect(pullCadenceMinutes(def(1.5))).toBe(DEFAULT_PULL_CADENCE_MINUTES);
  });

  it("gives every shipped pull provider a cadence of at least a minute", () => {
    for (const p of PULL_INTEGRATIONS) {
      expect(pullCadenceMinutes(p)).toBeGreaterThanOrEqual(1);
    }
  });

  it("declares hourly polling for all four pull providers today", () => {
    // The quota table in #2121 was measured at hourly grain; step 1 changes WHERE the
    // hour is decided, not what it is. A provider moving off 60 is a quota decision
    // and should have to edit this expectation to make it.
    expect(
      Object.fromEntries(
        PULL_INTEGRATIONS.map((p) => [p.id, pullCadenceMinutes(p)])
      )
    ).toEqual({ strava: 60, oura: 60, withings: 60, weather: 60 });
  });

  it("declares no cadence on providers that are not polled", () => {
    // A push/archive/feed/attended entry has no poll to ration; declaring one would
    // be the same fiction the registry refuses for weather's paging block.
    for (const i of INTEGRATIONS.filter((d) => d.pull == null)) {
      expect(i.pull?.cadenceMinutes).toBeUndefined();
    }
  });
});

describe("parseSyncEventAt", () => {
  it("reads SQLite's zone-less datetime('now') form as UTC", () => {
    // THE BUG THIS EXISTS TO PREVENT: `new Date("2026-08-05 09:00:00")` parses in
    // LOCAL time, so on a TZ=America/Chicago container every stamp would read five
    // hours late and hold every poll back by that much.
    expect(parseSyncEventAt("2026-08-05 09:00:00")).toBe(
      Date.UTC(2026, 7, 5, 9, 0, 0)
    );
  });

  it("reads an ISO instant too", () => {
    expect(parseSyncEventAt("2026-08-05T09:00:00Z")).toBe(
      Date.UTC(2026, 7, 5, 9, 0, 0)
    );
  });

  it("returns null for absent or unparseable stamps", () => {
    expect(parseSyncEventAt(null)).toBeNull();
    expect(parseSyncEventAt("")).toBeNull();
    expect(parseSyncEventAt("not a date")).toBeNull();
  });
});

describe("pullWindow", () => {
  it("puts every instant of an hour in the same hourly window", () => {
    const w = pullWindow(Date.UTC(2026, 7, 5, 9, 0, 0), 60);
    expect(pullWindow(Date.UTC(2026, 7, 5, 9, 59, 59), 60)).toBe(w);
    expect(pullWindow(Date.UTC(2026, 7, 5, 10, 0, 0), 60)).toBe(w + 1);
  });

  it("splits an hour into four at a 15-minute cadence", () => {
    const at = (m: number) => pullWindow(Date.UTC(2026, 7, 5, 9, m, 0), 15);
    expect(new Set([at(0), at(14), at(15), at(30), at(45)]).size).toBe(4);
  });
});

describe("shouldPollNow", () => {
  const NOW = new Date(Date.UTC(2026, 7, 5, 9, 30, 0));

  it("polls when the provider has never been polled", () => {
    expect(
      shouldPollNow({ lastAttemptAt: null, now: NOW, cadenceMinutes: 60 })
    ).toEqual({ poll: true, reason: "never-polled" });
  });

  it("skips a second poll inside the same cadence window", () => {
    expect(
      shouldPollNow({
        lastAttemptAt: sqlStamp("2026-08-05T09:00:05Z"),
        now: NOW,
        cadenceMinutes: 60,
      })
    ).toEqual({ poll: false, reason: "same-window" });
  });

  it("polls once the window turns over", () => {
    expect(
      shouldPollNow({
        lastAttemptAt: sqlStamp("2026-08-05T08:59:59Z"),
        now: NOW,
        cadenceMinutes: 60,
      })
    ).toEqual({ poll: true, reason: "window-open" });
  });

  it("honours a finer declared cadence", () => {
    // Same pair of instants, different declared cadence: 30 minutes apart is one
    // window at hourly and two at 15-minute.
    const args = { lastAttemptAt: sqlStamp("2026-08-05T09:00:00Z"), now: NOW };
    expect(shouldPollNow({ ...args, cadenceMinutes: 60 }).poll).toBe(false);
    expect(shouldPollNow({ ...args, cadenceMinutes: 15 }).poll).toBe(true);
  });

  it("polls rather than wedging on an unreadable stamp", () => {
    expect(
      shouldPollNow({
        lastAttemptAt: "garbled",
        now: NOW,
        cadenceMinutes: 60,
      })
    ).toEqual({ poll: true, reason: "unreadable" });
  });

  it("self-heals from a clock that stepped backwards", () => {
    // A stamp from the FUTURE must not hold the provider back until real time
    // catches up — it is a different window, so it polls.
    expect(
      shouldPollNow({
        lastAttemptAt: sqlStamp("2026-08-05T14:00:00Z"),
        now: NOW,
        cadenceMinutes: 60,
      })
    ).toEqual({ poll: true, reason: "window-open" });
  });
});

// ── THE QUOTA BOUND, simulated ───────────────────────────────────────────────
//
// The claim step 1 makes is "a finer tick must not multiply provider API calls". That
// is a statement about a RUN of ticks, so simulate one: fire ticks at a rate, feed
// each admitted poll back as the new last-attempt (which is what recording a sync
// event does), and count.
function pollsInADay(tickMinutes: number, cadenceMinutes: number): number {
  const start = Date.UTC(2026, 7, 5, 0, 0, 0);
  let lastAttemptAt: string | null = null;
  let polls = 0;
  for (let m = 0; m < 24 * 60; m += tickMinutes) {
    const now = new Date(start + m * 60_000);
    if (shouldPollNow({ lastAttemptAt, now, cadenceMinutes }).poll) {
      polls++;
      // The event is stamped when the run records it — the same instant, for this
      // simulation's purposes.
      lastAttemptAt = new Date(now).toISOString();
    }
  }
  return polls;
}

describe("the tick rate no longer decides the poll rate", () => {
  it("polls hourly whether the tick is hourly, 15-minute, or 1-minute", () => {
    expect(pollsInADay(60, 60)).toBe(24);
    expect(pollsInADay(15, 60)).toBe(24);
    expect(pollsInADay(1, 60)).toBe(24);
  });

  it("is what the tick floor rests on: 1-minute ticks, 24 calls not 1440", () => {
    // The measured constraint in #2121 — 1,440 Strava calls/day at a 1-minute tick,
    // at or over typical app quotas — is exactly this number before the guard.
    expect(24 * 60).toBe(1440);
    expect(pollsInADay(1, 60)).toBe(24);
  });

  it("gives a provider that declares a finer cadence exactly that", () => {
    expect(pollsInADay(1, 15)).toBe(96);
    expect(pollsInADay(15, 15)).toBe(96);
    // A cadence FINER than the tick cannot invent ticks: the tick rate is still a
    // ceiling, which is why the scheduler shape and the dial are separate decisions.
    expect(pollsInADay(60, 15)).toBe(24);
  });

  it("gives a provider that declares a coarser cadence exactly that", () => {
    expect(pollsInADay(15, 240)).toBe(6);
  });

  it("holds for a cadence that does not divide the hour", () => {
    // The grid is epoch-aligned rather than hour-aligned, so a 45-minute cadence
    // still bounds the rate at one poll per window — it just is not on the hour.
    expect(pollsInADay(1, 45)).toBe(32);
    expect(Math.floor((24 * 60) / 45)).toBe(32);
  });
});
