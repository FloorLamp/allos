// DB INTEGRATION TIER — issue #3129: the relevance floor must not orphan the
// coaching-tier-ONLY observation classes.
//
// #3095 replaced the rollup's two-row cap with a relevance floor (`review` = 2):
// a finding without an explicit `dashboardRelevance` clears it only on
// caution/action tone. That is the right default for classes with an origin tab
// of their own — but the classes whose ONLY reach is collectCoachingFindings →
// the dashboard rollup (mood, sleep↔mood bridge, sun exposure, oral health,
// paired observations, TTC workup, food–drug variance) render NOWHERE unless
// they clear the floor. Each of those producers now declares
// `dashboardRelevance: review` — the mechanism #3095 itself established.
//
// This file executes the issue's own probe end-to-end: seed the fixture, build
// the finding, and assert the SHIPPED dashboard filter
// (lib/dashboard-presentation.coachingObservationFindings) KEEPS it. On the
// pre-fix tree the mood finding is produced and the rollup drops it — the
// filter assertions here go red, which is exactly the orphaning #3129 reports.
//
// It also pins, for the touched classes, that the annotation changed ONLY the
// rollup's floor answer: the #449 charter holds (coaching tier, informational
// tone, ordinary dismissible — never a push policy), and the #2386
// repeat-dismissal machinery still reads the finding exactly as before.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { upsertMoodLog } from "@/lib/offline/writes";
import {
  buildMoodFindings,
  collectCoachingFindings,
} from "@/lib/rule-findings";
import {
  coachingObservationFindings,
  coachingObservationRelevance,
  COACHING_OBSERVATIONS_RELEVANCE_THRESHOLD,
} from "@/lib/dashboard-presentation";
import { lowMoodSignalKey, sleepMoodSignalKey } from "@/lib/mood-observation";
import { periodontalObservationKey } from "@/lib/oral-health-observation";
import { tierForDedupeKey } from "@/lib/rule-finding-prefixes";
import { FINDING_DASHBOARD_RELEVANCE, activeFindings } from "@/lib/findings";
import { dismissFinding, getFindingSuppressions } from "@/lib/queries";
import {
  findingSuppressionPolicy,
  mayQuietOnDismissal,
  findingProminence,
} from "@/lib/dismissal-fatigue";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// The issue's executed probe: a mood log on each of the trailing 14 days at
// valence 1 — well past MOOD_LOW_WINDOW_DAYS' minimum for the low verdict.
function seedLowMoodFortnight(profileId: number, anchor: string) {
  for (let ago = 13; ago >= 0; ago--) {
    upsertMoodLog(profileId, shiftDateStr(anchor, -ago), { valence: 1 });
  }
}

// The dashboard rollup exactly as app/(app)/page.tsx composes it: the ONE
// coaching aggregation, bus-filtered, then the shipped relevance-floor filter.
function dashboardRollupKeys(profileId: number, anchor: string): string[] {
  const active = activeFindings(
    collectCoachingFindings(profileId, anchor, "kg"),
    getFindingSuppressions(profileId),
    anchor
  );
  return coachingObservationFindings(active).map((f) => f.dedupeKey);
}

describe("#3129 — the mood observation reaches the dashboard rollup again", () => {
  it("14 days of valence-1 logs produce the finding AND the rollup keeps it", () => {
    const p = newProfile("reach-mood");
    const anchor = today(p);
    seedLowMoodFortnight(p, anchor);

    // The finding is produced (this half was never broken).
    const findings = buildMoodFindings(p, anchor);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.dedupeKey).toBe(lowMoodSignalKey(anchor.slice(0, 7)));
    expect(f.tone).toBe("info");

    // The producer declares its reach explicitly — the class's only surface is
    // the rollup, so it must clear the floor (#3129 via the #3095 mechanism).
    expect(f.dashboardRelevance).toBe(FINDING_DASHBOARD_RELEVANCE.review);
    expect(coachingObservationRelevance(f)).toBeGreaterThanOrEqual(
      COACHING_OBSERVATIONS_RELEVANCE_THRESHOLD
    );

    // …and the SHIPPED dashboard filter keeps it. Red on the pre-fix tree:
    // the finding existed, computed and suppressible, and rendered nowhere.
    expect(dashboardRollupKeys(p, anchor)).toContain(f.dedupeKey);
  });

  it("a dismissal through the shared bus still hides it from the rollup", () => {
    const p = newProfile("reach-mood-dismiss");
    const anchor = today(p);
    seedLowMoodFortnight(p, anchor);
    const key = lowMoodSignalKey(anchor.slice(0, 7));
    expect(dashboardRollupKeys(p, anchor)).toContain(key);

    dismissFinding(p, key);
    expect(dashboardRollupKeys(p, anchor)).not.toContain(key);
  });

  it("the #449 charter and #2386 posture are unchanged by the annotation", () => {
    const p = newProfile("reach-mood-posture");
    const anchor = today(p);
    seedLowMoodFortnight(p, anchor);
    const f = buildMoodFindings(p, anchor)[0];

    // #449: coaching tier — never a notification, never the hero. The tier is
    // read off the registered prefix, and the tone stays informational: the
    // annotation widens rollup reach, it escalates nothing.
    expect(tierForDedupeKey(f.dedupeKey)).toBe("coaching");
    expect(f.tone).toBe("info");

    // #2386: an ordinary dismissible finding — no push-tier suppression policy
    // smuggled in, so repeat dismissal may still quiet and retire the topic
    // exactly as before the annotation.
    expect(findingSuppressionPolicy(f)).toBe("normal");
    expect(mayQuietOnDismissal(findingSuppressionPolicy(f))).toBe(true);
    expect(findingProminence(f, [])).toBe("routine");
  });
});

describe("#3129 — the oral-health observation reaches the dashboard rollup again", () => {
  it("an active diabetes condition produces the note AND the rollup keeps it", () => {
    const p = newProfile("reach-oral");
    const anchor = today(p);
    db.prepare(
      `INSERT INTO conditions (profile_id, name, status)
         VALUES (?, 'Type 2 diabetes mellitus', 'active')`
    ).run(p);

    const rolled = dashboardRollupKeys(p, anchor);
    expect(rolled).toContain(periodontalObservationKey());
  });
});

describe("#3129 — the sleep↔mood bridge clears the floor when it fires", () => {
  it("a duration drop over the low-mood fortnight reaches the rollup", () => {
    const p = newProfile("reach-bridge");
    const anchor = today(p);
    seedLowMoodFortnight(p, anchor);
    // Prior 14 nights ~8h, recent 14 nights ~6.5h → a sustained duration drop
    // (the same fixture shape mood-findings-builders.test.ts uses).
    const seedNight = (date: string, minutes: number) => {
      const ts = `${date}T00:00:00`;
      db.prepare(
        `INSERT INTO metric_samples (profile_id, source, metric, date, started_at, ended_at, value)
           VALUES (?, 'manual', 'sleep_min', ?, ?, ?, ?)`
      ).run(p, date, ts, ts, minutes);
    };
    for (let ago = 27; ago >= 14; ago--)
      seedNight(shiftDateStr(anchor, -ago), 480);
    for (let ago = 13; ago >= 0; ago--)
      seedNight(shiftDateStr(anchor, -ago), 390);

    const rolled = dashboardRollupKeys(p, anchor);
    expect(rolled).toContain(sleepMoodSignalKey(anchor.slice(0, 7)));
  });
});
