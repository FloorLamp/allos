import { describe, expect, it } from "vitest";
import {
  foodServingCoordinate,
  foodServingFeedback,
  foodServingInverseKey,
  beginFoodServingAdd,
  beginFoodServingNonAddMutation,
  emptyFoodServingBurst,
  finishFoodServingNonAddMutation,
  invalidateFoodServingBurst,
  requestFoodServingTruth,
  settleFoodServingAdd,
} from "@/lib/food-serving-feedback";
import {
  dismissOtherProfileToasts,
  upsertToast,
  type KeyedToast,
} from "@/lib/toast-upsert";

interface TestToast extends KeyedToast {
  message: string;
}

describe("foodServingFeedback", () => {
  it("replaces two taps with one keyed cumulative toast", () => {
    let toasts: TestToast[] = [];
    for (const servings of [1, 2]) {
      const feedback = foodServingFeedback(
        7,
        "2026-08-24",
        "vegetables",
        "Vegetables",
        servings,
        "Today"
      );
      toasts = upsertToast(toasts, {
        id: servings,
        revision: 0,
        ...feedback,
      });
    }

    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({
      key: "food-serving:7:2026-08-24:vegetables",
      message: "2 servings of Vegetables today",
      revision: 1,
    });
  });

  it("keeps every partial settlement away from three optimistic taps and binds Undo to tap order", () => {
    let state = emptyFoodServingBurst();
    const morning = beginFoodServingAdd(state, "morning", "Morning");
    state = morning.state;
    const evening = beginFoodServingAdd(state, "evening", "Evening");
    state = evening.state;
    const midday = beginFoodServingAdd(state, "midday", "Midday");
    state = midday.state;

    // Natural response order: after three optimistic taps are already visible,
    // the first response knows only its own total. It must not publish a count
    // that would roll the UI 3→1 while the other taps are still pending.
    const first = settleFoodServingAdd(state, morning.tap, {
      kind: "landed",
      eventId: 11,
    });
    expect(first.completed).toBe(false);
    expect(first.receipt).toBeUndefined();

    const second = settleFoodServingAdd(first.state, evening.tap, {
      kind: "landed",
      eventId: 12,
    });
    expect(second.completed).toBe(false);
    expect(second.receipt).toBeUndefined();

    // A concurrent removal can make the final action's own result numerically
    // lower. The coordinator accepts only success/tap identity; response totals
    // never enter this protocol, and the caller performs one fresh read now.
    const final = settleFoodServingAdd(second.state, midday.tap, {
      kind: "landed",
      eventId: 13,
    });

    expect(final.completed).toBe(true);
    expect(final.receipt).toEqual({
      coordinate: "midday",
      mealSlot: "Midday",
      eventId: 13,
    });
  });

  it("ignores a delayed add settlement after a decrement starts a new epoch", () => {
    const begun = beginFoodServingAdd(
      emptyFoodServingBurst(),
      "morning",
      "Morning"
    );
    const afterRemoval = invalidateFoodServingBurst(begun.state);
    const stale = settleFoodServingAdd(afterRemoval, begun.tap, {
      kind: "landed",
      eventId: 11,
    });
    expect(stale.accepted).toBe(false);
    expect(stale.completed).toBe(false);
    expect(stale.receipt).toBeUndefined();
  });

  it("defers truth read during correction or removal and releases it only for that mutation", () => {
    const add = beginFoodServingAdd(
      emptyFoodServingBurst(),
      "morning",
      "Morning"
    );
    const pending = beginFoodServingNonAddMutation(add.state);
    const requested = requestFoodServingTruth(pending);

    expect(requested.readNow).toBe(false);
    expect(requested.state.truthDeferred).toBe(true);
    expect(
      settleFoodServingAdd(requested.state, add.tap, {
        kind: "landed",
        eventId: 11,
      }).accepted
    ).toBe(false);

    const staleFinish = finishFoodServingNonAddMutation(
      requested.state,
      requested.state.epoch - 1
    );
    expect(staleFinish.refreshDeferredTruth).toBe(false);
    expect(staleFinish.state.nonAddPending.size).toBe(1);

    const finished = finishFoodServingNonAddMutation(
      requested.state,
      requested.state.epoch
    );
    expect(finished.refreshDeferredTruth).toBe(true);
    expect(finished.state.nonAddPending.size).toBe(0);
    expect(requestFoodServingTruth(finished.state).readNow).toBe(true);
  });

  it("keeps a correction token through a newer add and fences truth again at completion", () => {
    const correction = beginFoodServingNonAddMutation(emptyFoodServingBurst());
    const correctionEpoch = correction.epoch;
    const add = beginFoodServingAdd(correction, "morning", "Morning");

    expect(add.state.nonAddPending.has(correctionEpoch)).toBe(true);
    expect(requestFoodServingTruth(add.state).readNow).toBe(false);

    const completed = finishFoodServingNonAddMutation(
      add.state,
      correctionEpoch
    );
    expect(completed.state.epoch).toBe(add.state.epoch);
    expect(completed.state.truthRevision).toBeGreaterThan(
      add.state.truthRevision
    );
    expect(completed.state.nonAddPending.size).toBe(0);
  });

  it("waits for every overlapping non-add token before releasing deferred truth", () => {
    const first = beginFoodServingNonAddMutation(emptyFoodServingBurst());
    const second = beginFoodServingNonAddMutation(first);
    const requested = requestFoodServingTruth(second).state;

    const secondDone = finishFoodServingNonAddMutation(requested, second.epoch);
    expect(secondDone.refreshDeferredTruth).toBe(false);
    expect(secondDone.state.nonAddPending.has(first.epoch)).toBe(true);

    const allDone = finishFoodServingNonAddMutation(
      secondDone.state,
      first.epoch
    );
    expect(allDone.refreshDeferredTruth).toBe(true);
    expect(allDone.state.nonAddPending.size).toBe(0);
  });

  it("advances the mutation epoch for a later burst and keeps tap-ordered event identity", () => {
    const first = beginFoodServingAdd(
      emptyFoodServingBurst(),
      "morning",
      "Morning"
    );
    const second = beginFoodServingAdd(first.state, "evening", "Evening");
    const laterTapFirst = settleFoodServingAdd(second.state, second.tap, {
      kind: "landed",
      eventId: 32,
    });
    const completed = settleFoodServingAdd(laterTapFirst.state, first.tap, {
      kind: "landed",
      eventId: 31,
    });
    expect(completed.receipt).toEqual({
      coordinate: "evening",
      mealSlot: "Evening",
      eventId: 32,
    });

    const laterBurst = beginFoodServingAdd(completed.state, "midday", "Midday");
    expect(laterBurst.tap.epoch).toBeGreaterThan(first.tap.epoch);
  });

  it("keeps successful receipt and failure channel when the final tap fails", () => {
    let state = emptyFoodServingBurst();
    const first = beginFoodServingAdd(state, "morning", "Morning");
    state = first.state;
    const second = beginFoodServingAdd(state, "evening", "Evening");
    const success = settleFoodServingAdd(second.state, first.tap, {
      kind: "landed",
      eventId: 21,
    });
    const failure = settleFoodServingAdd(success.state, second.tap, {
      kind: "kept",
    });
    expect(failure.receipt).toEqual({
      coordinate: "morning",
      mealSlot: "Morning",
      eventId: 21,
    });
    expect(failure.completed).toBe(true);
    expect(failure.reportFailure).toBe(true);
  });

  // THE FOUR DISPOSITIONS, and the two different questions they answer.
  // `reconcile` asks whether this burst still owes the counter an authoritative read;
  // `landed` asks whether anything reached the server, which is what the wording around
  // that read may claim. Only `discarded` answers no to both — the DEVICE refused it
  // before anything was sent, so it rolled its own paint back, said so on the way past,
  // and there is nothing on any server to go and look for. `unwitnessed` looks identical
  // on screen and is not: that request left and lost its answer, so the refusal it
  // printed is a claim nobody checked, and only the read can check it.
  it.each([
    {
      name: "a landing owes a read and may say it saved",
      outcome: { kind: "landed" as const },
      reconcile: true,
      landed: true,
      reportFailure: false,
    },
    {
      name: "a kept failure owes a read and may not",
      outcome: { kind: "kept" as const },
      reconcile: true,
      landed: false,
      reportFailure: true,
    },
    {
      name: "a discarded tap owes nothing and has already spoken",
      outcome: { kind: "discarded" as const },
      reconcile: false,
      landed: false,
      reportFailure: false,
    },
    {
      name: "an unwitnessed tap owes a read, claims nothing, and repeats nothing",
      outcome: { kind: "unwitnessed" as const },
      reconcile: true,
      landed: false,
      // It already spoke. `reportFailure` is "a failure nobody has heard yet", so
      // counting this one would print a second sentence beside the first.
      reportFailure: false,
    },
  ])("$name", ({ outcome, reconcile, landed, reportFailure }) => {
    const tap = beginFoodServingAdd(
      emptyFoodServingBurst(),
      "morning",
      "Morning"
    );
    const settled = settleFoodServingAdd(tap.state, tap.tap, outcome);
    expect(settled.completed).toBe(true);
    expect(settled.reconcile).toBe(reconcile);
    expect(settled.landed).toBe(landed);
    expect(settled.reportFailure).toBe(reportFailure);
    // A nameless landing has nothing to bind an Undo to either way.
    expect(settled.receipt).toBeUndefined();
  });

  // A burst is finished once, so both questions answer for the WHOLE burst. An
  // earlier serving that landed still owes the day a read when the tap that
  // completes the burst is the one that failed — and a tap whose guess is still
  // standing still owes one when the burst's only landing was somebody else's.
  it("answers for the whole burst, not for its completing tap", () => {
    const first = beginFoodServingAdd(
      emptyFoodServingBurst(),
      "morning",
      "Morning"
    );
    const second = beginFoodServingAdd(first.state, "morning", "Morning");
    const success = settleFoodServingAdd(second.state, first.tap, {
      kind: "landed",
      eventId: 21,
    });
    expect(success.completed).toBe(false);
    expect(success.reconcile).toBe(false);
    const failure = settleFoodServingAdd(success.state, second.tap, {
      kind: "discarded",
    });
    // The completing tap took its own guess back, but the first tap's serving is
    // still on the counter awaiting the server's figure.
    expect(failure.reconcile).toBe(true);
    expect(failure.landed).toBe(true);
  });

  // AN ALL-UNWITNESSED BURST STILL OWES A READ, which is the case a burst counted only
  // by `landed + kept` loses: nothing is painted, every tap was refused by the queue and
  // said so — and every one of those requests may nonetheless have committed.
  it("owes a read when every tap left the device and lost its answer", () => {
    const first = beginFoodServingAdd(
      emptyFoodServingBurst(),
      "morning",
      "Morning"
    );
    const second = beginFoodServingAdd(first.state, "morning", "Morning");
    const one = settleFoodServingAdd(second.state, first.tap, {
      kind: "unwitnessed",
    });
    expect(one.completed).toBe(false);
    const two = settleFoodServingAdd(one.state, second.tap, {
      kind: "unwitnessed",
    });
    expect(two.completed).toBe(true);
    expect(two.reconcile).toBe(true);
    expect(two.landed).toBe(false);
    expect(two.reportFailure).toBe(false);
    expect(two.receipt).toBeUndefined();
  });

  it("keys settle state by profile, day, meal, and group", () => {
    expect(
      foodServingCoordinate(7, "2026-08-24", "Morning", "berries")
    ).not.toBe(foodServingCoordinate(7, "2026-08-24", "Evening", "berries"));
    expect(
      foodServingCoordinate(7, "2026-08-24", "Morning", "berries")
    ).not.toBe(foodServingCoordinate(7, "2026-08-23", "Morning", "berries"));
  });

  it("keeps one toast slot but gives every upgraded Undo a fresh write identity", () => {
    const coordinate = foodServingCoordinate(
      7,
      "2026-08-24",
      "Morning",
      "berries"
    );
    expect(foodServingInverseKey(coordinate, 1)).not.toBe(
      foodServingInverseKey(coordinate, 2)
    );
    expect(
      foodServingFeedback(7, "2026-08-24", "berries", "Berries", 1, "Today").key
    ).toBe(
      foodServingFeedback(7, "2026-08-24", "berries", "Berries", 2, "Today").key
    );
  });

  it("drops shown and queued receipts from the previous profile only", () => {
    const toasts: TestToast[] = [
      {
        id: 1,
        revision: 0,
        key: "food-serving:7:2026-08-24:berries",
        profileId: 7,
        message: "A receipt",
      },
      {
        id: 2,
        revision: 0,
        key: "food-serving:8:2026-08-24:berries",
        profileId: 8,
        message: "B receipt",
      },
      { id: 3, revision: 0, message: "Unscoped notice" },
    ];

    expect(
      dismissOtherProfileToasts(toasts, 8).map((toast) => toast.id)
    ).toEqual([2, 3]);
  });

  it("lets precise removal replace the older add receipt in the same slot", () => {
    const key = foodServingFeedback(
      7,
      "2026-08-24",
      "berries",
      "Berries",
      1,
      "Today"
    ).key;
    const add = testToast({
      id: 1,
      key,
      message: "1 serving of Berries today",
    });
    const removal = testToast({ id: 2, key, message: "Serving removed." });

    const toasts = upsertToast([add], removal);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({
      id: 1,
      key,
      message: "Serving removed.",
      revision: 1,
    });
  });
});

function testToast(overrides: Partial<TestToast> & { id: number }): TestToast {
  return { revision: 0, message: "", ...overrides };
}
