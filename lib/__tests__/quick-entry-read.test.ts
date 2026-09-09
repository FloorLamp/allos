// PURE TIER — the quick logger's server-free read path (#3416): canonical
// last-good identity and honest mappings from the existing snapshot/queue stores.

import { beforeEach, describe, expect, it } from "vitest";
import { dayContextKey, type DayContextParts } from "@/lib/day-context-key";
import { FOOD_GROUPS } from "@/lib/food-groups";
import { FOOD_SLOTS, type FoodSlot } from "@/lib/food-slot";
import {
  buildIntent,
  type IntentPayload,
  type QueuedIntent,
} from "@/lib/offline/queue";
import {
  captureLastGoodToken,
  clearLastGood,
  quickEntryOffline,
  recallLastGood,
  rememberLastGood,
} from "@/lib/offline/quick-entry-read";
import { SNAPSHOT_VERSION, type AnySnapshot } from "@/lib/offline/snapshots";

const ACTING = 7;
const OTHER = 8;
const TODAY = "2026-09-05";
const YESTERDAY = "2026-09-04";
const parts: DayContextParts = {
  profileId: ACTING,
  day: TODAY,
  reach: { kind: "today" },
};
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

const doseSnapshot = (date = TODAY, profileId = ACTING) =>
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
          status: "pending" as const,
        },
        {
          doseId: 2,
          name: "Vitamin D",
          detail: null,
          slot: "Anytime",
          status: "taken" as const,
        },
        {
          doseId: 3,
          name: "Melatonin",
          detail: "3 mg",
          slot: "Bedtime",
          status: "pending" as const,
        },
      ],
    },
  });

const practiceSnapshot = (date = TODAY) =>
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
      ],
    },
  });

const ranked = Object.fromEntries(
  FOOD_SLOTS.map((slot) => [slot, FOOD_GROUPS.map((group) => group.slug)])
) as Record<FoodSlot, string[]>;

const foodSnapshot = (quickEntry: "available" | "unavailable" | "legacy") =>
  envelope({
    kind: "food-tallies" as const,
    data: {
      date: TODAY,
      groups: [{ key: "berries", label: "Berries", servings: 1 }],
      proteinGrams: 10,
      ...(quickEntry === "legacy"
        ? {}
        : {
            quickEntry:
              quickEntry === "unavailable"
                ? ({ available: false } as const)
                : {
                    available: true as const,
                    rankedGroupSlugsBySlot: ranked,
                    proteinRankBySlot: {
                      Morning: 2,
                      Midday: 3,
                      Evening: 4,
                    },
                    proteinPreset: 25,
                    excludedGroups: ["added_sugar"],
                    slotBoundaries: { midday: 660, evening: 900 },
                    slotCounts: {
                      Morning: { berries: 1 },
                      Midday: {},
                      Evening: {},
                    },
                  },
          }),
    },
  });

function intent(
  flow: QueuedIntent["flow"],
  date: string,
  payload: IntentPayload,
  profileId = ACTING
): QueuedIntent {
  const nextParts = { ...parts, profileId, day: date };
  return buildIntent(
    flow,
    payload,
    {
      parts: nextParts,
      key: dayContextKey(nextParts),
      isPrimaryDay: date === TODAY,
    },
    new Date(`${date}T15:00:00Z`)
  );
}

const unavailable = {
  form: "unavailable",
  today: TODAY,
  message: "unused",
} as const;

describe("last-good identity", () => {
  beforeEach(clearLastGood);

  it("finds an equal canonical context and misses a moved one", () => {
    rememberLastGood(
      captureLastGoodToken(),
      parts,
      "dose",
      unavailable,
      new Date("2026-09-05T15:00:00Z")
    );
    expect(recallLastGood({ ...parts }, "dose")?.data).toBe(unavailable);
    expect(recallLastGood(parts, "practice")).toBeUndefined();
    expect(
      recallLastGood({ ...parts, day: YESTERDAY }, "dose")
    ).toBeUndefined();
    expect(
      recallLastGood({ ...parts, profileId: OTHER }, "dose")
    ).toBeUndefined();
    expect(
      recallLastGood({ ...parts, reach: { kind: "dated" } }, "dose")
    ).toBeUndefined();
  });

  it("refuses a write whose token predates the wipe", () => {
    const token = captureLastGoodToken();
    clearLastGood();
    rememberLastGood(token, parts, "dose", unavailable);
    expect(recallLastGood(parts, "dose")).toBeUndefined();

    rememberLastGood(captureLastGoodToken(), parts, "dose", unavailable);
    expect(recallLastGood(parts, "dose")?.data).toBe(unavailable);
  });
});

