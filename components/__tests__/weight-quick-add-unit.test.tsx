import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import WeightQuickAdd from "../dashboard/WeightQuickAdd";
import type { WeightUnit } from "@/lib/settings";

// THE DASHBOARD WEIGH-IN CARRIES THE UNIT IT WAS TYPED IN (#2863, the last surface
// exposed to #630).
//
// The widget prints the unit in its own label — "Log today's weight (kg)" — and used
// to post only the number, so `addBodyMetric` fell back to the login's CURRENT stored
// pref. Those two answers are the same right up until the pref changes between render
// and submit, and then the number is converted by a unit the person never saw: 82
// typed under a "(kg)" label after a kg→lb flip in another tab stores 37.2 kg.
//
// WHY THIS TIER. The gap is in the markup, not in the action — `addBodyMetric` has
// honored a posted `weight_unit` since #630, and the storage arithmetic over a
// DIFFERING stored pref is driven at the action tier in
// lib/__action_tests__/weight-unit-carry.actions.test.ts with this widget's exact
// payload shape. What only exists once the component is mounted is whether the field
// is in the form at all, so that is what this file asserts, read off the submitted
// FormData rather than off the props.

/** Every payload the action was handed — what the form posted, not what it meant to. */
const posted: FormData[] = [];
vi.mock("@/app/(app)/trends/body-actions", () => ({
  addBodyMetric: async (fd: FormData) => {
    posted.push(fd);
  },
}));

/** Every payload the offline queue was handed, for the same question on the other door. */
const queued: { weightUnit: WeightUnit }[] = [];
vi.mock("@/components/OfflineQueueProvider", () => ({
  useOfflineQueue: () => ({
    pending: 0,
    enqueue: async (
      _kind: string,
      _date: string,
      p: { weightUnit: WeightUnit }
    ) => {
      queued.push(p);
      return "kept" as const;
    },
    flush: async () => {},
  }),
}));

vi.mock("@/components/Toast", () => ({ useToast: () => () => {} }));

const TODAY = "2026-08-26";

beforeEach(() => {
  posted.length = 0;
  queued.length = 0;
});

/** Render the widget in `unit`, type `typed`, submit. */
function logWeight(unit: WeightUnit, typed: string): void {
  const { container } = render(
    <WeightQuickAdd weightUnit={unit} today={TODAY} subjectName={null} />
  );
  fireEvent.change(screen.getByTestId("weight-quick-add-input"), {
    target: { value: typed },
  });
  act(() =>
    fireEvent.submit(container.querySelector("form") as HTMLFormElement)
  );
}

describe("the dashboard quick-add posts the unit its label printed", () => {
  it.each([
    { unit: "kg", typed: "82" },
    { unit: "lb", typed: "180" },
  ] as { unit: WeightUnit; typed: string }[])(
    "$typed typed under a ($unit) label posts weight_unit=$unit",
    async ({ unit, typed }) => {
      logWeight(unit, typed);
      await act(async () => {});
      // The label is the person's only statement of what they typed, so the field
      // must agree with it — asserted together, since a hard-coded unit would satisfy
      // either one alone.
      expect(screen.getByText(`Log today's weight (${unit})`)).toBeTruthy();
      expect([
        posted.at(-1)?.get("weight"),
        posted.at(-1)?.get("weight_unit"),
      ]).toEqual([typed, unit]);
    }
  );

  it("queues the same unit when the device is offline", async () => {
    // The control: the offline payload has always carried the unit, which is what made
    // the online submit the odd one out. Both doors, one answer.
    Object.defineProperty(navigator, "onLine", {
      value: false,
      configurable: true,
    });
    try {
      logWeight("kg", "82");
      await act(async () => {});
    } finally {
      // Deleting the OWN property hands the read back to the prototype getter,
      // which is jsdom's real one — no saved descriptor to restore wrongly.
      Reflect.deleteProperty(navigator, "onLine");
    }
    expect([posted.length, queued.at(-1)?.weightUnit]).toEqual([0, "kg"]);
  });
});
