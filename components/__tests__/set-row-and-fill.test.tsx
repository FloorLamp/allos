import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import StrengthSets from "@/components/activity-form/StrengthSets";
import {
  useActivityParts,
  type SetFill,
} from "@/components/activity-form/useActivityParts";
import {
  blankPart,
  blankSet,
  type PartEntry,
  type RepeatSourceSet,
  type SetEntry,
} from "@/lib/activity-form-model";

// THE TWO SEAMS #5377 BUILT, and the shared load #5371 stated over them, at the tier
// where they are cheap to ask about.
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

// The real hook wired to the real card, so a tap on the grid is asked about in
// `parts` — the state `buildActivityPayload` composes the save from — rather than in
// a mocked callback's arguments.
let latest: PartEntry[] = [];
let latestFill: (fill: SetFill) => void = () => {};
function Harness({ initial }: { initial: PartEntry }) {
  const h = useActivityParts({
    seed: null,
    units,
    history: {},
    isEdit: false,
    equipmentList: [],
    isKnown: () => true,
    customFlags: () => ({}),
    defaultCustomType: null,
    onSetCheckedOff: () => {},
  });
  const { setParts } = h;
  useEffect(() => setParts([initial]), [initial, setParts]);
  // Published after each commit, so a test reads the state a tap produced rather
  // than a mocked callback's arguments.
  useEffect(() => {
    latest = h.parts;
    latestFill = (fill) => h.fillSets(0, fill);
  });
  return (
    <StrengthSets
      part={h.parts[0]}
      fault={null}
      units={units}
      isEdit={false}
      live={false}
      history={{}}
      deloadContext={{ isDeloadWeek: false, routineKeys: [] }}
      recoveringContext={{ temperedRegions: [], constraints: [] }}
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
      onUpdatePart={(patch) => h.updatePart(0, patch)}
      onUpdateSet={(si, patch) => h.updateSet(0, si, patch)}
      onAddSet={() => h.addSet(0)}
      onRemoveSet={(si) => h.removeSet(0, si)}
      onUpdatePartName={vi.fn()}
      onFill={(fill) => h.fillSets(0, fill)}
      onPlateTarget={vi.fn()}
    />
  );
}
const mountLive = (initial: PartEntry) => render(<Harness initial={initial} />);
const sets = (...loads: [string, string][]): SetEntry[] =>
  loads.map(([weight, reps]) => ({ ...blankSet(), weight, reps }));
const weights = () => latest[0].sets.map((s) => s.weight);
const byId = (id: string) => screen.getByTestId(id);
const rowOf = (label: string) =>
  // The L/R label renders in the exercise-level band AND in the set row (#5371);
  // the row is the one holding a reps stepper.
  screen
    .getAllByText(label, { selector: "span" })
    .map((el) => el.parentElement!)
    .find((row) => within(row).queryByLabelText("Add a rep"))!;
const bandOf = (label: string) =>
  screen
    .getAllByText(label, { selector: "span" })
    .map((el) => el.parentElement!)
    .find((row) => within(row).queryByPlaceholderText("kg"))!;

describe("SetRow's per-side field mapping (#5377)", () => {
  // The whole point of one row rendered twice: the SIDE says which SetEntry keys the
  // row reads and writes. Typing into R must never land on the left side's fields.
  // The load is typed in the exercise-level band while the sets share it (#5371),
  // where it writes every set's field for that side.
  it.each([
    ["L", "weight", "reps"],
    ["R", "weightRight", "repsRight"],
  ] as const)(
    "the %s row writes its own side's fields",
    (label, weightKey, repsKey) => {
      mountLive(part({ name: "Hammer Curl", perSide: true }));
      fireEvent.change(within(bandOf(label)).getByPlaceholderText("kg"), {
        target: { value: "20" },
      });
      fireEvent.click(within(rowOf(label)).getByLabelText("Add a rep"));
      expect(latest[0].sets[0]).toMatchObject({
        [weightKey]: "20",
        [repsKey]: "1",
      });
    }
  );
});

