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
  asPlan,
  blankPart,
  blankSet,
  confirmSet,
  doneSets,
  savedShapeOfParts,
  setDone,
  partTotal,
  type PartEntry,
  type RepeatSourceSet,
  type SetEntry,
} from "@/lib/activity-form-model";
import {
  buildActivityPayload,
  makeNameClassifier,
} from "@/lib/activity-form-validate";
import { recapSessionFromPayload, sessionRecap } from "@/lib/session-recap";
import { exerciseHistoryKey } from "@/lib/lifts";
import type { ExerciseHistoryMap } from "@/lib/queries";

// The picker vocabulary the payload builder resolves a part's type through.
const classifier = makeNameClassifier(
  new Map([["barbell bench press", "strength" as const]])
);

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

const setUp = (onSetCheckedOff: () => void = () => {}) =>
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
      onSetCheckedOff,
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
  it("lands a coached set on the next unconfirmed row, then as a new set", () => {
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
    // A repeat states that session as this session's PLAN (#5373), so its loads land
    // in the offer rather than in the fields.
    expect(result.current.parts[0].sets.map((s) => s.plan?.weight)).toEqual([
      "60",
      "65",
    ]);
  });
});

// CHECKING A SET OFF IS CONFIRMING IT (#340/#5373). The parent starts the live rest
// timer and its haptic off this one callback, and it must fire once per set however
// the person confirmed — so the count is what these cases assert, not the flag.
describe("the check-off gesture (#5373)", () => {
  const planned = asPlan({ ...blankSet(), weight: "60", reps: "8" });
  const confirmRow = (h: ReturnType<typeof setUp>) =>
    confirmSet(h.result.current.parts[0].sets[0]);
  const run = (drive: (h: ReturnType<typeof setUp>) => void) => {
    const checkedOff = vi.fn();
    const h = setUp(checkedOff);
    act(() => h.result.current.setParts([part({ sets: [planned, planned] })]));
    drive(h);
    return checkedOff.mock.calls.length;
  };

  it.each([
    [
      "a confirm",
      (h: ReturnType<typeof setUp>) =>
        h.result.current.updateSet(0, 0, confirmRow(h)),
    ],
    [
      "a correction",
      (h: ReturnType<typeof setUp>) =>
        h.result.current.updateSet(0, 0, { ...confirmRow(h), reps: "6" }),
    ],
  ])(
    "%s checks the set off exactly once, and only the first time",
    (_how, drive) => {
      expect(
        run((h) => {
          act(() => drive(h));
          act(() => drive(h));
        })
      ).toBe(1);
    }
  );

  it.each([
    [
      "the exercise-level load",
      (h: ReturnType<typeof setUp>) =>
        h.result.current.updateSet(0, "all", { weight: "65" }),
    ],
    [
      "a warmup toggle",
      (h: ReturnType<typeof setUp>) =>
        h.result.current.updateSet(0, 0, { warmup: true }),
    ],
    // Adding a row used to BE the check-off, which fired whether or not the previous
    // set had happened; confirming is the explicit gesture now.
    [
      "adding a set",
      (h: ReturnType<typeof setUp>) => h.result.current.addSet(0),
    ],
  ])("%s does not", (_how, drive) => {
    expect(run((h) => act(() => drive(h)))).toBe(0);
  });
});

