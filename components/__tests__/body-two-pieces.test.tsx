import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MeasurementsQuickAdd from "@/app/(app)/trends/MeasurementsQuickAdd";
import PediatricWeightUpdate from "@/components/medications/PediatricWeightUpdate";
import MetricReadingsTable from "@/components/MetricReadingsTable";
import BodyMetricRowMenu from "@/app/(app)/trends/BodyMetricRowMenu";
import { bodyMetricMeasures } from "@/lib/body-metric-measures";
import type { PediatricFormContext } from "@/lib/prn-dosing";

// THE BODY DOMAIN'S TWO PIECES (#4424 rulings 1-3), named by `LOG_MANIFEST.body.pieces`.
//
// The manifest cell said three shapes with three field sets and a fourth weight form.
// Measured, the shapes were: `MeasurementsQuickAdd`, the `/history` door's own three
// measures, and `PediatricWeightUpdate` — and the "1-field row edit" counted among them
// is row-control-grade by ruling 3's own words, so it was never a form. It also had
// THREE implementations rather than the one the rowControl cell named: the readings
// table's cell, `/history`'s `case "body"`, and `BodyMetricRowMenu`'s modal.
//
// What this file pins is the two claims a deletion alone cannot make: that the form
// hands EVERY mount one field set, and that every body row hosting a write control
// mounts the same control.

const posted: Record<string, FormData[]> = {};
const record = (name: string) => (fd: FormData) => {
  (posted[name] ??= []).push(fd);
};

vi.mock("@/app/(app)/trends/measurement-actions", () => ({
  addMeasurements: async (fd: FormData) => {
    record("addMeasurements")(fd);
    return {};
  },
}));
vi.mock("@/app/(app)/trends/reading-actions", () => ({
  updateMetricReading: async (fd: FormData) => {
    record("updateMetricReading")(fd);
    return { ok: true };
  },
  deleteMetricReading: async () => ({ undoId: 1 }),
}));
const toasts: string[] = [];
vi.mock("@/components/Toast", () => ({
  useToast: () => (text: string) => toasts.push(text),
}));
vi.mock("@/components/OfflineQueueProvider", () => ({
  useOfflineQueue: () => ({ enqueue: async () => "kept" }),
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/ConfirmDialog", () => ({
  useConfirm: () => async () => true,
  useConfirmOpen: () => false,
  useOptionalConfirm: () => null,
}));
vi.mock("@/components/useUndoableDelete", () => ({
  useUndoableDelete: () => async () => {},
}));

beforeEach(() => {
  for (const key of Object.keys(posted)) delete posted[key];
  toasts.length = 0;
  Element.prototype.scrollIntoView ??= () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  cleanup();
});

/** Every entry field the form renders, by its visible label. */
function renderedFields(): string[] {
  return [
    ...screen
      .getByTestId("measurements-quick-add")
      .querySelectorAll<HTMLLabelElement>("label.label[for]"),
  ].map((node) => node.textContent ?? "");
}

describe("one form, one field set (#4424 ruling 1)", () => {
  // THE FIELD SET IS THE SAME SIZE AT BOTH LIFE STAGES, which is the property the
  // manifest's stale "13-field form" obscured. Asserted as a RELATIONSHIP between the
  // two renders rather than against a constant: the growth pair swaps in exactly as
  // body fat and HRV swap out (#493), so the swap is the claim and the number is a
  // consequence. A gate that starts hiding a field without offering one moves the two
  // sides apart and this fails; changing what the form carries does not.
  it("swaps the life-stage pair without changing what a sitting can hold", () => {
    render(
      <MeasurementsQuickAdd
        defaultDate="2026-05-20"
        weightUnit="kg"
        showBodyFat
      />
    );
    const adult = renderedFields();
    cleanup();
    render(
      <MeasurementsQuickAdd
        defaultDate="2026-05-20"
        weightUnit="kg"
        showBodyFat={false}
        showGrowth
        showHeadCirc
      />
    );
    const minor = renderedFields();

    expect(adult.length).toBe(minor.length);
    expect(adult.filter((label) => !minor.includes(label))).toEqual([
      "Body Fat",
      "Heart Rate Variability",
    ]);
    expect(minor.filter((label) => !adult.includes(label))).toEqual([
      "Height",
      "Head Circumference",
    ]);
    // And the count the corrected manifest cell and the form's own header state.
    expect(adult).toHaveLength(17);
  });

  // A COLLAPSED GROUP STILL POSTS, which is what lets one field set serve a mount that
  // opens on Body and a mount that opens on Vitals. The sitting below types into two
  // groups and only one of them is open.
  it("posts every group's fields from one submission", async () => {
    render(
      <MeasurementsQuickAdd
        defaultDate="2026-05-20"
        weightUnit="kg"
        defaultGroup="body"
      />
    );
    fireEvent.change(screen.getByLabelText("Weight"), {
      target: { value: "80" },
    });
    fireEvent.change(screen.getByLabelText("Oxygen Saturation"), {
      target: { value: "97" },
    });
    await act(async () =>
      fireEvent.submit(screen.getByTestId("measurements-quick-add"))
    );
    const fd = posted.addMeasurements[0];
    expect([fd.get("weight"), fd.get("spo2"), fd.get("date")]).toEqual([
      "80",
      "97",
      "2026-05-20",
    ]);
  });
});

