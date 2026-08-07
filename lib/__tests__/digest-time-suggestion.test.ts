// PURE TIER — the digest time suggestion's decision (#2217).
//
// Two statistics, deliberately: the MEDIAN fires it ("loses more often than not" is
// exactly a median) and the P90 is what it proposes (the point of moving is to stop
// losing, not to lose slightly less often). These tests hold them apart — a
// median-triggered/median-proposed implementation and a p90/p90 one both pass a
// single-statistic test suite, and both are the defect.

import { describe, expect, it } from "vitest";
import {
  activeDigestTimeSuggestion,
  digestTimeActions,
  digestTimeEpisodeKey,
  digestTimeSuggestion,
  digestTimeSuggestionCopy,
  digestTimeSuggestionFinding,
  digestTimeSuggestionLine,
  digestTimeSuggestionSuppressed,
  parseDigestTimeEpisodeKey,
  proposalGridMinutes,
  snapProposalMinute,
  DIGEST_TIME_MATERIAL_MOVE_MIN,
  DIGEST_TIME_PREFIX,
  type DigestTimeSuggestionInput,
} from "@/lib/digest-time-suggestion";
import {
  arrivalStatistics,
  MIN_ARRIVAL_SAMPLE,
  type ArrivalNight,
  type ArrivalStatistics,
} from "@/lib/notifications/digest-schedule";
import { tierForDedupeKey } from "@/lib/rule-finding-prefixes";
import { buildDigest, renderDigestMessage } from "@/lib/notifications/digest";
import type { SuppressionRecord } from "@/lib/upcoming-suppress";

const TODAY = "2026-08-06";

// #2217's measured 13 nights, as arrival clock times. Median 07:04, p90 07:39.6 → 460.
const MEASURED = [
  6 * 60 + 2,
  6 * 60 + 6,
  6 * 60 + 14,
  6 * 60 + 26,
  6 * 60 + 47,
  6 * 60 + 50,
  7 * 60 + 4,
  7 * 60 + 11,
  7 * 60 + 26,
  7 * 60 + 26,
  7 * 60 + 30,
  7 * 60 + 42,
  7 * 60 + 48,
];

function nights(arrivals: readonly number[]): ArrivalNight[] {
  return arrivals.map((arrivalMinute, i) => ({
    date: `2026-07-${String(24 + i).padStart(2, "0")}`,
    arrivalMinute,
    lagMin: 60,
    dstTransition: false,
  }));
}

function input(
  over: Partial<DigestTimeSuggestionInput> = {}
): DigestTimeSuggestionInput {
  return {
    mode: "static",
    configuredMinute: 7 * 60,
    stats: arrivalStatistics(nights(MEASURED)),
    // A 5-minute tick — #2216's new default, and the grid 07:40 already sits on.
    tickMinutes: 5,
    ...over,
  };
}

const dismissed: SuppressionRecord = {
  snooze_until: null,
  dismissed_at: "2026-08-01T09:00:00Z",
};

describe("the measured case (#2217's opening fixture)", () => {
  it("fires on the 13 nights and proposes the p90, not the median", () => {
    const s = digestTimeSuggestion(input());
    expect(s).not.toBeNull();
    // The two statistics stay apart: the median is what fired it, the p90 is what it
    // proposes, and they are 36 minutes apart on this sample.
    expect(s!.medianMinute).toBe(7 * 60 + 4);
    expect(s!.p90Minute).toBe(7 * 60 + 40);
    expect(s!.proposedMinute).toBe(7 * 60 + 40);
    expect(s!.nights).toBe(13);
  });

  it("proposes 07:45 on a 15-minute tick — the grid the tick can hit", () => {
    const s = digestTimeSuggestion(input({ tickMinutes: 15 }));
    // Still the same p90; only the OFFERED minute changes.
    expect(s!.p90Minute).toBe(7 * 60 + 40);
    expect(s!.proposedMinute).toBe(7 * 60 + 45);
  });

  it("states the measured facts and nothing about the person", () => {
    const copy = digestTimeSuggestionCopy(digestTimeSuggestion(input())!);
    expect(copy.headline).toBe("Last night’s sleep usually lands by 07:40.");
    expect(copy.detail).toBe(
      "Your digest sends at 07:00, so it often goes out before the data arrives."
    );
    expect(copy.evidence).toBe("Measured over 13 mornings.");
    expect(copy.useLabel).toBe("Use 07:40");
    // No "you", no streak, no adjective about the reader (#992/#716).
    expect(`${copy.headline} ${copy.detail}`).not.toMatch(
      /should|always|never miss|streak|better|worse/i
    );
  });

  it("renders one digest line, below-the-fold in the message", () => {
    expect(digestTimeSuggestionLine(digestTimeSuggestion(input())!)).toBe(
      "🕘 Last night’s sleep usually lands by 07:40. Your digest sends at 07:00, so it often goes out before the data arrives."
    );
  });
});

