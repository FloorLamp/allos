import { render } from "@testing-library/react";
import { vi } from "vitest";
import ActivityPartsList from "@/components/activity-form/ActivityPartsList";
import type { PartEntry } from "@/lib/activity-form-model";

// The ActivityPartsList mount, once. Two files in this tier render the whole parts
// list — the per-part fact row (#3349) and the settled exercise heading (#5370) — and
// the list takes thirty-odd props that neither is about. Kept out of a `*.test.tsx`
// name so the runner does not collect it as a suite of its own.

export function part(over: Partial<PartEntry> = {}): PartEntry {
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
    varied: false,
    ...over,
  };
}

export function renderList(
  parts: PartEntry[],
  over: Record<string, unknown> = {}
) {
  const onUpdatePart = vi.fn();
  const list = (
    currentParts: PartEntry[],
    currentOver: Record<string, unknown> = over
  ) => (
    <ActivityPartsList
      parts={currentParts}
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
      onFill={vi.fn()}
      onPlateTarget={vi.fn()}
      {...currentOver}
    />
  );
  const view = render(list(parts));
  return {
    onUpdatePart,
    rerenderParts: (next: PartEntry[]) => view.rerender(list(next)),
  };
}