// The real hook wired to the real card, so a tap on the grid is asked about in
// `parts` — the state `buildActivityPayload` composes the save from — rather than in
// a mocked callback's arguments.
let latest: PartEntry[] = [];
let latestFill: (fill: SetFill) => void = () => {};
let live: ReturnType<typeof useActivityParts>;
function Harness({
  initial,
  history = {},
}: {
  initial: PartEntry[];
  // The shipped per-exercise history the coached suggestion — and, with it, the plan
  // the grid opens as (#5373) — is built from. Empty means an exercise with no past.
  history?: ExerciseHistoryMap;
}) {
  const h = useActivityParts({
    seed: null,
    units,
    history,
    isEdit: false,
    equipmentList: [],
    isKnown: () => true,
    customFlags: () => ({}),
    defaultCustomType: null,
    onSetCheckedOff: () => {},
  });
  const { setParts } = h;
  useEffect(() => setParts(initial), [initial, setParts]);
  // Published after each commit, so a test reads the state a tap produced rather
  // than a mocked callback's arguments.
  useEffect(() => {
    live = h;
    latest = h.parts;
    latestFill = (fill) => h.fillSets(0, fill);
  });
  // Keyed by INDEX, as ActivityPartsList mounts the editors: whatever a part's
  // editor holds in its own state belongs to the slot, not the exercise.
  return h.parts.map((p, pi) => (
    <div key={pi} data-testid="activity-part">
      <StrengthSets
        part={p}
        fault={null}
        units={units}
        isEdit={false}
        live={false}
        history={history}
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
        onUpdatePart={(patch) => h.updatePart(pi, patch)}
        onUpdateSet={(si, patch) => h.updateSet(pi, si, patch)}
        onAddSet={() => h.addSet(pi)}
        onRemoveSet={(si) => h.removeSet(pi, si)}
        onUpdatePartName={vi.fn()}
        onFill={(fill) => h.fillSets(pi, fill)}
        onPlateTarget={vi.fn()}
      />
    </div>
  ));
}
const mountLive = (...initial: PartEntry[]) =>
  render(<Harness initial={initial} />);
// Sets the person RECORDED — no plan, so the rows show their values rather than the
// ghost placeholders a plan renders (#5373). The plan's own cases build their rows
// without it.
const sets = (...loads: [string, string][]): SetEntry[] =>
  loads.map(([weight, reps]) => ({ ...blankSet(), weight, reps, plan: null }));
const weights = () => latest[0].sets.map((s) => s.weight);
// What each row STATES: what was typed into it, else what it still offers (#5373).
const shownLoads = () =>
  latest[0].sets.map((s) => s.weight || s.plan?.weight || "");
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
        // Correcting a row's reps IS confirming it (#5373).
        plan: null,
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

  // The latch is the PART's, not its slot's. ActivityPartsList keys each editor by
  // index, so a latch held in the editor's own state stays in slot 0 when the
  // exercise there is removed or moved — and the next exercise, three straight sets
  // at one load, would unfold into per-set weights with nothing typed.
  it.each([
    ["removed", () => live.removePart(0), [1]],
    ["moved below it", () => live.movePart(0, 1), [1, 2]],
  ])(
    "part 2 keeps its one band after a varied part 1 is %s",
    (_how, shuffle, weightSteppersPerSlot) => {
      // Part 2's last set is still open: a finished uniform run arrives folded into
      // its summary, which is a different fold from the one asked about here.
      mountLive(
        bench(["60", "8"], ["60", "8"]),
        part({ name: "Barbell Squat", sets: sets(["100", "5"], ["100", ""]) })
      );
      const slots = () => screen.getAllByTestId("activity-part");
      fireEvent.click(within(slots()[0]).getByTestId("set-vary-2"));
      expect(within(slots()[1]).getByTestId("exercise-weight")).toBeTruthy();
      act(shuffle);
      expect(within(slots()[0]).getByTestId("exercise-weight")).toBeTruthy();
      expect(
        slots().map(
          (el) => within(el).getAllByLabelText("Increase weight").length
        )
      ).toEqual(weightSteppersPerSlot);
    }
  );

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
    // A repeat states this session's PLAN, so the loads arrive as ghosts (#5373):
    // painted in the placeholder, with nothing written into the field.
    expect(byId("set1-weight")).toHaveProperty("value", "");
    expect(byId("set1-weight")).toHaveProperty("placeholder", "125");
    expect(byId("set2-weight")).toHaveProperty("placeholder", "120");
    // Editing set 2 to match set 1 is a choice about set 2, not a request to fold.
    fireEvent.change(byId("set2-weight"), { target: { value: "125" } });
    // Set 2 is now a record at 125; set 1 is still the plan's 125, so the two match
    // and the grid STILL does not fold — the latch is what refuses, as it must.
    expect(latest[0].sets.map(setDone)).toEqual([false, true]);
    expect(shownLoads()).toEqual(["125", "125"]);
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
      { ...blankSet(), weight: "60", reps: "8", plan: null },
      { ...blankSet(), weight: "65", reps: "8", plan: null },
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

