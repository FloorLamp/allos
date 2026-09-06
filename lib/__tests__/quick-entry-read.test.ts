// PURE TIER — the quick logger's read path with no server (#3416): the last-good store
// keyed by the #5211 day-context key, and the map from what the device holds (the
// #2908 snapshots, its own queue) onto each form's payload.

import { describe, expect, it, beforeEach } from "vitest";
import type { DayContextParts, TapReach } from "@/lib/day-context-key";
import { buildIntent, type QueuedIntent } from "@/lib/offline/queue";
import {
  clearLastGood,
  quickEntryOffline,
  recallLastGood,
  rememberLastGood,
} from "@/lib/offline/quick-entry-read";
import { SNAPSHOT_VERSION, type AnySnapshot } from "@/lib/offline/snapshots";
import type { QuickEntryForm } from "@/lib/quick-log";

const ACTING = 7;
const OTHER = 8;
const TODAY = "2026-09-05";
const YESTERDAY = "2026-09-04";
const SHEET: TapReach = { kind: "today" };
const parts: DayContextParts = { profileId: ACTING, day: TODAY, reach: SHEET };

function envelope<T extends AnySnapshot>(
  over: Partial<T> & Pick<T, "kind" | "data">
): AnySnapshot {
  return {
    version: SNAPSHOT_VERSION,
    profileId: ACTING,
    timeZone: "America/Denver",
    capturedOn: TODAY,
    fetchedAt: `${TODAY}T14:00:00Z`,
    ...over,
  } as AnySnapshot;
}

const doses = (date = TODAY, profileId = ACTING) =>
  envelope({
    kind: "dose-schedule" as const,
    profileId,
    data: {
      date,
      entries: [
        {
          doseId: 1,
          name: "Sertraline",
          detail: "50 mg",
          slot: "Morning",
          status: "pending",
        },
        {
          doseId: 2,
          name: "Vitamin D",
          detail: null,
          slot: "Anytime",
          status: "taken",
        },
        {
          doseId: 3,
          name: "Melatonin",
          detail: "3 mg",
          slot: "Bedtime",
          status: "pending",
        },
      ],
    },
  });

const practices = (date = TODAY) =>
  envelope({
    kind: "practice-week" as const,
    data: {
      date,
      practices: [
        {
          identity: "sauna",
          name: "Sauna",
          perWeek: 3,
          countThisWeek: 1,
          todayCount: 0,
        },
        {
          identity: "meditation",
          name: "Meditation",
          perWeek: 2,
          countThisWeek: 2,
          todayCount: 1,
        },
      ],
    },
  });

const intent = (
  flow: QueuedIntent["flow"],
  date: string,
  payload: QueuedIntent["payload"],
  profileId = ACTING
) => buildIntent(flow, date, payload, profileId, new Date(`${date}T15:00:00Z`));

const unavailable = { form: "unavailable", message: "unused" } as const;

describe("last-good, keyed by the day-context key plus the form", () => {
  beforeEach(clearLastGood);

  it("is found by an equal context and missed by a moved one", () => {
    rememberLastGood(
      parts,
      "dose",
      unavailable,
      new Date("2026-09-05T15:00:00Z")
    );
    expect(recallLastGood({ ...parts }, "dose")?.data).toBe(unavailable);
    expect(recallLastGood(parts, "practice")).toBeUndefined();
    for (const moved of [
      { ...parts, day: YESTERDAY },
      { ...parts, profileId: OTHER },
      { ...parts, reach: { kind: "dated" } as TapReach },
    ]) {
      expect(recallLastGood(moved, "dose")).toBeUndefined();
    }
  });

  it("stores the parts beside the key, and the wipe empties it", () => {
    rememberLastGood(parts, "dose", unavailable);
    expect(recallLastGood(parts, "dose")?.parts).toEqual(parts);
    clearLastGood();
    expect(recallLastGood(parts, "dose")).toBeUndefined();
  });
});

