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
import {
  effectiveSituationResolver,
  getDerivedSituationLines,
  getEffectiveActiveSituations,
  resolveDerivedSituations,
} from "@/lib/queries/derived-situations";
import { getReportedBurden } from "@/lib/queries/reported-burden";
import { resolveSituationId } from "@/lib/settings/profile-attrs";
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

// A ~8h baseline with a 5h night on each of `roughOffsets` (day offsets back from
// today) — the measured rough-night state whose override key is the ONE suppression the
// resolver consults. Defaults to a rough LAST night and healthy nights before it.
//
// The offsets are a parameter because the verdict is DATED (#3993): the resolver reads
// the night ending the day it is asked about, so a test that needs two days to differ on
// the OVERRIDE has to make both of them rough first — otherwise they differ on the sleep
// data and the override is not what is being measured.
function seedRoughNight(profileId: number, roughOffsets: number[] = [0]): void {
  const anchor = today(profileId);
  const sessions: NormMetricSample[] = [];
  for (let i = 6; i >= 0; i--)
    sessions.push(
      night(shiftDateStr(anchor, -i), roughOffsets.includes(i) ? 300 : 480)
    );
  upsertMetricSamples(profileId, sessions, "health-connect");
}

// A situational supplement keyed to `situation`, so `getDerivedSituationLines` has
// something to acknowledge and takes its resolver path rather than the early-out.
function keyItem(profileId: number, name: string, situation: string): number {
  const sid = resolveSituationId(profileId, situation)!;
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, kind, condition, obligation, situation, situation_id, active)
         VALUES (?, ?, 'supplement', 'situational', 'should', ?, ?, 1)`
      )
      .run(profileId, name, situation, sid).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '1 cap', 'evening', 'any', 0)`
  ).run(itemId);
  return itemId;
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

  // BOTH ENTRY POINTS, ONE SNAPSHOT (#3993). The memo used to wrap the single-DATE
  // answer, which the WINDOW resolver does not go through — so inside one scope, with the
  // web's "Not today" landing mid-scope from another process, the reminder rebuild
  // (single-date) and the catch-up sheet (windowed) answered the SAME day two different
  // ways. A bound that only covers one of two callers is a split, and this is the shape
  // #2724's comment claims not to have. Asserted in BOTH orders, because whichever entry
  // point reads first is the one that takes the snapshot.
  it("the two entry points agree about a day, whichever reads first (#3993)", async () => {
    for (const first of ["single-date", "window"] as const) {
      const profileId = newProfile(`Memo Seam ${first}`);
      seedRoughNight(profileId);
      const td = today(profileId);
      const held = (s: Set<string>) => s.has(BUILTIN_POOR_SLEEP_SITUATION);

      await runInTickScope(
        async () => {
          const early =
            first === "single-date"
              ? getEffectiveActiveSituations(profileId, td)
              : effectiveSituationResolver(profileId, { from: td, to: td })(td);
          // The one cross-process write lib/tick-cache.ts warns about, mid-scope.
          dismissFinding(profileId, poorSleepOverrideKey(td));
          const late =
            first === "single-date"
              ? effectiveSituationResolver(profileId, { from: td, to: td })(td)
              : getEffectiveActiveSituations(profileId, td);
          // Snapshot-shaped, which is the documented trade — but ONE snapshot, so the
          // message the tick sends and the sheet it composes cannot disagree.
          expect({ early: held(early), late: held(late) }, first).toEqual({
            early: true,
            late: true,
          });
        },
        { profileId }
      );

      // The scope closed, so the override lands for both.
      expect(held(getEffectiveActiveSituations(profileId, td)), first).toBe(
        false
      );
    }
  });

  it("answers each day from the one snapshot — no day is served another's answer", async () => {
    const profileId = newProfile("Memo Key Date");
    // BOTH days rough, so the sleep data is identical on the two days and the ONLY
    // thing left to tell them apart is the override — which is what this test is about.
    // With a healthy night on yesterday the two would differ anyway, and the assertion
    // below would pass against a memo key that ignored the date entirely.
    seedRoughNight(profileId, [0, 1]);
    const td = today(profileId);
    const yd = shiftDateStr(td, -1);
    // The override is DATE-SCOPED (`poor-sleep-override:<date>`), which is exactly
    // what makes the two days differ on otherwise identical inputs: today is
    // overridden, yesterday's key was never written. Since #3993 the date is an
    // evaluation parameter rather than half a memo key, so this is no longer a guard
    // against a key that forgot to project it — it is the per-day independence of one
    // shared snapshot, which is the property the window resolver rests on too.
    dismissFinding(profileId, poorSleepOverrideKey(td));

    await runInTickScope(
      async () => {
        expect(resolveDerivedSituations(profileId, td).poorSleep.on).toBe(
          false
        );
        expect(resolveDerivedSituations(profileId, yd).poorSleep).toMatchObject(
          {
            on: true,
            basis: "measured",
          }
        );
      },
      { profileId }
    );
  });

  // A DECLARED TOGGLE MID-TICK (#3993) — the torn read, in both directions.
  //
  // The snapshot used to carry the DECLARED set while the dueness seam re-read it fresh,
  // so one tick unioned a fresh declared half with a derived half computed from the STALE
  // one. That is not a conservative snapshot, because the dependence is not monotone:
  // `roughNightVerdict` short-circuits on `declared` and never reaches `derivedNames`, so
  // a stale-TRUE declared SUPPRESSES a measured derivation and the answer is neither the
  // before answer nor the after one.
  //
  // The two reads below are the pair `lib/notifications/digest-data.ts` makes NINE LINES
  // APART in one gather (`:637` the dueness set, `:646` the Context line), so a
  // disagreement between them is a single message contradicting itself.
  //
  // Each case runs the identical sequence twice — once inside a scope, once outside one —
  // and asserts the two agree. The control is what makes this about the memo rather than
  // about resolver lifetime, which behaves the same either side of a scope.
  const observePoorSleep = (profileId: number, td: string) => {
    const lines = getDerivedSituationLines(profileId, td);
    return {
      contextLine: lines.poorSleep != null,
      // Offered only for a MEASURED basis, so this is where declared/measured shows.
      overridable: lines.poorSleepOverridable,
      due: getEffectiveActiveSituations(profileId, td).has(
        BUILTIN_POOR_SLEEP_SITUATION
      ),
    };
  };

  // Read, toggle the chip to `to`, read again — inside a scope or outside one.
  async function toggleMidSequence(
    profileId: number,
    to: string[],
    inScope: boolean
  ) {
    const td = today(profileId);
    const seq = () => {
      const before = observePoorSleep(profileId, td);
      setActiveSituations(profileId, to);
      return { before, after: observePoorSleep(profileId, td) };
    };
    if (!inScope) return seq();
    let out: ReturnType<typeof seq> | null = null;
    await runInTickScope(
      async () => {
        out = seq();
      },
      { profileId }
    );
    return out as unknown as ReturnType<typeof seq>;
  }

  it("a chip toggled OFF mid-tick cannot suppress the measured night behind it (#3993)", async () => {
    const seed = (name: string) => {
      const profileId = newProfile(name);
      seedRoughNight(profileId);
      keyItem(profileId, "Toggle Magnesium", BUILTIN_POOR_SLEEP_SITUATION);
      setActiveSituations(profileId, [BUILTIN_POOR_SLEEP_SITUATION]);
      return profileId;
    };
    const control = await toggleMidSequence(
      seed("Toggle Off Control"),
      [],
      false
    );
    const tick = await toggleMidSequence(seed("Toggle Off Tick"), [], true);

    // Turning the chip off leaves the night itself rough, so the context stays on and
    // becomes overridable — the item goes on being due, on the measured basis.
    expect(control).toEqual({
      before: { contextLine: true, overridable: false, due: true },
      after: { contextLine: true, overridable: true, due: true },
    });
    expect(tick, "in tick scope").toEqual(control);
  });

  it("a chip toggled ON mid-tick reaches the state line, not just the dueness set (#3993)", async () => {
    // No sleep data at all, so nothing is measured and the declaration is the whole
    // verdict — the mirror of the case above.
    const seed = (name: string) => {
      const profileId = newProfile(name);
      keyItem(profileId, "Toggle Magnesium", BUILTIN_POOR_SLEEP_SITUATION);
      return profileId;
    };
    const on = [BUILTIN_POOR_SLEEP_SITUATION];
    const control = await toggleMidSequence(
      seed("Toggle On Control"),
      on,
      false
    );
    const tick = await toggleMidSequence(seed("Toggle On Tick"), on, true);

    expect(control).toEqual({
      before: { contextLine: false, overridable: false, due: false },
      after: { contextLine: true, overridable: false, due: true },
    });
    expect(tick, "in tick scope").toEqual(control);
  });

  it("no consumer mutates the memoized object — the snapshot survives every reader", async () => {
    const profileId = newProfile("Memo Shared Object");
    seedRoughNight(profileId);
    keyItem(profileId, "Memo Magnesium", BUILTIN_POOR_SLEEP_SITUATION);
    const td = today(profileId);

    await runInTickScope(
      async () => {
        const snapshot = resolveDerivedSituations(profileId, td);
        expect(snapshot.derivedNames.has(BUILTIN_POOR_SLEEP_SITUATION)).toBe(
          true
        );
        const before = [...snapshot.derivedNames].sort();

        // Every in-repo consumer of the resolver, run against the SAME scope: the
        // dueness seam, the state lines, and the reported-burden gather. The memo
        // hands each of them one shared object, so a consumer that mutated
        // `derivedNames` (adding to the union in place, say) would poison every
        // later reader in the tick.
        const effective = getEffectiveActiveSituations(profileId, td);
        effective.add("Caller Scribble");
        getDerivedSituationLines(profileId, td);
        getReportedBurden(profileId, td);

        expect(
          [...resolveDerivedSituations(profileId, td).derivedNames].sort()
        ).toEqual(before);
        // …and the union the dueness seam returns is the caller's own Set, so even
        // a caller that writes to it cannot reach the memoized names.
        expect(
          resolveDerivedSituations(profileId, td).derivedNames.has(
            "Caller Scribble"
          )
        ).toBe(false);
      },
      { profileId }
    );
  });
});
