// Issue #2386 — repeat dismissal read as an answer. The pure half: what counts as a
// raising, which policies the mechanism may reach at all, and how the escalation bands.
//
// The load-bearing test in this file is the policy enumeration: it walks
// LIFECYCLE_SUPPRESSION_POLICIES so a NEW suppression tier cannot ship without a
// deliberate decision about whether repeat dismissal may quiet it.

import { describe, it, expect } from "vitest";
import {
  FINDING_PROMINENCE,
  QUIET_AFTER_DISMISSED_RAISINGS,
  RETIRE_AFTER_DISMISSED_RAISINGS,
  countsAsDismissal,
  dismissalProminence,
  dismissedRaisings,
  dismissedSignalKeys,
  findingEpisodeFamily,
  findingProminence,
  findingSuppressionPolicy,
  mayQuietOnDismissal,
  rankByDismissalFatigue,
  routineOrder,
} from "../dismissal-fatigue";
import {
  LIFECYCLE_SUPPRESSION_POLICIES,
  isHiddenUnderPolicy,
  type LifecycleSuppressionPolicy,
} from "../lifecycle";
import type { SuppressionRecord } from "../upcoming-suppress";
import type { Finding } from "../findings";
import {
  staleExerciseLegacyKey,
  staleExerciseSignalKey,
} from "../training-observations";
import { digestDedupeKey } from "../findings";
import { syncRequestDedupeKey, syncRequestFamily } from "../sync-requests";
import {
  recordsRecencyDedupeKey,
  recordsRecencyFamily,
} from "../records-recency";
import {
  digestTimeEpisodeKey,
  digestTimeFamily,
} from "../digest-time-suggestion";

const DAY = "2026-08-12";

function dismissed(
  at: string | null = "2026-08-01 09:00:00"
): SuppressionRecord {
  return { snooze_until: null, dismissed_at: at };
}

function snoozed(until: string): SuppressionRecord {
  return { snooze_until: until, dismissed_at: null };
}

function mapOf(
  entries: readonly (readonly [string, SuppressionRecord])[]
): Map<string, SuppressionRecord> {
  return new Map(entries);
}

function finding(over: Partial<Finding> & { dedupeKey: string }): Finding {
  return { domain: "training-stale", title: "t", ...over };
}

describe("the safety floor", () => {
  it("only reaches a policy whose dismissals the bus already honours", () => {
    // The floor is DERIVED, not listed: quieting is available exactly where a single
    // plain dismiss would already hide the finding.
    for (const policy of LIFECYCLE_SUPPRESSION_POLICIES) {
      expect(mayQuietOnDismissal(policy)).toBe(
        isHiddenUnderPolicy(
          policy,
          { snooze_until: null, dismissed_at: "2026-01-01 00:00:00" },
          DAY
        )
      );
    }
  });

  it("classifies every declared suppression policy", () => {
    // A new tier added to lib/lifecycle.ts fails here until it is decided about.
    const decided: Record<LifecycleSuppressionPolicy, boolean> = {
      normal: true,
      // An overdue safety follow-up RESISTS an indefinite dismiss, so a dismissal is
      // not an answer about it either.
      "snooze-only": false,
      // Dose reminders, missed-dose escalations and the mental-health crisis finding.
      "safety-ungated": false,
    };
    expect(Object.keys(decided).sort()).toEqual(
      [...LIFECYCLE_SUPPRESSION_POLICIES].sort()
    );
    for (const policy of LIFECYCLE_SUPPRESSION_POLICIES)
      expect(mayQuietOnDismissal(policy)).toBe(decided[policy]);
  });

  it("leaves a safety-ungated finding routine at any decline count", () => {
    for (const n of [0, 1, 2, 4, 40, 400])
      expect(dismissalProminence("safety-ungated", n)).toBe("routine");
  });

  it("leaves a snooze-only care follow-up routine at any decline count", () => {
    for (const n of [0, 1, 2, 4, 40, 400])
      expect(dismissalProminence("snooze-only", n)).toBe("routine");
  });

  it("defaults an undeclared finding to the ordinary tier", () => {
    expect(findingSuppressionPolicy({})).toBe("normal");
    expect(
      findingSuppressionPolicy({ suppressionPolicy: "safety-ungated" })
    ).toBe("safety-ungated");
  });
});

