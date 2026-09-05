import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import StrengthSets from "@/components/activity-form/StrengthSets";
import { useActivityParts } from "@/components/activity-form/useActivityParts";
import {
  blankPart,
  type PartEntry,
  type RepeatSourceSet,
} from "@/lib/activity-form-model";

// THE TWO SEAMS #5377 BUILT, at the tier where they are cheap to ask about.
//
// Neither had a test of any kind before this file: the strength editor's fill paths
// and its per-side rows were reached only through e2e, which drives the LEFT side and
// the bilateral row and never asks a right-side input which field it writes. So the
// row's field mapping and the fill's landing rule are pinned here, where a wrong
// answer is one assertion rather than a browser.
vi.mock("@/app/(app)/training/actions", () => ({
  dismissTrainingObservation: vi.fn(),
}));

const units = {
  weightUnit: "kg",
  distanceUnit: "km",
  temperatureUnit: "F",
} as const;

const setUp = () =>
  renderHook(() =>
    useActivityParts({
      seed: null,
      units,
      history: {},
      isEdit: false,
      equipmentList: [],
      isKnown: () => true,
      customFlags: () => ({}),
      defaultCustomType: null,
      onSetCheckedOff: () => {},
    })
  );

const part = (over: Partial<PartEntry> = {}): PartEntry => ({
  ...blankPart(),
  name: "Barbell Bench Press",
  ...over,
});

// A stored set as every fill path states one — canonical kilograms in, display units
// out, which is the mapping the two paths now share.
const stored = (over: Partial<RepeatSourceSet> = {}): RepeatSourceSet => ({
  set_number: 1,
  weight_kg: 60,
  reps: 8,
  weight_kg_right: null,
  reps_right: null,
  duration_sec: null,
  duration_sec_right: null,
  warmup: null,
  ...over,
});

describe("fillSets (#5377)", () => {
  it("lands a coached set on the untouched last row, then as a new set", () => {
    const { result } = setUp();
    act(() => result.current.setParts([part()]));
    act(() =>
      result.current.fillSets(0, {
        source: "coached",
        set: stored(),
        targetReps: null,
      })
    );
    // Set 1 was blank, so the suggestion filled it rather than adding a second row.
    expect(result.current.parts[0].sets).toHaveLength(1);
    expect(result.current.parts[0].sets[0]).toMatchObject({
      weight: "60",
      reps: "8",
    });
    // Set 1 now counts, so the next Use arrives as its own set instead of
    // overwriting work in progress.
    act(() =>
      result.current.fillSets(0, {
        source: "coached",
        set: stored({ weight_kg: 62.5 }),
        targetReps: null,
      })
    );
    expect(result.current.parts[0].sets.map((s) => s.weight)).toEqual([
      "60",
      "62.5",
    ]);
  });

  it("leaves the landing row's warmup flag and RPE to the person", () => {
    const { result } = setUp();
    act(() => result.current.setParts([part()]));
    act(() => result.current.updateSet(0, 0, { warmup: true, rpe: 8 }));
    act(() =>
      result.current.fillSets(0, {
        source: "coached",
        set: stored(),
        targetReps: null,
      })
    );
    expect(result.current.parts[0].sets[0]).toMatchObject({
      weight: "60",
      warmup: true,
      rpe: 8,
    });
  });

  it("adopts a declared rep target only when the exercise has none", () => {
    const { result } = setUp();
    act(() => result.current.setParts([part()]));
    act(() =>
      result.current.fillSets(0, {
        source: "coached",
        set: stored(),
        targetReps: 5,
      })
    );
    expect(result.current.parts[0].targetReps).toBe("5");
    act(() => result.current.setParts([part({ targetReps: "3" })]));
    act(() =>
      result.current.fillSets(0, {
        source: "coached",
        set: stored(),
        targetReps: 5,
      })
    );
    expect(result.current.parts[0].targetReps).toBe("3");
  });

  it("keeps side-tracking on a coached fill and follows the source on a repeat", () => {
    const { result } = setUp();
    act(() => result.current.setParts([part({ perSide: true })]));
    // Only the left side has history to progress from (#335). Filling it must not
    // un-track the right side the person is still logging.
    act(() =>
      result.current.fillSets(0, {
        source: "coached",
        set: stored(),
        targetReps: null,
      })
    );
    expect(result.current.parts[0].perSide).toBe(true);
    // A repeat of a bilateral session tracks sides exactly as that session was
    // logged, and replaces the pristine part's sets outright (#923).
    act(() =>
      result.current.fillSets(0, {
        source: "session",
        sets: [stored(), stored({ set_number: 2, weight_kg: 65 })],
      })
    );
    expect(result.current.parts[0].perSide).toBe(false);
    expect(result.current.parts[0].sets.map((s) => s.weight)).toEqual([
      "60",
      "65",
    ]);
  });
});

describe("SetRow's per-side field mapping (#5377)", () => {
  const onUpdateSet = vi.fn();
  const mount = () =>
    render(
      <StrengthSets
        part={part({ name: "Hammer Curl", perSide: true })}
        fault={null}
        units={units}
        isEdit={false}
        live={false}
        history={{}}
        deloadContext={{ isDeloadWeek: false, routineKeys: [] }}
        recoveringContext={{ constraints: [] }}
        plateauHints={[]}
        rpeTracking={null}
        currentActivityId={null}
        editedDate={null}
        equipmentList={[]}
        showBodyweightPrompt={false}
        bwInput=""
        bwSaving={false}
        onBwInput={vi.fn()}
        onSaveBodyweight={vi.fn()}
        onUpdatePart={vi.fn()}
        onUpdateSet={onUpdateSet}
        onAddSet={vi.fn()}
        onRemoveSet={vi.fn()}
        onUpdatePartName={vi.fn()}
        onFill={vi.fn()}
        onPlateTarget={vi.fn()}
      />
    );

  // The whole point of one row rendered twice: the SIDE says which SetEntry keys the
  // row reads and writes. Typing into R must never land on the left side's fields.
  it.each([
    ["L", { weight: "20" }, { reps: "1" }],
    ["R", { weightRight: "20" }, { repsRight: "1" }],
  ])(
    "the %s row writes its own side's fields",
    (label, weightPatch, repsPatch) => {
      onUpdateSet.mockClear();
      mount();
      const row = screen.getByText(label, { selector: "span" }).parentElement!;
      fireEvent.change(within(row).getByPlaceholderText("kg"), {
        target: { value: "20" },
      });
      expect(onUpdateSet).toHaveBeenLastCalledWith(0, weightPatch);
      fireEvent.click(within(row).getByLabelText("Add a rep"));
      expect(onUpdateSet).toHaveBeenLastCalledWith(0, repsPatch);
    }
  );
});
