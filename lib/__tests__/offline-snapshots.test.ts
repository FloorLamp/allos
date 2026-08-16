// The offline read snapshot registry (#2908) — the coverage discipline, the staleness
// rules, the profile scoping, and the queued-write overlay.
//
// The COVERAGE half is the #2130 shape: `SNAPSHOT_REGISTRY` is const-asserted against
// `Record<SnapshotKind, SnapshotDecl>`, so a sixth kind fails `tsc` before it reaches
// here. What tsc cannot say is whether an entry still MEANS anything — an empty `why`,
// a `profile-day` kind that also claims a day count, an overlay naming a flow the queue
// does not have. That is what these assert.

import { describe, it, expect } from "vitest";
import {
  MAX_SNAPSHOT_EXERCISES,
  MAX_SNAPSHOT_SESSIONS,
  SNAPSHOT_KINDS,
  SNAPSHOT_REFRESH_INTERVAL_MS,
  SNAPSHOT_REGISTRY,
  SNAPSHOT_VERSION,
  isSnapshotStale,
  overlayDoseSchedule,
  overlayFoodTallies,
  overlayPracticeWeek,
  overlayRecentTraining,
  overlaySnapshot,
  parseSnapshot,
  resolveSnapshotProfile,
  snapshotAgeDays,
  snapshotsToRefresh,
  type AnySnapshot,
  type SnapshotEnvelope,
} from "@/lib/offline/snapshots";
import {
  FLOW_KINDS,
  buildIntent,
  type QueuedIntent,
} from "@/lib/offline/queue";

const PROFILE = 7;
const OTHER = 8;

function envelope<T extends AnySnapshot>(
  over: Partial<T> & Pick<T, "kind" | "data">
) {
  return {
    version: SNAPSHOT_VERSION,
    profileId: PROFILE,
    timeZone: "America/Denver",
    capturedOn: "2026-08-16",
    fetchedAt: "2026-08-16T22:00:00Z",
    ...over,
  } as AnySnapshot;
}

const doseSnapshot = () =>
  envelope({
    kind: "dose-schedule" as const,
    data: {
      date: "2026-08-16",
      entries: [
        {
          doseId: 1,
          name: "Metformin",
          detail: "500 mg",
          slot: "Morning",
          time: "08:00",
          status: "pending" as const,
        },
        {
          doseId: 2,
          name: "Vitamin D",
          detail: null,
          slot: "Morning",
          time: null,
          status: "taken" as const,
        },
      ],
    },
  });

// ── The registry ─────────────────────────────────────────────────────────────

describe("SNAPSHOT_REGISTRY (#2908) — declare or it does not ship", () => {
  it("declares every kind, with no kind declared twice", () => {
    expect(new Set(SNAPSHOT_KINDS).size).toBe(SNAPSHOT_KINDS.length);
    for (const kind of SNAPSHOT_KINDS) {
      expect(SNAPSHOT_REGISTRY[kind]).toBeDefined();
    }
    expect(Object.keys(SNAPSHOT_REGISTRY).sort()).toEqual(
      [...SNAPSHOT_KINDS].sort()
    );
  });

  it("every entry states its scope, its clock, its overlays and its reasoning", () => {
    for (const kind of SNAPSHOT_KINDS) {
      const decl = SNAPSHOT_REGISTRY[kind];
      expect(decl.title.length, kind).toBeGreaterThan(0);
      // The SELECTION RULE, per row: a snapshot earns its place by answering "what
      // have I already done". An entry that cannot say what it answers has not
      // earned one.
      expect(decl.answers.length, kind).toBeGreaterThan(10);
      expect(decl.why.length, kind).toBeGreaterThan(40);
      expect(["profile-day", "rolling-window"]).toContain(decl.scope);
    }
  });

  it("a profile-day kind states no day clock; a rolling-window kind states a positive one", () => {
    for (const kind of SNAPSHOT_KINDS) {
      const decl = SNAPSHOT_REGISTRY[kind];
      if (decl.scope === "profile-day") {
        // Its clock is the profile's midnight. A second number here would be a
        // second answer to one question.
        expect(decl.staleAfterDays, kind).toBe(0);
      } else {
        expect(decl.staleAfterDays, kind).toBeGreaterThan(0);
      }
    }
  });

  it("every declared overlay names a real queue flow", () => {
    for (const kind of SNAPSHOT_KINDS) {
      for (const flow of SNAPSHOT_REGISTRY[kind].overlays) {
        expect(FLOW_KINDS, `${kind} overlays ${flow}`).toContain(flow);
      }
    }
  });

  it("keeps the last-N training bounds finite", () => {
    expect(MAX_SNAPSHOT_EXERCISES).toBeGreaterThan(0);
    expect(MAX_SNAPSHOT_SESSIONS).toBeGreaterThan(0);
  });
});

// ── Parsing ──────────────────────────────────────────────────────────────────