describe("the device's own copy of a form", () => {
  it("dose: the day's unresolved doses from the snapshot, queued taps folded in, no PRN row", () => {
    const copy = quickEntryOffline(
      "dose",
      parts,
      ACTING,
      [doses()],
      [
        intent("dose", TODAY, { doseId: 1 }),
        // Another profile's tap, and a tap for another day: neither is today's.
        intent("dose", TODAY, { doseId: 3 }, OTHER),
        intent("dose", YESTERDAY, { doseId: 3 }),
      ]
    );
    expect(copy).toEqual({
      fetchedAt: `${TODAY}T14:00:00Z`,
      data: {
        form: "dose",
        today: TODAY,
        doses: [
          { doseId: 3, title: "Melatonin", detail: "3 mg", dueText: "Bedtime" },
        ],
        pastDays: [],
      },
    });
  });

  it("dose: nothing left is the same answer the gather gives", () => {
    const copy = quickEntryOffline(
      "dose",
      parts,
      ACTING,
      [doses()],
      [
        intent("dose", TODAY, { doseId: 1 }),
        intent("skip-dose", TODAY, { doseId: 3 }),
      ]
    );
    expect(copy?.data).toEqual({
      form: "unavailable",
      message: "No doses are due right now.",
    });
  });

  it("practice: the tracked rows with their week, queued taps folded in, verdicts left quiet", () => {
    const copy = quickEntryOffline(
      "practice",
      parts,
      ACTING,
      [practices()],
      [intent("practice", TODAY, { practice: "Sauna", identity: "sauna" })]
    );
    expect(copy?.fetchedAt).toBe(`${TODAY}T14:00:00Z`);
    expect(copy?.data).toMatchObject({
      form: "practice",
      today: TODAY,
      practices: [
        { identity: "sauna", countThisWeek: 2, todayCount: 1, pace: "on-pace" },
        {
          identity: "meditation",
          countThisWeek: 2,
          todayCount: 1,
          pace: "met",
        },
      ],
    });
  });

  // The snapshot must be the sheet's own day and subject — a copy for another day is
  // a miss (a today payload never fills a yesterday form and vice versa), never a
  // stale render; a copy for another profile is nobody's business here.
  it.each([
    ["yesterday's dose schedule", "dose", [doses(YESTERDAY)]],
    ["another profile's dose schedule", "dose", [doses(TODAY, OTHER)]],
    ["yesterday's practice week", "practice", [practices(YESTERDAY)]],
    ["no snapshot at all", "dose", []],
  ] as const)("%s is a miss", (_what, form, snapshots) => {
    expect(quickEntryOffline(form, parts, ACTING, snapshots, [])).toBeNull();
  });

  it("mood: the chips from the sheet's day, a queued check-in shown on its day", () => {
    const copy = quickEntryOffline(
      "mood",
      parts,
      ACTING,
      [],
      [
        intent("mood", YESTERDAY, {
          valence: 4,
          energy: 3,
          anxiety: null,
          factors: ["sleep"],
          note: "slept well",
        }),
      ]
    );
    expect(copy).toEqual({
      fetchedAt: null,
      data: {
        form: "mood",
        showCalm: false,
        days: [
          { date: TODAY, label: "Today", mood: null },
          {
            date: YESTERDAY,
            label: "Yesterday",
            mood: {
              valence: 4,
              energy: 3,
              anxiety: null,
              factors: ["sleep"],
              notes: "slept well",
            },
          },
          { date: "2026-09-03", label: "2 days ago", mood: null },
        ],
      },
    });
  });

  it("stool: the sheet's day and only this device's queued taps for it", () => {
    const copy = quickEntryOffline(
      "stool",
      parts,
      ACTING,
      [],
      [
        intent("stool", TODAY, { type: 4, at: null }),
        intent("stool", TODAY, { type: 3, at: "07:30" }),
        intent("stool", YESTERDAY, { type: 4, at: null }),
        intent("stool", TODAY, { type: 4, at: null }, OTHER),
      ]
    );
    expect(copy).toEqual({
      fetchedAt: null,
      data: { form: "stool", today: TODAY, todayCount: 2 },
    });
  });

  // The device-known layer is the ACTING profile's: the queue captures under it and
  // refuses a cross-profile write, so a form for anyone else would open onto a refusal.
  it.each(["mood", "stool"] as const)(
    "%s for a chosen non-acting subject is a miss",
    (form) => {
      expect(
        quickEntryOffline(form, { ...parts, profileId: OTHER }, ACTING, [], [])
      ).toBeNull();
    }
  );

  it.each([
    "food",
    "cycle",
    "substance",
    "symptom",
    "document",
    "measurements",
  ] as QuickEntryForm[])("%s has no device copy", (form) => {
    expect(
      quickEntryOffline(form, parts, ACTING, [doses(), practices()], [])
    ).toBeNull();
  });
});
