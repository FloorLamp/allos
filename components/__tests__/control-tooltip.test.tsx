import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ControlTooltip from "@/components/ControlTooltip";
import ActivityPartsList from "@/components/activity-form/ActivityPartsList";
import RestTimer from "@/components/activity-form/RestTimer";
import type { PartEntry, SetEntry } from "@/lib/activity-form-model";
// A test may mint a tracking directly — it asserts on the scale, not on who gets
// one (lib/__tests__/rpe-opt-in.test.ts says so, and excludes tests from its census).
import { mintRpeTracking } from "@/lib/rpe";

// THE CONTROL TOOLTIP (#4511), at the tier that can read the accessibility tree.
//
// The claim worth pinning is not "a tooltip appears". It is that THE TOOLTIP'S TEXT
// AND THE CONTROL'S ACCESSIBLE NAME ARE ONE STRING — so every assertion below
// compares two live reads of the rendered DOM (`aria-label` against the tooltip's
// text) rather than either one against a literal. A test that checked both against
// the same constant would stay green on the day they drift apart from each other.
//
// WHERE the tooltip lands is not asked here: jsdom reports every rect as zero, so a
// geometric answer at this tier would be a number nobody measured. The placement
// decision is pure and lives in lib/__tests__/anchored-position.test.ts.

vi.mock("@/app/(app)/training/activity-actions", () => ({
  setRpeTrackingAction: vi.fn(async () => ({ tracking: null })),
}));
vi.mock("@/app/(app)/training/actions", () => ({
  dismissTrainingObservation: vi.fn(),
}));
vi.mock("@/components/ActivityEditorProvider", () => ({
  useActivityEditor: () => ({ leaveFor: vi.fn() }),
}));

// The parts list carries the RPE info affordance, whose anchored popover observes
// the document on mount. jsdom ships no ResizeObserver.
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

const tooltip = () => screen.queryByRole("tooltip");

/** Reach a control the way a keyboard does: focus with no pointer before it. */
function tabTo(element: HTMLElement) {
  act(() => {
    element.focus();
  });
}

/** Reach it the way a finger does: the pointer that will activate it lands first. */
function tapTo(element: HTMLElement) {
  fireEvent.pointerDown(element, { pointerType: "touch" });
  act(() => {
    element.focus();
  });
}

/** The one thing every assertion here is about: the two strings are one string. */
function expectNamesItself(control: HTMLElement) {
  const name = control.getAttribute("aria-label");
  expect(name, "the control has no aria-label to reveal").toBeTruthy();
  const panel = tooltip();
  expect(panel, `no tooltip for "${name}"`).not.toBeNull();
  expect(panel?.textContent).toBe(name);
  // And the reveal is WIRED to the control, not merely present beside it.
  expect(control.getAttribute("aria-describedby")).toBe(panel?.id);
}

function Subject({ label = "Mark warmup set" }: { label?: string }) {
  return (
    <ControlTooltip label={label}>
      {(anchor) => (
        <button {...anchor} type="button" data-testid="subject">
          W
        </button>
      )}
    </ControlTooltip>
  );
}

describe("a glyph control reveals its own accessible name (#4511)", () => {
  // The four gestures, and the two that must NOT reveal are the point: a touch tap
  // ACTIVATES a control, so answering it with a label is the opposite of an answer.
  it.each([
    [
      "a mouse hover",
      (b: HTMLElement) => fireEvent.pointerEnter(b, { pointerType: "mouse" }),
      true,
    ],
    [
      "a touch tap",
      (b: HTMLElement) => fireEvent.pointerEnter(b, { pointerType: "touch" }),
      false,
    ],
    [
      "a pen hover",
      (b: HTMLElement) => fireEvent.pointerEnter(b, { pointerType: "pen" }),
      false,
    ],
    // A real `.focus()`, not a synthetic focus event: `:focus-visible` is a state
    // of the document, so a dispatched event with nothing focused cannot show it.
    ["keyboard focus", tabTo, true],
  ])("%s: reveals = %s", (_gesture, act, reveals) => {
    render(<Subject />);
    const button = screen.getByTestId("subject");
    expect(tooltip()).toBeNull();
    act(button);
    if (reveals) expectNamesItself(button);
    else expect(tooltip()).toBeNull();
  });

  it("stays away when a tap focuses the control on its way to activating it", () => {
    // The half a hover test cannot see. A tap focuses the button, so "reveal on
    // focus" alone would put a label over the control the finger just pressed.
    render(<Subject />);
    tapTo(screen.getByTestId("subject"));
    expect(tooltip()).toBeNull();
  });

  it("takes the tooltip away when the pointer leaves", () => {
    render(<Subject />);
    const button = screen.getByTestId("subject");
    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    expectNamesItself(button);
    fireEvent.pointerLeave(button);
    expect(tooltip()).toBeNull();
    expect(button.getAttribute("aria-describedby")).toBeNull();
  });

  it("takes the tooltip away when focus leaves", () => {
    render(<Subject />);
    const button = screen.getByTestId("subject");
    tabTo(button);
    expectNamesItself(button);
    fireEvent.blur(button);
    expect(tooltip()).toBeNull();
    expect(button.getAttribute("aria-describedby")).toBeNull();
  });

  it("follows the label when the control's state renames it", () => {
    // The W is `Mark warmup set` until it is pressed and `Unmark warmup set`
    // afterwards. One string means the tooltip cannot keep the old one.
    const view = render(<Subject label="Mark warmup set" />);
    const button = screen.getByTestId("subject");
    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    expectNamesItself(button);
    view.rerender(<Subject label="Unmark warmup set" />);
    expect(tooltip()?.textContent).toBe("Unmark warmup set");
    expectNamesItself(button);
  });

  it("adds no tap target: the tooltip cannot be hit", () => {
    // #3970 budgets a row's affordances in TAP TARGETS. A tooltip that took hits
    // would be a new one, on every adopting control at once.
    render(<Subject />);
    fireEvent.pointerEnter(screen.getByTestId("subject"), {
      pointerType: "mouse",
    });
    expect(tooltip()?.className).toContain("pointer-events-none");
  });

  it("rides the declared motion, and gives a reduced-motion viewer the state alone", () => {
    render(<Subject />);
    fireEvent.pointerEnter(screen.getByTestId("subject"), {
      pointerType: "mouse",
    });
    // The vocabulary's own class, not a hand-rolled transition (#2654).
    expect(tooltip()?.className).toContain("motion-promote");

    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    render(<Subject label="Remove set" />);
    const [, reduced] = screen.getAllByRole("button");
    fireEvent.pointerEnter(reduced, { pointerType: "mouse" });
    const panels = screen.getAllByRole("tooltip");
    const quiet = panels[panels.length - 1];
    expect(quiet.textContent).toBe("Remove set");
    expect(quiet.className).not.toContain("motion-");
  });
});