describe("findingEpisodeFamily", () => {
  it("reads the topic stem off a declared episode anchor", () => {
    const stem = staleExerciseLegacyKey("Bench Press");
    expect(
      findingEpisodeFamily({
        dedupeKey: staleExerciseSignalKey("Bench Press", "2026-01"),
        supersedes: stem,
      })
    ).toBe(stem);
  });

  it("has no family without a supersedes stem", () => {
    expect(
      findingEpisodeFamily({
        dedupeKey: digestDedupeKey({ key: "bio:ldl", direction: "up" }),
      })
    ).toBeNull();
  });

  it("has no family when supersedes is a cross-finding key, not a stem", () => {
    // The trajectory finding carries the biomarker FLAG key so a flag dismiss silences
    // it (#564). That is one topic seen twice, not one topic raised twice.
    expect(
      findingEpisodeFamily({
        dedupeKey: "bio-traj:ldl:approaching",
        supersedes: "biomarker-flag:ldl",
      })
    ).toBeNull();
  });

  it("requires a separator, so a stem is never a partial word match", () => {
    expect(
      findingEpisodeFamily({
        dedupeKey: "right-size:12",
        supersedes: "right-size:1",
      })
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The DECLARED family (#2543) — the digest half's missing half.
// ---------------------------------------------------------------------------
//
// #2543 read the symptom right and the cause wrong: it concluded that no digest line
// "has a family to accumulate against". Three do, and always did — the anchors are in
// the keys. What none of them had was a way to SAY so, because `supersedes` means "my
// pre-anchor legacy key" and these three never had one. These tests pin the declaration
// and, more importantly, pin that declaring cannot widen.

describe("findingEpisodeFamily: a declared family (#2543)", () => {
  it("reads a stem stated outright, with no legacy key involved", () => {
    expect(
      findingEpisodeFamily({
        dedupeKey: syncRequestDedupeKey(
          "mychart",
          "main",
          "2026-08-01 07:00:00"
        ),
        episodeFamily: syncRequestFamily("mychart", "main"),
      })
    ).toBe("portal-sync:mychart/main");
  });

  it("refuses a declaration that is not a prefix of the key it rides on", () => {
    // The whole safety property of the explicit field: a producer can only name a stem
    // its own key grew out of. Naming a broader namespace to accumulate faster — the
    // over-broad-stem failure mode #2538's metrics analysis names — is rejected here
    // rather than caught in review.
    expect(
      findingEpisodeFamily({
        dedupeKey: "records-recency:fitbit-archive:2026-01-04",
        episodeFamily: "portal-sync:mychart/main",
      })
    ).toBeNull();
  });

  it("refuses a declaration that omits the separator", () => {
    expect(
      findingEpisodeFamily({
        dedupeKey: "digest-time:4200:480",
        episodeFamily: "digest-time:420",
      })
    ).toBeNull();
  });

  it("prefers the declaration when a finding somehow carries both", () => {
    expect(
      findingEpisodeFamily({
        dedupeKey: "a:b:c",
        episodeFamily: "a:b",
        supersedes: "a",
      })
    ).toBe("a:b");
  });
});

describe("the three digest families mint their stem from their own key (#2543)", () => {
  it("portal-sync: the key is the family plus the request's day", () => {
    const family = syncRequestFamily("mychart", "second-login");
    const key = syncRequestDedupeKey(
      "mychart",
      "second-login",
      "2026-08-01 07:00:00"
    );
    expect(key).toBe(`${family}:2026-08-01`);
    expect(
      findingEpisodeFamily({ dedupeKey: key, episodeFamily: family })
    ).toBe(family);
  });

  it("portal-sync: two logins on one portal are two families, never one", () => {
    expect(syncRequestFamily("mychart", "main")).not.toBe(
      syncRequestFamily("mychart", "other")
    );
  });

  it("records-recency: the key is the family plus the frontier", () => {
    const family = recordsRecencyFamily("clinical-records");
    const key = recordsRecencyDedupeKey("clinical-records", "2026-02-14");
    expect(key).toBe(`${family}:2026-02-14`);
    expect(
      findingEpisodeFamily({ dedupeKey: key, episodeFamily: family })
    ).toBe(family);
  });

  it("records-recency: an archive source and the manual leg never share a family", () => {
    expect(recordsRecencyFamily("fitbit-archive")).not.toBe(
      recordsRecencyFamily("clinical-records")
    );
    expect(
      dismissedRaisings(recordsRecencyFamily("clinical-records"), [
        recordsRecencyDedupeKey("fitbit-archive", "2026-01-04"),
        recordsRecencyDedupeKey("fitbit-archive", "2026-04-04"),
      ])
    ).toBe(0);
  });

  it("digest-time: the key is the family plus the proposal", () => {
    const family = digestTimeFamily(420);
    expect(digestTimeEpisodeKey(420, 480)).toBe(`${family}:480`);
    // The configured minute is the topic; changing it re-arms into a NEW family whose
    // count starts at zero — the ratchet's own rule, now also the counting rule.
    expect(
      dismissedRaisings(digestTimeFamily(480), [
        digestTimeEpisodeKey(420, 480),
        digestTimeEpisodeKey(420, 520),
      ])
    ).toBe(0);
  });

  it("digest-time: two declined proposals under one configured time reach quiet", () => {
    const keys = [
      digestTimeEpisodeKey(420, 480),
      digestTimeEpisodeKey(420, 520),
    ];
    expect(
      findingProminence(
        {
          dedupeKey: digestTimeEpisodeKey(420, 560),
          episodeFamily: digestTimeFamily(420),
        },
        keys
      )
    ).toBe("quiet");
  });
});

describe("countsAsDismissal", () => {
  it("counts a dismissal", () => {
    expect(countsAsDismissal(dismissed())).toBe(true);
  });

  it("counts a dismissal whose timestamp is unknown", () => {
    // #2386's data note: a null dismissed_at is a dismissal of unknown date, not a row
    // to discard and not a date to invent. Nothing here reads the timestamp.
    expect(countsAsDismissal({ snooze_until: null, dismissed_at: null })).toBe(
      true
    );
  });

  it("does not count a snooze", () => {
    expect(countsAsDismissal(snoozed("2026-09-01"))).toBe(false);
    // An EXPIRED snooze is still a "later", never an answer.
    expect(countsAsDismissal(snoozed("2020-01-01"))).toBe(false);
  });
});

describe("dismissedRaisings", () => {
  const stem = staleExerciseLegacyKey("Bench Press");

  it("counts the stem and each anchored episode once", () => {
    const keys = dismissedSignalKeys(
      mapOf([
        [stem, dismissed()],
        [staleExerciseSignalKey("Bench Press", "2026-01"), dismissed()],
        [staleExerciseSignalKey("Bench Press", "2026-05"), dismissed()],
      ])
    );
    expect(dismissedRaisings(stem, keys)).toBe(3);
  });

  it("does not count another topic's episodes", () => {
    const keys = dismissedSignalKeys(
      mapOf([
        [staleExerciseSignalKey("Bench Press", "2026-01"), dismissed()],
        [staleExerciseSignalKey("Deadlift", "2026-01"), dismissed()],
        [staleExerciseSignalKey("Deadlift", "2026-05"), dismissed()],
      ])
    );
    expect(dismissedRaisings(stem, keys)).toBe(1);
  });

  it("does not count snoozes", () => {
    const keys = dismissedSignalKeys(
      mapOf([
        [staleExerciseSignalKey("Bench Press", "2026-01"), dismissed()],
        [
          staleExerciseSignalKey("Bench Press", "2026-05"),
          snoozed("2026-09-01"),
        ],
      ])
    );
    expect(dismissedRaisings(stem, keys)).toBe(1);
  });

  it("is zero for a finding with no family", () => {
    expect(dismissedRaisings(null, ["anything", "at", "all"])).toBe(0);
  });
});

describe("the escalation", () => {
  it("bands routine → quiet → on-demand at the declared thresholds", () => {
    expect(dismissalProminence("normal", 0)).toBe("routine");
    expect(
      dismissalProminence("normal", QUIET_AFTER_DISMISSED_RAISINGS - 1)
    ).toBe("routine");
    expect(dismissalProminence("normal", QUIET_AFTER_DISMISSED_RAISINGS)).toBe(
      "quiet"
    );
    expect(
      dismissalProminence("normal", RETIRE_AFTER_DISMISSED_RAISINGS - 1)
    ).toBe("quiet");
    expect(dismissalProminence("normal", RETIRE_AFTER_DISMISSED_RAISINGS)).toBe(
      "on-demand"
    );
    expect(dismissalProminence("normal", 99)).toBe("on-demand");
  });

  it("escalates rather than muting: retirement is the last band, not silence", () => {
    expect(FINDING_PROMINENCE).toEqual(["routine", "quiet", "on-demand"]);
    expect(RETIRE_AFTER_DISMISSED_RAISINGS).toBeGreaterThan(
      QUIET_AFTER_DISMISSED_RAISINGS
    );
  });
});

describe("rankByDismissalFatigue", () => {
  const stem = staleExerciseLegacyKey("Bench Press");
  const current = finding({
    dedupeKey: staleExerciseSignalKey("Bench Press", "2026-08"),
    supersedes: stem,
  });
  const fresh = finding({
    dedupeKey: staleExerciseSignalKey("Deadlift", "2026-08"),
    supersedes: staleExerciseLegacyKey("Deadlift"),
  });

  function declines(n: number): Map<string, SuppressionRecord> {
    const months = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05"];
    return mapOf(
      months
        .slice(0, n)
        .map(
          (m) =>
            [staleExerciseSignalKey("Bench Press", m), dismissed()] as const
        )
    );
  }

  it("keeps a once-declined topic leading", () => {
    const ranked = rankByDismissalFatigue([current, fresh], declines(1));
    expect(ranked.routine.map((f) => f.dedupeKey)).toEqual([
      current.dedupeKey,
      fresh.dedupeKey,
    ]);
    expect(ranked.quiet).toEqual([]);
    expect(ranked.onDemand).toEqual([]);
  });

  it("stops a twice-declined topic from leading", () => {
    const ranked = rankByDismissalFatigue([current, fresh], declines(2));
    expect(ranked.routine.map((f) => f.dedupeKey)).toEqual([fresh.dedupeKey]);
    expect(ranked.quiet.map((f) => f.dedupeKey)).toEqual([current.dedupeKey]);
    // Still rendered, just behind everything unfatigued.
    expect(
      routineOrder([current, fresh], declines(2)).map((f) => f.dedupeKey)
    ).toEqual([fresh.dedupeKey, current.dedupeKey]);
  });

  it("retires a sustained pattern from the routine surface", () => {
    const ranked = rankByDismissalFatigue([current, fresh], declines(4));
    expect(ranked.onDemand.map((f) => f.dedupeKey)).toEqual([
      current.dedupeKey,
    ]);
    expect(
      routineOrder([current, fresh], declines(4)).map((f) => f.dedupeKey)
    ).toEqual([fresh.dedupeKey]);
  });

  it("never quiets a safety-tier finding, however many declines it carries", () => {
    const crisis = finding({
      dedupeKey: `${stem}:2026-08`,
      supersedes: stem,
      suppressionPolicy: "safety-ungated",
    });
    const ranked = rankByDismissalFatigue([crisis], declines(5));
    expect(ranked.routine.map((f) => f.dedupeKey)).toEqual([crisis.dedupeKey]);
    expect(ranked.quiet).toEqual([]);
    expect(ranked.onDemand).toEqual([]);
  });

  it("resets when the evidence moves the finding to a different family", () => {
    // #203/#482's re-keying discipline: a moved reading is a different signal. The
    // declines above are all Bench Press; the Deadlift topic starts at zero.
    expect(findingProminence(fresh, dismissedSignalKeys(declines(5)))).toBe(
      "routine"
    );
  });

  it("preserves the caller's own order within each band", () => {
    const a = finding({
      dedupeKey: staleExerciseSignalKey("Row", "2026-08"),
      supersedes: staleExerciseLegacyKey("Row"),
    });
    const ranked = rankByDismissalFatigue([fresh, a], declines(4));
    expect(ranked.routine.map((f) => f.dedupeKey)).toEqual([
      fresh.dedupeKey,
      a.dedupeKey,
    ]);
  });
});