describe("the trigger — the MEDIAN, and nothing else", () => {
  it("is silent when the median is EARLIER than the configured time", () => {
    // 06:30 configured: the median (07:04) is later, so it fires…
    expect(
      digestTimeSuggestion(input({ configuredMinute: 6 * 60 + 30 }))
    ).not.toBeNull();
    // …but at 07:10 the median has been cleared and it goes quiet, even though the
    // p90 (07:40) is still half an hour later. A time that wins most mornings is not
    // worth asking about.
    expect(
      digestTimeSuggestion(input({ configuredMinute: 7 * 60 + 10 }))
    ).toBeNull();
  });

  it("is silent when the median lands exactly ON the configured time", () => {
    expect(
      digestTimeSuggestion(input({ configuredMinute: 7 * 60 + 4 }))
    ).toBeNull();
  });

  it("is silent once the configured time clears the p90", () => {
    expect(
      digestTimeSuggestion(input({ configuredMinute: 7 * 60 + 40 }))
    ).toBeNull();
    expect(
      digestTimeSuggestion(input({ configuredMinute: 8 * 60 }))
    ).toBeNull();
  });
});

describe("the four ways there is nothing to say", () => {
  it("is silent below MIN_ARRIVAL_SAMPLE — the distribution cannot carry the claim", () => {
    const thin = arrivalStatistics(
      nights(MEASURED.slice(0, MIN_ARRIVAL_SAMPLE - 1))
    );
    expect(thin.available).toBe(false);
    expect(digestTimeSuggestion(input({ stats: thin }))).toBeNull();
  });

  it("is silent for each unavailable reason, not just the thin one", () => {
    // A shift worker lands as `dispersed`, NOT as a thin sample — the four reasons
    // are four different situations and none of them can carry a percentile.
    const reasons: ArrivalStatistics[] = [
      { available: false, nights: 0, reason: "no-source" },
      { available: false, nights: 0, reason: "no-arrivals" },
      { available: false, nights: 3, reason: "thin-sample" },
      { available: false, nights: 9, reason: "dispersed" },
    ];
    for (const stats of reasons) {
      expect(digestTimeSuggestion(input({ stats }))).toBeNull();
    }
  });

  it("is SILENT IN DYNAMIC MODE — a floor is not a send time", () => {
    // The exact same distribution that fires for Static. The stored minute there is a
    // floor, and a floor that "loses" is doing its job: Dynamic already waits.
    expect(digestTimeSuggestion(input({ mode: "dynamic" }))).toBeNull();
  });

  it("is silent when the digest is off", () => {
    expect(digestTimeSuggestion(input({ configuredMinute: null }))).toBeNull();
  });
});

