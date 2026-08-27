import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import WeightQuickAdd from "../dashboard/WeightQuickAdd";
import type { WeightUnit } from "@/lib/settings";

// THE DASHBOARD WEIGH-IN CARRIES THE UNIT IT WAS TYPED IN (#2863, the last capture
// surface exposed to #630).
//
// The widget prints the unit in its own label and used to post only the number, so
// `addBodyMetric` fell back to the login's CURRENT stored pref. The two answers agree
// right up until the pref changes between render and submit, and then the number is
// converted by a unit the person never saw.
//
// WHY THIS TIER: the gap is in the markup, not the action — which has honored a posted
// `weight_unit` since #630, and is driven over a DIFFERING stored pref, in this
// widget's payload shape, in lib/__action_tests__/weight-unit-carry.actions.test.ts.
// Whether the field is in the form at all only exists once something is mounted.

/** What the action and the offline queue were HANDED — posted, not intended. */
const posted: FormData[] = [];
const queued: { weightUnit: WeightUnit }[] = [];

vi.mock("@/app/(app)/trends/body-actions", () => ({
  addBodyMetric: async (fd: FormData) => {
    posted.push(fd);
  },
}));
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

beforeEach(() => {
  posted.length = 0;
  queued.length = 0;
});

/** Render in `unit`, type `typed`, submit, settle. */
async function logWeight(unit: WeightUnit, typed: string): Promise<void> {
  const { container } = render(
    <WeightQuickAdd weightUnit={unit} today="2026-08-26" subjectName={null} />
  );
  fireEvent.change(screen.getByTestId("weight-quick-add-input"), {
    target: { value: typed },
  });
  await act(async () =>
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
      await logWeight(unit, typed);
      // Label and field asserted together: a hard-coded unit satisfies either alone,
      // and the label is the person's only statement of what they typed.
      expect([
        screen.queryByText(`Log today's weight (${unit})`) !== null,
        posted.at(-1)?.get("weight"),
        posted.at(-1)?.get("weight_unit"),
      ]).toEqual([true, typed, unit]);
    }
  );

  it("queues the same unit when the device is offline", async () => {
    // The control: the offline payload always carried the unit, which is what made the
    // online submit the odd one out. Both doors, one answer.
    Object.defineProperty(navigator, "onLine", {
      value: false,
      configurable: true,
    });
    try {
      await logWeight("kg", "82");
    } finally {
      // Deleting the OWN property hands the read back to jsdom's real prototype getter.
      Reflect.deleteProperty(navigator, "onLine");
    }
    expect([posted.length, queued.at(-1)?.weightUnit]).toEqual([0, "kg"]);
  });
});