// EVERY SET ARRIVES AS A PLAN, AND ONLY A CONFIRMED SET IS A RECORD (#5373).
//
// The owner's constraint is that they intend the whole prescription and in practice
// fulfil one or two of its three rows, so a prefill that writes the plan as the record
// lies on exactly those days. These cases ask the two questions that follow from it —
// what the grid SHOWS before anything is lifted, and what the payload CARRIES after —
// at the tier where a wrong answer is one assertion.
describe("sets arrive as a plan (#5373)", () => {
  const bench = "Barbell Bench Press";
  // A prior session of three straight sets: the plan's source, and its LENGTH. The
  // suggestion progresses the load; the row count is this session's own working rows.
  const history = (
    over: Partial<ExerciseHistoryMap[string]["sessions"][number]> = {},
    bodyweight = false
  ): ExerciseHistoryMap => ({
    [exerciseHistoryKey(bench)]: {
      bodyweight,
      sessions: [
        {
          date: "2026-09-01",
          exercise: bench,
          activityId: 41,
          equipment: null,
          equipmentId: null,
          baseKg: 0,
          status: null,
          sets: [1, 2, 3].map((n) => ({
            set_number: n,
            weight_kg: 60,
            reps: 8,
            weight_kg_right: null,
            reps_right: null,
            duration_sec: null,
            duration_sec_right: null,
            target_reps: null,
            to_failure: null,
            warmup: null,
            rpe: null,
          })),
          ...over,
        },
      ],
    },
  });

  const mountPlanned = (hist = history(), over: Partial<PartEntry> = {}) =>
    render(
      <Harness initial={[part({ name: bench, ...over })]} history={hist} />
    );
  const rows = () => latest[0].sets;
  const shown = (id: string) => {
    const el = byId(id) as HTMLInputElement;
    return { value: el.value, ghost: el.placeholder };
  };
  // What the save would carry, through the ONE builder the form composes it with.
  const payload = () =>
    buildActivityPayload(
      classifier,
      latest.filter((p) => p.name.trim())
    ).flat;

  it("opens a pristine part as one ghost row per planned set, and saves none of them", () => {
    mountPlanned();
    expect(rows()).toHaveLength(3);
    expect(rows().some(setDone)).toBe(false);
    // The load is stated once, above reps-only rows (#5371) — and it is a ghost too,
    // because no set of this exercise is a record yet.
    expect(shown("set1-weight")).toEqual({ value: "", ghost: "62.5" });
    // The load progresses and the reps come back to the scheme's floor — the SAME
    // coached suggestion the one-set ghost showed, now stated for every planned row.
    expect(shown("set2-reps")).toEqual({ value: "", ghost: "5" });
    expect(payload()).toEqual([]);
    // Nothing to add to, and no sentence to state: both read the record.
    expect(screen.getByText("+ Add set")).toHaveProperty("disabled", true);
    expect(screen.queryByTestId("set-summary")).toBeNull();
  });

  // The two gestures that turn a plan into a record, and they are ONE gesture: the
  // control says "this happened as planned", a correction says "this happened, but".
  it.each([
    [
      "confirming row 1",
      () => fireEvent.click(byId("set-confirm-1")),
      0,
      { weight: "62.5", reps: "5" },
    ],
    [
      "stepping row 2's reps down twice",
      () => {
        const dec = within(byId("set-row-2")).getByLabelText("Decrease reps");
        fireEvent.click(dec);
        fireEvent.click(dec);
      },
      1,
      { weight: "62.5", reps: "3" },
    ],
    [
      "typing row 3's reps",
      () => fireEvent.change(byId("set3-reps"), { target: { value: "5" } }),
      2,
      { weight: "62.5", reps: "5" },
    ],
  ])(
    "%s writes the ghost's values and marks that set done",
    (_how, drive, si, expected) => {
      mountPlanned();
      drive();
      expect(rows()[si]).toMatchObject({ ...expected, plan: null });
      // The other two rows are still the plan, and the payload is the one done set.
      expect(rows().filter(setDone)).toHaveLength(1);
      expect(payload()).toHaveLength(1);
      expect(payload()[0]).toMatchObject({
        exercise: bench,
        weight: Number(expected.weight),
        reps: Number(expected.reps),
      });
      // A confirmed row has nothing left to confirm.
      expect(screen.queryByTestId(`set-confirm-${si + 1}`)).toBeNull();
    }
  );

  it("finishes a three-set plan as two sets, and states the plan it was worked against", () => {
    mountPlanned();
    fireEvent.click(byId("set-confirm-1"));
    fireEvent.click(within(byId("set-row-2")).getByLabelText("Decrease reps"));
    expect(payload().map((s) => s.reps)).toEqual([5, 4]);
    // The recap the finish step renders reads the same two numbers: what was done,
    // against what was planned. Computed at finish; never stored.
    const recap = sessionRecap(
      recapSessionFromPayload(
        payload(),
        { title: "", durationMin: null, intensity: null, bodyweightKg: 0 },
        "kg",
        { [bench]: latest[0].sets.length }
      ),
      {}
    );
    expect(recap.exercises[0]).toMatchObject({
      workingSets: 2,
      plannedSets: 3,
    });
  });

  it("a part with no history keeps its one empty row, and typing confirms it", () => {
    mountPlanned({});
    expect(rows()).toHaveLength(1);
    expect(setDone(rows()[0])).toBe(false);
    fireEvent.change(byId("set1-weight"), { target: { value: "40" } });
    fireEvent.change(byId("set1-reps"), { target: { value: "10" } });
    expect(rows()[0]).toMatchObject({ weight: "40", reps: "10", plan: null });
    // Now there IS a record to add to, and a further set is a ghost copied from it.
    fireEvent.click(screen.getByText("+ Add set"));
    expect(rows()[1]).toMatchObject({
      weight: "",
      plan: { weight: "40", reps: "10" },
    });
    expect(payload()).toHaveLength(1);
  });

  it("a per-side part ghosts both sides per row, and a confirm writes both", () => {
    mountPlanned(
      history({
        sets: [1, 2].map((n) => ({
          set_number: n,
          weight_kg: 20,
          reps: 10,
          weight_kg_right: 18,
          reps_right: 10,
          duration_sec: null,
          duration_sec_right: null,
          target_reps: null,
          to_failure: null,
          warmup: null,
          rpe: null,
        })),
      }),
      { perSide: true }
    );
    expect(rows()).toHaveLength(2);
    expect(rows()[0].plan).toMatchObject({
      weight: "22.5",
      weightRight: "20.5",
      reps: "5",
      repsRight: "5",
    });
    fireEvent.click(byId("set-confirm-1"));
    expect(setDone(rows()[0])).toBe(true);
    // ONE flag for the row, so both sides became a record together.
    expect(payload()[0]).toMatchObject({ weight: 22.5, weightRight: 20.5 });
  });

  it("an edit opens every stored set done, and offers no ghost", () => {
    render(
      <Harness
        initial={[part({ name: bench, sets: sets(["60", "8"], ["60", "7"]) })]}
        history={history()}
      />
    );
    expect(rows().every(setDone)).toBe(true);
    expect(screen.queryByTestId("set-confirm-1")).toBeNull();
    expect(shown("set1-weight").value).toBe("60");
    expect(payload()).toHaveLength(2);
  });
});