describe("grid snapping (#2216) — never a minute the tick cannot hit", () => {
  it("offers only divisors of 60, coarsening a non-divisor cadence", () => {
    expect(proposalGridMinutes(5)).toBe(5);
    expect(proposalGridMinutes(15)).toBe(15);
    expect(proposalGridMinutes(1)).toBe(1);
    // 7 and 23 are perfectly valid tick rates and have no stable minute-of-hour grid,
    // so the proposal coarsens to one the scheduler can keep rather than inventing one.
    expect(proposalGridMinutes(7)).toBe(6);
    expect(proposalGridMinutes(23)).toBe(20);
    // Unknown / slower-than-hourly reads as hourly, like everything else in the
    // scheduling layer.
    expect(proposalGridMinutes(0)).toBe(60);
    expect(proposalGridMinutes(600)).toBe(60);
  });

  it("snaps UP, never down — the proposal is never earlier than the p90", () => {
    for (const tick of [1, 2, 5, 15, 30, 60, 7]) {
      for (let m = 0; m < 1440; m += 7) {
        const snapped = snapProposalMinute(m, tick);
        expect(snapped).toBeGreaterThanOrEqual(
          Math.min(m, 1440 - proposalGridMinutes(tick))
        );
        expect(snapped % proposalGridMinutes(tick)).toBe(0);
        expect(snapped).toBeLessThan(1440);
      }
    }
  });

  it("keeps a snap inside the day rather than proposing tomorrow", () => {
    expect(snapProposalMinute(23 * 60 + 59, 60)).toBe(23 * 60);
    expect(snapProposalMinute(23 * 60 + 59, 15)).toBe(23 * 60 + 45);
  });

  it("offers the next grid point up when the p90 sits between two", () => {
    // Hourly ticks, configured 07:00, p90 07:40 → the only offerable minute at or
    // after the p90 is 08:00.
    const s = digestTimeSuggestion(
      input({ tickMinutes: 60, configuredMinute: 7 * 60 })
    );
    expect(s!.proposedMinute).toBe(8 * 60);
  });

  it("says nothing when the grid leaves no minute later than the configured one", () => {
    // The degenerate corner: a configured time already at the day's last hourly grid
    // point. The distribution genuinely says "later", and there is no later minute
    // this instance's tick could hit — so the honest answer is silence, not a
    // proposal of the time the user already has.
    const s = digestTimeSuggestion(
      input({
        tickMinutes: 60,
        configuredMinute: 23 * 60,
        stats: {
          available: true,
          nights: 13,
          medianMinute: 23 * 60 + 10,
          p90Minute: 23 * 60 + 30,
        },
      })
    );
    expect(s).toBeNull();
  });
});

describe("the episode key and its ratchet (constraint 3)", () => {
  it("round-trips the two minutes the copy states", () => {
    const s = digestTimeSuggestion(input())!;
    expect(s.dedupeKey).toBe(digestTimeEpisodeKey(7 * 60, 7 * 60 + 40));
    expect(s.dedupeKey.startsWith(DIGEST_TIME_PREFIX)).toBe(true);
    expect(parseDigestTimeEpisodeKey(s.dedupeKey)).toEqual({
      configuredMinute: 7 * 60,
      proposedMinute: 7 * 60 + 40,
    });
    expect(parseDigestTimeEpisodeKey("coaching:rest-sleep")).toBeNull();
    expect(parseDigestTimeEpisodeKey("digest-time:nope")).toBeNull();
  });

  it("survives the ±11-minute jitter #2214 measures", () => {
    const map = new Map([[digestTimeEpisodeKey(420, 460), dismissed]]);
    for (const drift of [-11, -5, 0, 5, 11, 29]) {
      expect(
        digestTimeSuggestionSuppressed(
          { configuredMinute: 420, proposedMinute: 460 + drift },
          map,
          TODAY
        )
      ).toBe(true);
    }
  });

  it("re-asks only on a MATERIAL move later", () => {
    const map = new Map([[digestTimeEpisodeKey(420, 460), dismissed]]);
    expect(
      digestTimeSuggestionSuppressed(
        {
          configuredMinute: 420,
          proposedMinute: 460 + DIGEST_TIME_MATERIAL_MOVE_MIN,
        },
        map,
        TODAY
      )
    ).toBe(false);
    // Moving EARLIER never re-asks, at any distance: the situation the user declined
    // to act on has only got smaller.
    expect(
      digestTimeSuggestionSuppressed(
        { configuredMinute: 420, proposedMinute: 400 },
        map,
        TODAY
      )
    ).toBe(true);
  });

  it("re-arms when the user changes the configured time — a new question", () => {
    const map = new Map([[digestTimeEpisodeKey(420, 460), dismissed]]);
    expect(
      digestTimeSuggestionSuppressed(
        { configuredMinute: 450, proposedMinute: 460 },
        map,
        TODAY
      )
    ).toBe(false);
  });

  it("ignores an EXPIRED snooze and another domain's dismissal", () => {
    const map = new Map<string, SuppressionRecord>([
      [
        digestTimeEpisodeKey(420, 460),
        { snooze_until: "2026-08-01", dismissed_at: null },
      ],
      ["coaching:rest-sleep", dismissed],
    ]);
    expect(
      digestTimeSuggestionSuppressed(
        { configuredMinute: 420, proposedMinute: 460 },
        map,
        TODAY
      )
    ).toBe(false);
  });

  it("activeDigestTimeSuggestion is the ONE answer both surfaces read", () => {
    const empty = new Map<string, SuppressionRecord>();
    const live = activeDigestTimeSuggestion(input(), empty, TODAY);
    expect(live).not.toBeNull();
    const map = new Map([[live!.dedupeKey, dismissed]]);
    expect(activeDigestTimeSuggestion(input(), map, TODAY)).toBeNull();
  });
});