describe("the shared weight stepper (#5371)", () => {
  const bench = (...loads: [string, string][]) =>
    part({ sets: sets(...loads) });

  it("states one load above three reps-only rows, and steps every set", () => {
    mountLive(bench(["60", "8"], ["60", "8"], ["60", "8"]));
    expect(screen.getAllByLabelText("Increase weight")).toHaveLength(1);
    expect(screen.getAllByLabelText("Add a rep")).toHaveLength(3);
    // Set 1's weight ids sit on the band — it is where set 1's weight is entered.
    expect(
      within(byId("exercise-weight")).getByTestId("set1-weight")
    ).toHaveProperty("value", "60");
    expect(screen.queryByTestId("set2-weight")).toBeNull();
    fireEvent.click(screen.getByLabelText("Increase weight"));
    expect(weights()).toEqual(["62.5", "62.5", "62.5"]);
    fireEvent.change(byId("set1-weight"), { target: { value: "70" } });
    expect(weights()).toEqual(["70", "70", "70"]);
  });

  it("Vary expands to per-set weights, focuses that set's, and stays expanded", () => {
    mountLive(bench(["60", "8"], ["60", "8"], ["60", "8"]));
    fireEvent.click(byId("set-vary-2"));
    expect(screen.queryByTestId("exercise-weight")).toBeNull();
    expect(screen.getAllByLabelText("Increase weight")).toHaveLength(3);
    expect(document.activeElement).toBe(byId("set2-weight"));
    const row2 = byId("set-row-2");
    fireEvent.click(within(row2).getByLabelText("Increase weight"));
    expect(weights()).toEqual(["60", "62.5", "60"]);
    // Stepped back to match, the grid does not fold under the person's hands.
    fireEvent.click(within(row2).getByLabelText("Decrease weight"));
    expect(weights()).toEqual(["60", "60", "60"]);
    expect(screen.queryByTestId("exercise-weight")).toBeNull();
    expect(byId("set2-weight")).toHaveProperty("value", "60");
  });

  it("a mixed fill renders per-set weights from the start, and keeps them", () => {
    mountLive(part());
    act(() => {
      // The Recent fill path (#923) — `125 × 12, 120 × 10`.
      latestFill({
        source: "session",
        sets: [
          stored({ weight_kg: 125, reps: 12 }),
          stored({ set_number: 2, weight_kg: 120, reps: 10 }),
        ],
      });
    });
    expect(screen.queryByTestId("exercise-weight")).toBeNull();
    expect(byId("set1-weight")).toHaveProperty("value", "125");
    expect(byId("set2-weight")).toHaveProperty("value", "120");
    // Editing set 2 to match set 1 is a choice about set 2, not a request to fold.
    fireEvent.change(byId("set2-weight"), { target: { value: "125" } });
    expect(weights()).toEqual(["125", "125"]);
    expect(screen.queryByTestId("exercise-weight")).toBeNull();
  });

  // A per-side lift shares its load only while BOTH sides match across every set;
  // one side drifting on one set is enough to keep every set's weights on the row.
  it.each([
    ["matching", 2, { weightRight: "18" }],
    ["mismatched", 4, { weightRight: "16" }],
  ])(
    "per-side sets with %s sides render %i weight steppers",
    (_case, steppers, set2Right) => {
      const two = sets(["20", "10"], ["20", "10"]).map((s) => ({
        ...s,
        weightRight: "18",
        repsRight: "10",
      }));
      two[1] = { ...two[1], ...set2Right };
      mountLive(part({ name: "Hammer Curl", perSide: true, sets: two }));
      expect(screen.getAllByLabelText("Increase weight")).toHaveLength(
        steppers
      );
      expect(screen.getAllByLabelText("Add a rep")).toHaveLength(4);
    }
  );

  it("Enter moves weight → reps, and reps → the next set", () => {
    mountLive(bench(["60", "8"], ["65", "8"]));
    // Per-set weights (the loads differ): Enter lands in the SAME set's reps.
    fireEvent.keyDown(byId("set2-weight"), { key: "Enter" });
    expect(document.activeElement).toBe(byId("set2-reps"));
    // Enter in a complete reps field still adds the next set (#336).
    fireEvent.keyDown(byId("set2-reps"), { key: "Enter" });
    expect(latest[0].sets).toHaveLength(3);
  });

  it("Enter in the exercise-level weight lands in set 1's reps, per side", () => {
    mountLive(bench(["60", "8"], ["60", "8"]));
    fireEvent.keyDown(byId("set1-weight"), { key: "Enter" });
    expect(document.activeElement).toBe(byId("set1-reps"));
    cleanup();
    mountLive(part({ name: "Hammer Curl", perSide: true }));
    fireEvent.keyDown(within(bandOf("R")).getByPlaceholderText("kg"), {
      key: "Enter",
    });
    expect(document.activeElement).toBe(
      within(rowOf("R")).getByRole("spinbutton")
    );
  });

  // THE SAVED SHAPE IS UNCHANGED. Every set still carries its own weight, and a row's
  // patch — whether it came through a set row or the band — is the same SetEntry
  // fields it always was: no marker for "shared", nothing the payload builder could
  // pick up. Strict equality against the literal shape, so an added key fails.
  it.each([
    [
      "rows only",
      () => {
        fireEvent.click(byId("set-vary-1"));
        fireEvent.change(byId("set1-weight"), { target: { value: "60" } });
        fireEvent.change(byId("set1-reps"), { target: { value: "8" } });
        fireEvent.keyDown(byId("set1-reps"), { key: "Enter" });
        fireEvent.change(byId("set2-weight"), { target: { value: "65" } });
      },
    ],
    [
      "through the band",
      () => {
        fireEvent.change(byId("set1-weight"), { target: { value: "60" } });
        fireEvent.change(byId("set1-reps"), { target: { value: "8" } });
        fireEvent.keyDown(byId("set1-reps"), { key: "Enter" });
        fireEvent.click(byId("set-vary-2"));
        fireEvent.change(byId("set2-weight"), { target: { value: "65" } });
      },
    ],
  ])("the sets a form saves are the same shape entered %s", (_how, drive) => {
    mountLive(part());
    drive();
    expect(latest[0].sets).toStrictEqual([
      { ...blankSet(), weight: "60", reps: "8" },
      { ...blankSet(), weight: "65", reps: "8" },
    ]);
  });

  it("the plate builder lands on every set from the band, one set from a row", () => {
    const { result } = setUp();
    act(() => result.current.setParts([bench(["60", "8"], ["60", "8"])]));
    act(() =>
      result.current.setPlateTarget({ pi: 0, si: "all", field: "weight" })
    );
    act(() => result.current.applyPlateBuild(100, null));
    expect(result.current.parts[0].sets.map((s) => s.weight)).toEqual([
      "100",
      "100",
    ]);
    act(() => result.current.setPlateTarget({ pi: 0, si: 1, field: "weight" }));
    act(() => result.current.applyPlateBuild(80, null));
    expect(result.current.parts[0].sets.map((s) => s.weight)).toEqual([
      "100",
      "80",
    ]);
  });
});
