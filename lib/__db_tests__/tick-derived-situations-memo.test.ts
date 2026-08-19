// DB INTEGRATION TIER (issue #2724) — `resolveDerivedSituations` is memoized for
// exactly ONE tick scope, and not a syllable longer.
//
// WHY THE MEMO EXISTS. One digest gather reaches the resolver from four unrelated
// callers, and the call is heavy (~1.7 ms against a seeded profile — the
// weather-series scan, not the suppression read, is the cost), so the four collapse
// to one per scope (~5.2 ms per profile per digest gather). The full measurement
// and writer enumeration live beside the resolver
// (lib/queries/derived-situations.ts).
//
// WHY THIS TEST EXISTS. #2674 declined the same-looking memo on the suppression
// bus because a snapshot of it reads as "still silenced" — a safety direction —
// and lib/__db_tests__/tick-suppression-freshness.test.ts pins that refusal. The
// resolver's memo is only sound because its lifetime is ONE tick scope: the guard
// below fails if the memo is widened past the scope (a TTL, a module-level cache),
// if its key stops projecting the profile, and — the deliberate half — it fails if
// the memo is REMOVED, because the snapshot-within-a-scope behavior asserted here
// is the accepted trade the resolver's comment documents.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setActiveSituations, setTimezone } from "@/lib/settings";
import {
  upsertMetricSamples,
  type NormMetricSample,
} from "@/lib/integrations/normalize";
import { resolveDerivedSituations } from "@/lib/queries/derived-situations";
import {
  dismissFinding,
  getFindingSuppressions,
} from "@/lib/queries/upcoming/suppressions";
import {
  BUILTIN_POOR_SLEEP_SITUATION,
  poorSleepOverrideKey,
} from "@/lib/derived-situations";
import { inTickScope, runInTickScope } from "@/lib/tick-cache";

function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setTimezone(id, "UTC");
  return id;
}

// A sleep_min session on `wakeDay` of `minutes` (the derived-situations fixture
// shape): window ends at wake time, stored as UTC instants so wall-clock ==
// instant under the UTC tz set above.
function night(wakeDay: string, minutes: number): NormMetricSample {
  const endH = Math.floor(minutes / 60);
  const endM = minutes % 60;
  const end = `${wakeDay}T${String(endH).padStart(2, "0")}:${String(endM).padStart(2, "0")}:00Z`;
  const start = `${shiftDateStr(wakeDay, -1)}T23:00:00Z`;
  return {
    metric: "sleep_min",
    date: wakeDay,
    started_at: start,
    ended_at: end,
    value: minutes,
  };
}

// A ~8h baseline then a 5h last night — the measured rough-night state whose
// override key is the ONE suppression the resolver consults.
function seedRoughNight(profileId: number): void {
  const anchor = today(profileId);
  const sessions: NormMetricSample[] = [];
  for (let i = 6; i >= 1; i--)
    sessions.push(night(shiftDateStr(anchor, -i), 480));
  sessions.push(night(anchor, 300));
  upsertMetricSamples(profileId, sessions, "health-connect");
}

describe("resolveDerivedSituations under a tick scope (#2724)", () => {
  it("memoizes for the scope — and the scope's close is the memo's end", async () => {
    const profileId = newProfile("Memo Scope");
    seedRoughNight(profileId);
    const td = today(profileId);

    await runInTickScope(
      async () => {
        expect(inTickScope()).toBe(true);
        // First read: the measured rough night is on.
        expect(resolveDerivedSituations(profileId, td).poorSleep).toMatchObject(
          { on: true, basis: "measured" }
        );

        // The cross-process override lands mid-scope (the web "Not today" action).
        dismissFinding(profileId, poorSleepOverrideKey(td));

        // The suppression BUS itself stays fresh — #2674 stands, and this is the
        // line that separates the two issues: the bus read is not memoized.
        expect(
          getFindingSuppressions(profileId).has(poorSleepOverrideKey(td))
        ).toBe(true);

        // The RESOLVER answers from its scope snapshot: still on. This is the
        // documented trade (one profile's tick of staleness, the same exposure
        // as the other tickCached gathers) — and the red-if-removed pin: without
        // the memo this read flips to off.
        expect(resolveDerivedSituations(profileId, td).poorSleep.on).toBe(true);
      },
      { profileId }
    );

    // The scope is closed; the memo may not outlive it. A TTL or module-level
    // cache — the "wrongly applied" shapes — fails here.
    expect(resolveDerivedSituations(profileId, td).poorSleep.on).toBe(false);
  });

  it("is a passthrough outside any scope — every call recomputes", () => {
    const profileId = newProfile("Memo Passthrough");
    const td = today(profileId);
    expect(inTickScope()).toBe(false);

    expect(resolveDerivedSituations(profileId, td).poorSleep.on).toBe(false);
    setActiveSituations(profileId, [BUILTIN_POOR_SLEEP_SITUATION]);
    // No scope, no snapshot: the declared toggle is visible immediately.
    expect(resolveDerivedSituations(profileId, td).poorSleep).toMatchObject({
      on: true,
      basis: "declared",
    });
  });

  it("keys by profile — one profile's snapshot never answers another's", async () => {
    const a = newProfile("Memo Key A");
    const b = newProfile("Memo Key B");
    setActiveSituations(a, [BUILTIN_POOR_SLEEP_SITUATION]);
    const td = today(a);

    await runInTickScope(
      async () => {
        expect(resolveDerivedSituations(a, td).poorSleep.on).toBe(true);
        expect(resolveDerivedSituations(b, td).poorSleep.on).toBe(false);
      },
      { profileId: a }
    );
  });
});