describe("the in-digest line rides a send — it never causes one", () => {
  // The whole contact-consent argument for the line rests on this: a message that
  // exists only to ask about its own arrival time is not a message.
  const bare = {
    profileName: "Fixture Fiona",
    doseCount: 0,
    todayGroups: [],
    activities: [],
    yesterdayTaken: 0,
    yesterdayDue: 0,
    newFlaggedBiomarkers: [],
    newDocuments: [],
    adherence: null,
    weightKg: null,
  };

  it("returns no digest when the line is the only thing to say", () => {
    const s = digestTimeSuggestion(input())!;
    expect(
      buildDigest({
        ...bare,
        timeSuggestionLine: digestTimeSuggestionLine(s),
        timeActions: digestTimeActions(1, TODAY, s),
      })
    ).toBeNull();
  });

  it("appends the line LAST when the digest already exists", () => {
    const s = digestTimeSuggestion(input())!;
    const model = buildDigest({
      ...bare,
      doseCount: 2,
      timeSuggestionLine: digestTimeSuggestionLine(s),
      timeActions: digestTimeActions(1, TODAY, s),
    })!;
    expect(model.sections.at(-1)!.heading).toBe("Digest timing");
    expect(model.sections.length).toBeGreaterThan(1);
    // And its buttons come after everything else the message offers.
    expect(renderDigestMessage(model).actions?.map((a) => a.label)).toEqual([
      "🕘 Use 07:40",
      "⏳ As soon as it’s ready",
      "🔕 Not now",
    ]);
  });

  it("carries no line and no buttons when the suggestion is not firing", () => {
    const model = buildDigest({ ...bare, doseCount: 2 })!;
    expect(model.sections.map((s) => s.heading)).not.toContain("Digest timing");
    expect(model.timeActions).toEqual([]);
    expect(renderDigestMessage(model).actions).toBeUndefined();
  });
});

describe("reach (constraint 4)", () => {
  it("is registered COACHING — never a safety row, never an escalation", () => {
    const s = digestTimeSuggestion(input())!;
    expect(tierForDedupeKey(s.dedupeKey)).toBe("coaching");
  });

  it("carries no due date, no band and no urgency tone", () => {
    const f = digestTimeSuggestionFinding(digestTimeSuggestion(input())!);
    expect(f.domain).toBe("digest-time");
    expect(f.dueDate).toBeUndefined();
    expect(f.band).toBeUndefined();
    expect(f.tone).toBe("info");
  });

  it("mints three exits whose tokens carry no minute", () => {
    const s = digestTimeSuggestion(input())!;
    const actions = digestTimeActions(4, "2026-08-06", s);
    expect(actions.map((a) => a.label)).toEqual([
      "🕘 Use 07:40",
      "⏳ As soon as it’s ready",
      "🔕 Not now",
    ]);
    // The proposed minute is deliberately absent from every token: the handler
    // re-resolves the live suggestion, so a button cannot write a stale time.
    for (const a of actions) {
      expect(a.data).toMatch(/^dgt[a-z]+:4:2026-08-06$/);
      expect(a.data).not.toContain(String(s.proposedMinute));
    }
  });
});
