import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ActivityPartsList from "@/components/activity-form/ActivityPartsList";
import type { PartEntry } from "@/lib/activity-form-model";

// THE PER-PART FACT ROW (#3349), at the tier where its wiring is cheap to ask about.
//
// The vocabulary — which chips a part states, which offered facts have nothing to say,
// and #3367's reachability answer — is pure and pinned by the table in
// `lib/__tests__/activity-part-facts.test.ts`. What needs a DOM is the half that table
// cannot see: that the row RENDERS those chips, that the options panel draws exactly
// the controls the part offers, and that one open editor is one open editor across the
// whole form rather than per exercise.
vi.mock("@/app/(app)/training/activity-actions", () => ({
  setRpeTrackingAction: vi.fn(async () => ({ tracking: null })),
}));
vi.mock("@/app/(app)/training/actions", () => ({
  dismissTrainingObservation: vi.fn(),
}));
vi.mock("@/components/ActivityEditorProvider", () => ({
  useActivityEditor: () => ({ leaveFor: vi.fn() }),
}));

// The options panel carries the RPE info affordance, and the shared anchored popover
// observes the document on mount. jsdom ships no ResizeObserver — the same stand-in
// eight sibling files in this tier already install.
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

function part(over: Partial<PartEntry> = {}): PartEntry {
  return {
    name: "Barbell Bench Press",
    custom: false,
    customType: null,
    sets: [],
    perSide: false,
    equipmentId: null,
    distance: "",
    durationMin: "",
    targetReps: "",
    toFailure: false,
    ...over,
  };
}

function renderList(parts: PartEntry[], over: Record<string, unknown> = {}) {
  const onUpdatePart = vi.fn();
  render(
    <ActivityPartsList
      parts={parts}
      stickyFooter={false}
      isEdit={false}
      live={false}
      units={{ weightUnit: "kg", distanceUnit: "km", temperatureUnit: "F" }}
      history={{}}
      deloadContext={{ isDeloadWeek: false, routineKeys: [] }}
      recoveringContext={{ temperedRegions: [], constraints: [] }}
      plateauHints={[]}
      rpeTracking={null}
      onRpeTrackingChange={vi.fn()}
      currentActivityId={null}
      editedDate={null}
      equipmentList={[]}
      onEquipmentCreated={vi.fn()}
      overallDuration={null}
      bwKnown
      firstBwPart={-1}
      bwInput=""
      bwSaving={false}
      onBwInput={vi.fn()}
      onSaveBodyweight={vi.fn()}
      equipmentRankedOptions={[]}
      usedActivityNames={new Set()}
      enteredLiftBases={[]}
      liftCompanions={{}}
      isKnown={() => true}
      partType={() => "strength"}
      partNeedsDistance={() => false}
      partIssue={() => null}
      blocked={false}
      canAddPart={false}
      showRollup={false}
      rollupDistanceKm={null}
      rollupDurationMin={null}
      onTypePartName={vi.fn()}
      onPickPartName={vi.fn()}
      onMovePart={vi.fn()}
      onRemovePart={vi.fn()}
      onAddPart={vi.fn()}
      onUpdatePart={onUpdatePart}
      onUpdateSet={vi.fn()}
      onAddSet={vi.fn()}
      onRemoveSet={vi.fn()}
      onUpdatePartName={vi.fn()}
      onApplySuggestion={vi.fn()}
      onApplyPerSideSuggestion={vi.fn()}
      onFillFromSession={vi.fn()}
      onPlateFromSuggestion={vi.fn()}
      onPlateTarget={vi.fn()}
      {...over}
    />
  );
  return { onUpdatePart };
}