describe("the device's own copy", () => {
  it("maps the day's unresolved doses and folds queued resolutions", () => {
    const copy = quickEntryOffline(
      "dose",
      parts,
      ACTING,
      [doseSnapshot()],
      [
        intent("dose", TODAY, { doseId: 1 }),
        intent("dose", TODAY, { doseId: 3 }, OTHER),
        intent("dose", YESTERDAY, { doseId: 3 }),
      ]
    );
    expect(copy).toMatchObject({
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

  it("maps practice facts and folds the queued day once", () => {
    const copy = quickEntryOffline(
      "practice",
      parts,
      ACTING,
      [practiceSnapshot()],
      [intent("practice", TODAY, { practice: "Sauna", identity: "sauna" })]
    );
    expect(copy?.data).toMatchObject({
      form: "practice",
      today: TODAY,
      practices: [
        { identity: "sauna", countThisWeek: 2, todayCount: 1, pace: "on-pace" },
      ],
    });
  });

  it("maps the persisted Food catalog, queued counts, and live profile-zone slot", () => {
    const copy = quickEntryOffline(
      "food",
      parts,
      ACTING,
      [foodSnapshot("available")],
      [
        intent("food", TODAY, {
          entry: "serving",
          groupKey: "berries",
          mealSlot: "Midday",
          grams: null,
        }),
        intent("food", TODAY, {
          entry: "protein",
          groupKey: null,
          mealSlot: null,
          grams: 5,
        }),
      ],
      // 14:30Z is 08:30 in Denver in September: Morning under the stored schedule.
      new Date("2026-09-05T14:30:00Z")
    );
    expect(copy).toMatchObject({
      fetchedAt: `${TODAY}T14:00:00Z`,
      data: {
        form: "food",
        today: TODAY,
        proteinGrams: 15,
        proteinPreset: 25,
        excludedGroups: ["added_sugar"],
        slot: "Morning",
        days: [
          {
            date: TODAY,
            counts: { berries: 2 },
            slotCounts: {
              Morning: { berries: 1 },
              Midday: { berries: 1 },
              Evening: {},
            },
            events: [],
          },
        ],
      },
    });
  });

  it("renders a stored unavailable Food decision and treats legacy tallies as a miss", () => {
    expect(
      quickEntryOffline(
        "food",
        parts,
        ACTING,
        [foodSnapshot("unavailable")],
        []
      )?.data
    ).toMatchObject({ form: "unavailable", today: TODAY });
    expect(
      quickEntryOffline("food", parts, ACTING, [foodSnapshot("legacy")], [])
    ).toBeNull();
  });

  it("refuses a Food snapshot for a nonacting subject whose writes cannot queue", () => {
    const otherParts = { ...parts, profileId: OTHER };
    const snapshot = { ...foodSnapshot("available"), profileId: OTHER };
    expect(
      quickEntryOffline("food", otherParts, ACTING, [snapshot], [])
    ).toBeNull();
  });

  it.each([
    ["yesterday's dose schedule", "dose", [doseSnapshot(YESTERDAY)]],
    ["another profile's dose schedule", "dose", [doseSnapshot(TODAY, OTHER)]],
    ["yesterday's practice week", "practice", [practiceSnapshot(YESTERDAY)]],
  ] as const)("refuses %s", (_label, form, snapshots) => {
    expect(quickEntryOffline(form, parts, ACTING, snapshots, [])).toBeNull();
  });

  it("marks every Mood device copy blind while showing its own queued statement", () => {
    const copy = quickEntryOffline(
      "mood",
      parts,
      ACTING,
      [],
      [
        intent("mood", TODAY, {
          valence: 4,
          energy: 3,
          anxiety: 2,
          factors: ["sleep"],
          note: "slept well",
        }),
      ]
    );
    expect(copy?.data).toMatchObject({
      form: "mood",
      today: TODAY,
      showCalm: true,
      dayUnseen: true,
      days: [
        {
          date: TODAY,
          mood: {
            valence: 4,
            energy: 3,
            anxiety: 2,
            factors: ["sleep"],
            notes: "slept well",
          },
        },
      ],
    });
  });

  it("counts only this profile's queued stool taps on this day", () => {
    const copy = quickEntryOffline(
      "stool",
      parts,
      ACTING,
      [],
      [
        intent("stool", TODAY, { type: 4, at: null }),
        intent("stool", YESTERDAY, { type: 3, at: null }),
        intent("stool", TODAY, { type: 2, at: null }, OTHER),
      ]
    );
    expect(copy?.data).toEqual({
      form: "stool",
      today: TODAY,
      todayCount: 1,
    });
  });

  it.each(["mood", "stool"] as const)(
    "refuses the device-known %s copy for a nonacting subject",
    (form) => {
      expect(
        quickEntryOffline(form, { ...parts, profileId: OTHER }, ACTING, [], [])
      ).toBeNull();
    }
  );
});