describe("the pediatric label lookup mounts that form (#4424 ruling 2)", () => {
  const CONTEXT: PediatricFormContext = {
    ageMonths: 40,
    weightKg: null,
    weightDate: null,
    weightUnit: "kg",
    today: "2026-05-20",
  };

  it("defines no fields of its own and hands back the sitting's canonical kg", async () => {
    const saved: PediatricFormContext[] = [];
    render(
      <PediatricWeightUpdate
        context={CONTEXT}
        initiallyOpen
        onSaved={(next) => saved.push(next)}
      />
    );
    // The mount, not a copy: everything enterable here belongs to the shared form.
    expect(screen.getByTestId("measurements-quick-add")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Weight"), {
      target: { value: "16.8" },
    });
    await act(async () =>
      fireEvent.submit(screen.getByTestId("measurements-quick-add"))
    );
    expect(posted.addMeasurements[0].get("weight")).toBe("16.8");
    // The dose band is re-derived from what was WRITTEN, in canonical kilograms, so
    // this host does not keep a second copy of the field to read the number back out.
    expect(saved).toEqual([
      { ...CONTEXT, weightKg: 16.8, weightDate: "2026-05-20" },
    ]);
  });
});

describe("one row control, every body row that hosts one (#4424 ruling 3)", () => {
  const ROW = {
    id: 1,
    date: "2026-07-01",
    target: "body_metrics:1:weight_kg",
    display: "80",
    editValue: 80,
    source: null,
    flag: null,
    edited: false,
    notes: null,
  };

  // TWO MOUNTS, ONE CONTROL, ONE PAYLOAD. Both surfaces open their own affordance —
  // an inline cell on the detail page, a modal on the Trends census — and reach the
  // same component, so a correction posted from either names the row the same way.
  // Driven through each host's real affordance, never by rendering the control itself.
  it.each([
    [
      "the metric detail page's readings table",
      () => {
        render(
          <MetricReadingsTable
            kind="weight"
            unit=" kg"
            weightUnit="lb"
            rows={[ROW]}
          />
        );
        fireEvent.click(screen.getByTestId("overflow-menu-trigger"));
        fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
      },
    ],
    [
      "the Trends body census row menu",
      () => {
        render(
          <BodyMetricRowMenu
            id={1}
            label="Jul 1"
            weightUnit="lb"
            measures={bodyMetricMeasures(
              { id: 1, weight_kg: 80, body_fat_pct: null, resting_hr: null },
              "lb"
            )}
          />
        );
        fireEvent.click(screen.getByTestId("overflow-menu-trigger"));
        fireEvent.click(screen.getByTestId("body-history-edit-weight_kg"));
      },
    ],
  ])("%s mounts it", async (_surface, open) => {
    open();
    expect(screen.getByTestId("reading-value-control")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Reading value"), {
      target: { value: "82" },
    });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Save" }))
    );
    const fd = posted.updateMetricReading[0];
    expect([fd.get("kind"), fd.get("target"), fd.get("weight_unit")]).toEqual([
      "weight",
      "body_metrics:1:weight_kg",
      "lb",
    ]);
    // One control, one sentence: the hosts used to round the same write two ways.
    expect(toasts).toEqual(["Reading updated."]);
  });
});