describe("the per-part fact row states what the exercise records (#3349)", () => {
  it.each([
    [
      "a fresh bilateral lift states its implement and holds the rest behind one affordance",
      part(),
      "Barbell",
      "Add a target or effort",
      ["part-fact-sides", "part-fact-intent", "part-fact-effort"],
    ],
    [
      "a declared target states itself and leaves only effort behind",
      part({ targetReps: "5" }),
      "Barbell",
      "Add effort",
      ["part-fact-sides", "part-fact-effort"],
    ],
    [
      "AMRAP states itself the same way",
      part({ toFailure: true }),
      "Barbell",
      "Add effort",
      ["part-fact-sides", "part-fact-effort"],
    ],
  ] as [string, PartEntry, string, string, string[]][])(
    "%s",
    (_name, p, gear, more, absentTestIds) => {
      renderList([p]);
      expect(screen.getByTestId("strength-equipment-chip").textContent).toBe(
        gear
      );
      expect(screen.getByTestId("part-fact-more").textContent).toBe(more);
      for (const id of absentTestIds)
        expect(screen.queryByTestId(id)).toBeNull();
    }
  );

  it("draws the panel's controls from what the part OFFERS, not from one condition", () => {
    renderList([part()]);
    fireEvent.click(screen.getByTestId("part-fact-more"));

    // A plain bilateral rep-based lift: no sides choice, but a target and the effort
    // opt-in. The old row asked one question for all three.
    expect(screen.queryByTestId("per-side-checkbox")).toBeNull();
    expect(screen.getByTestId("to-failure-checkbox")).toBeTruthy();
    expect(screen.getByTestId("rpe-tracking-checkbox")).toBeTruthy();
  });

  // #3367 THROUGH THE CONVERSION, and this is the case the whole clause exists for: a
  // lift whose NAME is not unilateral but whose loaded sets carried right-side values,
  // so `groupEditSets` marked it perSide. Sides is name-based and false, target is
  // perSide-based and false — and the effort opt-in must STILL be reachable. Before
  // #3367 the whole row had nowhere to appear; a conversion that folded the three
  // conditions back into one would put it back there, silently.
  it("keeps the effort opt-in reachable on a bilateral part marked perSide", () => {
    renderList([part({ perSide: true })]);
    fireEvent.click(screen.getByTestId("part-fact-more"));

    expect(screen.queryByTestId("per-side-checkbox")).toBeNull();
    expect(screen.queryByTestId("to-failure-checkbox")).toBeNull();
    expect(screen.getByTestId("rpe-tracking-checkbox")).toBeTruthy();
  });

  it("keeps ONE editor open across the whole form, not one per exercise", () => {
    renderList([part(), part({ name: "Hammer Curl" })]);
    const rows = screen.getAllByTestId("part-fact-row");
    expect(rows).toHaveLength(2);

    // Open the first part's options.
    fireEvent.click(screen.getAllByTestId("part-fact-more")[0]);
    expect(screen.getAllByTestId("part-options-editor")).toHaveLength(1);
    expect(screen.getAllByTestId("part-fact-row")).toHaveLength(1);

    // The SECOND part's affordance is the only one left; opening it must move the one
    // panel rather than add a second.
    fireEvent.click(screen.getByTestId("part-fact-more"));
    expect(screen.getAllByTestId("part-options-editor")).toHaveLength(1);
    expect(screen.getAllByTestId("part-fact-row")).toHaveLength(1);

    // …and it is the OTHER part's panel: a unilateral lift offers the sides control.
    expect(screen.getByTestId("per-side-checkbox")).toBeTruthy();
  });

  it("shares its one slot with the equipment editor, so opening options closes it", () => {
    renderList([part()]);
    fireEvent.click(screen.getByTestId("strength-equipment-chip"));
    expect(screen.getByTestId("strength-equipment-editor")).toBeTruthy();

    // The chip row is gone with it, so the options affordance is reached by closing
    // and reopening — which is the point: two panels are never on screen at once.
    fireEvent.click(screen.getByTestId("strength-equipment-done"));
    fireEvent.click(screen.getByTestId("part-fact-more"));
    expect(screen.getByTestId("part-options-editor")).toBeTruthy();
    expect(screen.queryByTestId("strength-equipment-editor")).toBeNull();
  });
});