// THE PAYLOAD RULE, ASKED OF THE BUILDER ITSELF: a ghost that was never confirmed
// must not reach the save, however complete its fields look.
//
// THE FIXTURE FORGES THE FORBIDDEN STATE ON PURPOSE, and this is the whole reason the
// case can fail. The model as built never mints it — `asPlan` moves the numbers OUT of
// the fields, so an ordinary ghost has nothing for the payload to pick up and a fixture
// made of one would go green with the filter deleted. This row carries a plan AND the
// fields, which is what a `done: boolean` beside untouched values would have looked
// like, and it is what the `doneSets` filter is there to refuse.
describe("only a confirmed set reaches the payload (#5373)", () => {
  const named = (over: Partial<PartEntry>) =>
    buildActivityPayload(classifier, [
      { ...blankPart(), name: "Barbell Bench Press", ...over },
    ]).flat;
  const record = { ...blankSet(), weight: "60", reps: "8", plan: null };
  const planned = { ...record, plan: { ...record } };

  it.each([
    ["every row planned", [planned, planned, planned], 0],
    ["one confirmed", [record, planned, planned], 1],
    ["all confirmed", [record, record, record], 3],
  ])("%s: only the confirmed rows are saved", (_case, rows, saved) => {
    expect(named({ sets: rows })).toHaveLength(saved);
  });

  // The judgement reads the same filter: a plan cannot miss a target it was never
  // measured against, and the volume total counts what was lifted.
  // And an ordinary ghost — the shape the grid actually builds — carries nothing for a
  // payload to find in the first place, which is the structural half of the same rule.
  it("an ordinary ghost has no values to save at all", () => {
    const ghost = asPlan(record);
    expect(ghost.weight).toBe("");
    expect(ghost.plan).toMatchObject({ weight: "60", reps: "8" });
    expect(named({ sets: [ghost, ghost] })).toEqual([]);
  });

  it("judges and totals the record, not the plan", () => {
    const p = {
      ...blankPart(),
      name: "Barbell Bench Press",
      targetReps: "8",
      sets: [{ ...record, reps: "6" }, planned, planned],
    };
    expect(doneSets(p)).toHaveLength(1);
    expect(partTotal(p)).toBe(360);
    expect(partTotal({ ...p, sets: [planned, planned, planned] })).toBe(0);
  });
});