describe("parseSnapshot", () => {
  it("accepts a well-formed envelope", () => {
    expect(parseSnapshot(doseSnapshot())).not.toBeNull();
  });

  it("refuses a wrong version, an unknown kind, and a missing profile stamp", () => {
    expect(parseSnapshot({ ...doseSnapshot(), version: 99 })).toBeNull();
    expect(parseSnapshot({ ...doseSnapshot(), kind: "sleep" })).toBeNull();
    expect(parseSnapshot({ ...doseSnapshot(), profileId: "7" })).toBeNull();
    expect(parseSnapshot({ ...doseSnapshot(), timeZone: "" })).toBeNull();
    expect(parseSnapshot(null)).toBeNull();
    expect(parseSnapshot("{}")).toBeNull();
  });
});

// ── Staleness: an instant is not a profile-local day ─────────────────────────

describe("staleness", () => {
  const env = doseSnapshot() as SnapshotEnvelope;

  it("a day-scoped snapshot is current while the PROFILE's day still stands", () => {
    // 2026-08-17T04:00Z is 22:00 on 2026-08-16 in Denver: the device's UTC day has
    // rolled over, the profile's has not, and the schedule is still today's.
    expect(isSnapshotStale(env, new Date("2026-08-17T04:00:00Z"))).toBe(false);
  });

  it("…and goes stale at that profile's midnight, not the device's", () => {
    // 2026-08-17T07:00Z is 01:00 on 2026-08-17 in Denver.
    expect(isSnapshotStale(env, new Date("2026-08-17T07:00:00Z"))).toBe(true);
  });

  it("a rolling-window snapshot ages against its own declared clock", () => {
    const meds = envelope({
      kind: "medication-list" as const,
      data: { rows: [] },
    }) as SnapshotEnvelope;
    const clock = SNAPSHOT_REGISTRY["medication-list"].staleAfterDays;
    // The shared freshness boundary: stale STRICTLY AFTER the interval.
    const atClock = new Date(`2026-08-${16 + clock}T18:00:00Z`);
    const pastClock = new Date(`2026-08-${17 + clock}T18:00:00Z`);
    expect(snapshotAgeDays(meds, atClock)).toBe(clock);
    expect(isSnapshotStale(meds, atClock)).toBe(false);
    expect(isSnapshotStale(meds, pastClock)).toBe(true);
  });

  it("asks to refresh what is absent or past its clock, and nothing else", () => {
    // Inside the writer's interval AND inside the profile's day.
    const fresh = new Date("2026-08-16T22:05:00Z");
    expect(snapshotsToRefresh([env], PROFILE, fresh)).toEqual(
      SNAPSHOT_KINDS.filter((k) => k !== "dose-schedule")
    );
    // Another profile's stored payload never counts as coverage for this one.
    expect(
      snapshotsToRefresh([{ ...env, profileId: OTHER }], PROFILE, fresh)
    ).toEqual([...SNAPSHOT_KINDS]);
  });

  it("re-captures a copy that has been sitting, even while it is still today's", () => {
    // The reader's clock and the writer's are different questions: this payload is
    // still today's schedule (so the banner says nothing), and a med added since
    // lunchtime still has to reach the device.
    const later = new Date(
      new Date(env.fetchedAt).getTime() + SNAPSHOT_REFRESH_INTERVAL_MS + 1000
    );
    expect(isSnapshotStale(env, later)).toBe(false);
    expect(snapshotsToRefresh([env], PROFILE, later)).toContain(
      "dose-schedule"
    );
  });
});

// ── Profile scoping ──────────────────────────────────────────────────────────

describe("profile scoping", () => {
  it("resolves the one profile a store belongs to", () => {
    expect(resolveSnapshotProfile([{ profileId: PROFILE }])).toBe(PROFILE);
    expect(resolveSnapshotProfile([])).toBeNull();
  });

  it("refuses a MIXED store rather than picking one", () => {
    // The offline page is single-profile by construction: a mixed store means a wipe
    // did not run, and rendering "the newest" would be exactly the cross-profile leak
    // the wipe exists to prevent.
    expect(
      resolveSnapshotProfile([{ profileId: PROFILE }, { profileId: OTHER }])
    ).toBeNull();
  });
});

// ── The overlay ──────────────────────────────────────────────────────────────

function doseIntent(
  profileId: number | undefined,
  doseId: number,
  flow: "dose" | "skip-dose",
  date = "2026-08-16"
): QueuedIntent {
  const intent = buildIntent(flow, date, { doseId }, profileId ?? 0);
  if (profileId === undefined) delete intent.profileId;
  return intent;
}

