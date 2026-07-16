import { describe, it, expect } from "vitest";
import {
  redoseNoticeDecision,
  redoseWindowStatus,
  prnMaxSignalKey,
  PRN_MAX_PREFIX,
} from "@/lib/prn-redose";

// The arming administration was given at a fixed instant; `now` is offset from it.
const GIVEN = new Date("2026-07-15T10:00:00Z");
const hoursAfter = (h: number) => new Date(GIVEN.getTime() + h * 3_600_000);

const base = {
  minIntervalHours: 6,
  maxDailyCount: 4,
  latestAdministrationId: 42,
  latestGivenAt: GIVEN,
  countToday: 1,
  now: hoursAfter(6),
  notifiedAdministrationId: null as number | null,
};

describe("redoseNoticeDecision — one-shot window", () => {
  it("FIRES exactly when the minimum interval has elapsed and under the max", () => {
    const d = redoseNoticeDecision(base);
    expect(d.kind).toBe("fire");
    if (d.kind === "fire") {
      expect(d.administrationId).toBe(42);
      expect(d.countToday).toBe(1);
      expect(d.maxDailyCount).toBe(4);
    }
  });

  it("NOT-YET before the interval elapses", () => {
    const d = redoseNoticeDecision({ ...base, now: hoursAfter(5.5) });
    expect(d.kind).toBe("not-yet");
    if (d.kind === "not-yet") expect(d.opensInHours).toBeCloseTo(0.5, 5);
  });

  it("NOT-ARMED when nothing has been logged", () => {
    expect(
      redoseNoticeDecision({
        ...base,
        latestAdministrationId: null,
        latestGivenAt: null,
      }).kind
    ).toBe("not-armed");
  });

  it("ONE-SHOT: already-notified when the marker matches the latest administration", () => {
    expect(
      redoseNoticeDecision({ ...base, notifiedAdministrationId: 42 }).kind
    ).toBe("already-notified");
  });

  it("RE-ARMS on a NEWER administration (marker holds the OLD id)", () => {
    // Marker still points at the old administration (41); a new one (42) is latest →
    // eligible again.
    const d = redoseNoticeDecision({ ...base, notifiedAdministrationId: 41 });
    expect(d.kind).toBe("fire");
  });

  it("SUPPRESSED at the confirmed daily max (window open but count reached)", () => {
    expect(redoseNoticeDecision({ ...base, countToday: 4 }).kind).toBe(
      "suppressed-max"
    );
    expect(redoseNoticeDecision({ ...base, countToday: 5 }).kind).toBe(
      "suppressed-max"
    );
  });

  it("does NOT consider quiet hours — a 3am elapse still fires (no waking input)", () => {
    // The decision has no hour/waking-window field at all: proof the notice is
    // overnight-capable by construction.
    const overnight = new Date("2026-07-16T03:00:00Z"); // 17h after a 10am dose
    const d = redoseNoticeDecision({
      ...base,
      latestGivenAt: new Date("2026-07-15T10:00:00Z"),
      now: overnight,
    });
    expect(d.kind).toBe("fire");
  });
});

describe("redoseWindowStatus — marker-agnostic surfacing", () => {
  it("null when nothing logged", () => {
    expect(
      redoseWindowStatus({
        minIntervalHours: 6,
        maxDailyCount: 4,
        latestGivenAt: null,
        countToday: 0,
        now: GIVEN,
      })
    ).toBeNull();
  });

  it("open + not-at-max before/after the interval", () => {
    const closed = redoseWindowStatus({
      minIntervalHours: 6,
      maxDailyCount: 4,
      latestGivenAt: GIVEN,
      countToday: 2,
      now: hoursAfter(3),
    })!;
    expect(closed.open).toBe(false);
    expect(closed.opensInHours).toBeCloseTo(3, 5);
    expect(closed.atMax).toBe(false);

    const open = redoseWindowStatus({
      minIntervalHours: 6,
      maxDailyCount: 4,
      latestGivenAt: GIVEN,
      countToday: 4,
      now: hoursAfter(7),
    })!;
    expect(open.open).toBe(true);
    expect(open.atMax).toBe(true);
  });
});

describe("prnMaxSignalKey", () => {
  it("keys on the item id under the registered prefix", () => {
    expect(prnMaxSignalKey(7)).toBe(`${PRN_MAX_PREFIX}7`);
  });
});