// #5442 — A CONTROL THAT CHANGES NO DATA MUST NOT COUNT AS A CHANGE.
//
// `varied` (#5371) and a set's `plan` (#5373) decide how the grid RENDERS; neither can
// be expressed by `buildActivityPayload`. Left in the auto-save signature they make an
// unsaved change out of a tap that changes nothing, and the update path then rewrites
// `updated_at` and — on a row an integration owns — sets `edited = 1` permanently, so a
// re-ingest stops correcting it. Being out of the PAYLOAD is not being out of what
// counts as a CHANGE.
//
// Driven through the real controls, as the audit's probe was: the shaped object is
// exactly where the bug hides, so reading it instead of the grid proves nothing.
describe("presentational state is not an unsaved change (#5442)", () => {
  // The two quantities the defect separated: what the auto-save would call a change,
  // and what it would actually send. Every case below asserts them TOGETHER, because
  // the bug is one moving without the other.
  const sig = () => JSON.stringify(savedShapeOfParts(latest));
  const sent = () =>
    JSON.stringify(
      buildActivityPayload(
        classifier,
        latest.filter((p) => p.name.trim())
      ).flat
    );

  it("tapping Vary re-renders the grid and moves neither", () => {
    mountLive(
      part({
        name: "Barbell Bench Press",
        sets: sets(["60", "8"], ["60", "8"]),
      })
    );
    const before = { sig: sig(), sent: sent() };
    fireEvent.click(byId("set-vary-2"));
    // The tap DID something — without this the case passes on a dead button.
    expect(latest[0].varied).toBe(true);
    expect(screen.queryByTestId("exercise-weight")).toBeNull();
    expect({ sig: sig(), sent: sent() }).toEqual(before);
  });

  it("a plan the person has not confirmed is not a change either", () => {
    const planned = asPlan({ ...blankSet(), weight: "62.5", reps: "5" });
    mountLive(
      part({ name: "Barbell Bench Press", sets: [planned, planned, planned] })
    );
    // Three rows of prescription, and nothing in either quantity that says so.
    expect(screen.getAllByTestId(/^set-confirm-\d+$/)).toHaveLength(3);
    expect(sig()).not.toContain("62.5");
    expect(sent()).toBe("[]");

    // Confirming one IS data, so both move together — which is what makes the two
    // assertions above a claim about presentation rather than about nothing happening.
    const before = { sig: sig(), sent: sent() };
    fireEvent.click(byId("set-confirm-1"));
    expect(sig()).toContain("62.5");
    expect(sig()).not.toBe(before.sig);
    expect(sent()).not.toBe(before.sent);
  });
});