describe("overlay — folding queued writes into a stored read", () => {
  it("marks a dose tapped offline as queued-resolved", () => {
    const data = (doseSnapshot() as SnapshotEnvelope<"dose-schedule">).data;
    const out = overlayDoseSchedule(
      data,
      [doseIntent(PROFILE, 1, "dose")],
      PROFILE
    );
    expect(out.entries[0]).toMatchObject({ status: "taken", queued: true });
    // The already-taken row is the SERVER's fact and is left alone.
    expect(out.entries[1]).toMatchObject({ status: "taken" });
    expect(out.entries[1].queued).toBeUndefined();
  });

  it("NEVER folds another profile's queued intent", () => {
    const data = (doseSnapshot() as SnapshotEnvelope<"dose-schedule">).data;
    const out = overlayDoseSchedule(
      data,
      [doseIntent(OTHER, 1, "dose")],
      PROFILE
    );
    expect(out.entries[0].status).toBe("pending");
  });

  it("folds a LEGACY intent with no profile stamp — its only possible attribution", () => {
    const data = (doseSnapshot() as SnapshotEnvelope<"dose-schedule">).data;
    const out = overlayDoseSchedule(
      data,
      [doseIntent(undefined, 1, "dose")],
      PROFILE
    );
    expect(out.entries[0]).toMatchObject({ status: "taken", queued: true });
  });

  it("ignores a queued tap captured on another day", () => {
    const data = (doseSnapshot() as SnapshotEnvelope<"dose-schedule">).data;
    const out = overlayDoseSchedule(
      data,
      [doseIntent(PROFILE, 1, "dose", "2026-08-15")],
      PROFILE
    );
    expect(out.entries[0].status).toBe("pending");
  });

  it("raises the day's food tallies, including a group with nothing logged yet", () => {
    const data = {
      date: "2026-08-16",
      groups: [{ key: "berries", label: "Berries", servings: 1 }],
      proteinGrams: 20,
    };
    const out = overlayFoodTallies(
      data,
      [
        buildIntent(
          "food",
          "2026-08-16",
          {
            entry: "serving",
            groupKey: "berries",
            mealSlot: null,
            grams: null,
          },
          PROFILE
        ),
        buildIntent(
          "food",
          "2026-08-16",
          { entry: "serving", groupKey: "greens", mealSlot: null, grams: null },
          PROFILE
        ),
        buildIntent(
          "food",
          "2026-08-16",
          { entry: "protein", groupKey: null, mealSlot: null, grams: 30 },
          PROFILE
        ),
      ],
      PROFILE
    );
    expect(out.groups).toContainEqual({
      key: "berries",
      label: "Berries",
      servings: 2,
      queued: 1,
    });
    expect(out.groups).toContainEqual({
      key: "greens",
      label: "greens",
      servings: 1,
      queued: 1,
    });
    expect(out).toMatchObject({ proteinGrams: 50, queuedProteinGrams: 30 });
  });

  it("prepends a queued workout to the recent spine", () => {
    const out = overlayRecentTraining(
      {
        activities: [{ date: "2026-08-15", title: "Run", detail: null }],
        exercises: [],
      },
      [
        buildIntent(
          "set",
          "2026-08-16",
          { fields: { title: "Push day", activity_type: "strength" } },
          PROFILE
        ),
      ],
      PROFILE
    );
    expect(out.activities[0]).toMatchObject({
      title: "Push day",
      queued: true,
    });
    expect(out.activities).toHaveLength(2);
  });

  it("a queued practice raises the week by ONE, however many taps are queued", () => {
    // The replay is day-idempotent, so the overlay must tell the same truth it will:
    // never "+2" for something that will land once.
    const intents = [1, 2].map(() =>
      buildIntent(
        "practice",
        "2026-08-16",
        { practice: "Sauna", identity: "sauna", durationMin: null },
        PROFILE
      )
    );
    const out = overlayPracticeWeek(
      {
        date: "2026-08-16",
        practices: [
          {
            identity: "sauna",
            name: "Sauna",
            perWeek: 3,
            countThisWeek: 1,
            todayCount: 0,
          },
        ],
      },
      intents,
      PROFILE
    );
    expect(out.practices[0]).toMatchObject({
      todayCount: 1,
      countThisWeek: 2,
      queued: 2,
    });
  });

  it("leaves a day already logged alone", () => {
    const out = overlayPracticeWeek(
      {
        date: "2026-08-16",
        practices: [
          {
            identity: "sauna",
            name: "Sauna",
            perWeek: 3,
            countThisWeek: 2,
            todayCount: 1,
          },
        ],
      },
      [
        buildIntent(
          "practice",
          "2026-08-16",
          { practice: "Sauna", identity: "sauna", durationMin: null },
          PROFILE
        ),
      ],
      PROFILE
    );
    expect(out.practices[0]).toMatchObject({
      todayCount: 1,
      countThisWeek: 2,
    });
  });

  it("the med list declares no overlay and gets none", () => {
    expect(SNAPSHOT_REGISTRY["medication-list"].overlays).toEqual([]);
    const meds = envelope({
      kind: "medication-list" as const,
      data: { rows: [] },
    });
    expect(overlaySnapshot(meds, [doseIntent(PROFILE, 1, "dose")])).toBe(meds);
  });
});