// ── The activity form's census ───────────────────────────────────────────────

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

// THREE conditions the form imposes, all of them load-bearing for this fixture:
// `parts.length > 1` gates the reorder/remove toolbar, `p.sets.length > 1` gates the
// per-set remove, and a part whose sets form a UNIFORM run arrives collapsed behind
// its own sentence with no grid at all — so the two sets differ, or none of the
// per-set controls below would exist to hover.
function renderForm() {
  const set: SetEntry = {
    weight: "60",
    reps: "5",
    weightRight: "",
    repsRight: "",
    duration: "",
    durationRight: "",
    warmup: false,
    rpe: null,
  };
  return render(
    <ActivityPartsList
      parts={[
        part({ sets: [set, { ...set, reps: "6" }] }),
        part({ name: "Back Squat", sets: [] }),
      ]}
      stickyFooter={false}
      isEdit={false}
      live={false}
      units={{ weightUnit: "kg", distanceUnit: "km", temperatureUnit: "F" }}
      history={{}}
      deloadContext={{ isDeloadWeek: false, routineKeys: [] }}
      recoveringContext={{ temperedRegions: [], constraints: [] }}
      plateauHints={[]}
      rpeTracking={mintRpeTracking()}
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
      onUpdatePart={vi.fn()}
      onUpdateSet={vi.fn()}
      onAddSet={vi.fn()}
      onRemoveSet={vi.fn()}
      onUpdatePartName={vi.fn()}
      onApplySuggestion={vi.fn()}
      onApplyPerSideSuggestion={vi.fn()}
      onFillFromSession={vi.fn()}
      onPlateFromSuggestion={vi.fn()}
      onPlateTarget={vi.fn()}
    />
  );
}

describe("the activity form's glyph controls name themselves", () => {
  // The reported census. Each name is the string that ALREADY existed as an
  // aria-label — this issue makes them reachable, it does not rewrite any of them.
  it.each([
    "Mark warmup set",
    "Remove set",
    "Decrease RPE",
    "Increase RPE",
    "Move activity up",
    "Move activity down",
    "Remove activity",
  ])("%s", (name) => {
    renderForm();
    const control = screen.getAllByRole("button", { name })[0];
    fireEvent.pointerEnter(control, { pointerType: "mouse" });
    expectNamesItself(control);
  });

  it.each(["Start rest timer", "Reset rest timer"])(
    "the rest timer's %s",
    (name) => {
      render(<RestTimer exercise="Barbell Bench Press" autoStartKey={0} />);
      const control = screen.getByRole("button", { name });
      fireEvent.pointerEnter(control, { pointerType: "mouse" });
      expectNamesItself(control);
    }
  );

  it("makes the warmup toggle a tab stop, and leaves the RPE steppers off the sequence", () => {
    // Both halves, because the first alone would pass on a form that had simply
    // stopped writing tabIndex anywhere. The RPE steppers keep theirs and keep
    // their reason: the value they step is the tab stop, so skipping them takes
    // nothing away (#3335, e2e/rpe-logging.spec.ts). The W has no such twin — it
    // carries `aria-pressed` and is the only way to say a set was a warmup.
    renderForm();
    expect(
      screen.getAllByRole("button", { name: "Mark warmup set" })[0].tabIndex
    ).toBe(0);
    expect(
      screen.getAllByRole("button", { name: "Decrease RPE" })[0].tabIndex
    ).toBe(-1);
  });
});
