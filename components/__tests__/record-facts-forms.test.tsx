import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import { ToastProvider } from "@/components/Toast";
import AddEntryPanel from "@/components/AddEntryPanel";
import AllergyForm from "@/app/(app)/records/problems/allergies/AllergyForm";
import ConditionForm from "@/app/(app)/records/problems/conditions/ConditionForm";
import type { Allergy, Condition } from "@/lib/types";
import type { FormId } from "@/lib/form-grammar";

// The clinical record forms as the person meets them, once they render through the
// facts primitive (#5302). One file for the family: the four claims below are the same
// four at each of the thirteen addresses, so a slice adopting a form adds rows to the
// tables rather than a test file.
//
// WHAT IS ASKED HERE AND NOT IN lib/__tests__/record-facts.test.ts. That file asks the
// pure summaries which facts a row states; this one asks whether the FORM renders them
// — a dashed prompt is a rendered treatment, the code chip's seeding runs through the
// real picker, and the add door's gate is a mount decision. Different failures, and the
// cheapest tier that can see each.

vi.mock("@/app/(app)/records/problems/allergies/actions", () => ({}));
vi.mock("@/app/(app)/records/problems/conditions/actions", () => ({}));

const noop = async () => ({ ok: true as const });

function wrap(node: React.ReactNode) {
  return render(
    <ToastProvider>
      <ConfirmProvider>{node}</ConfirmProvider>
    </ToastProvider>
  );
}

// jsdom ships no ResizeObserver, and the condition form's name picker anchors its
// listbox through one (components/overlay/useAnchoredPopover). Without the stand-in the
// pick tests below throw before their first assertion.
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

afterEach(cleanup);

// This tier carries no jest-dom, so state is read off the DOM directly.
const factState = (testId: string) =>
  screen.getByTestId(testId).getAttribute("data-fact-state");

// A stored condition with NO code — the shape 170 of 178 prod rows have (#5287).
const codelessCondition: Condition = {
  id: 7,
  name: "Asthma",
  code: null,
  code_system: null,
  status: "active",
  laterality: null,
  severity: null,
  stage: null,
  onset_date: null,
  resolved_date: null,
  notes: null,
  source: null,
  document_id: null,
  external_id: null,
  edited: 1,
  created_at: "2026-09-01T10:00:00Z",
};

const ungradedAllergy: Allergy = {
  id: 9,
  onset_date: null,
  substance: "Peanut",
  substance_code: null,
  substance_code_system: null,
  reaction: "Hives",
  severity: null,
  status: "active",
  criticality: null,
  verification_status: null,
  reactions: [{ manifestation: "Hives", severity: null }],
  notes: null,
  provider_id: null,
  encounter_id: null,
  source: null,
  document_id: null,
  external_id: null,
  created_at: "2026-09-01T10:00:00Z",
};

describe("a seeded record row prompts for the essentials it is missing (#5302)", () => {
  // THE FAILURE THIS CATCHES is the quiet one. An absent OPTIONAL renders nothing at
  // all, so a form that classified an essential as optional — or rendered a missing
  // fact as nothing — looks perfectly fine on screen: the row is just shorter. The
  // dashed treatment is the only thing that says a fact is still owed.
  it("the condition row renders a dashed prompt for a code it does not have", () => {
    wrap(<ConditionForm action={noop} condition={codelessCondition} />);
    const chip = screen.getByTestId("condition-fact-code");
    expect(chip.getAttribute("data-fact-state")).toBe("missing");
    // It is the row's own chip, not something behind the trailing affordance.
    expect(
      within(screen.getByTestId("condition-fact-row")).getByTestId(
        "condition-fact-code"
      )
    ).toBe(chip);
    // A missing chip carries NO suggestion marking: a fact with no value cannot have
    // borrowed one (FactChipRow's `suggestedAttrs`).
    expect(chip.hasAttribute("data-suggested")).toBe(false);
  });

  it("the allergy row prompts for the grade while stating the reaction", () => {
    wrap(<AllergyForm action={noop} allergy={ungradedAllergy} />);
    expect(factState("allergy-fact-reaction")).toBe("stated");
    expect(factState("allergy-fact-severity")).toBe("missing");
  });

  it("every chip is a disclosure that opens one editor beneath the row", () => {
    // The primitive's contract, asserted at this consumer: tapping a chip opens that
    // fact's editor ALONE and the row goes with it.
    wrap(<ConditionForm action={noop} condition={codelessCondition} />);
    fireEvent.click(screen.getByTestId("condition-fact-status"));
    expect(
      screen.getByTestId("condition-editor").getAttribute("data-panel")
    ).toBe("status");
    expect(screen.queryByTestId("condition-fact-row")).toBeNull();
    fireEvent.click(screen.getByTestId("condition-editor-done"));
    expect(screen.getByTestId("condition-fact-row")).toBeTruthy();
  });
});

describe("the condition code chip follows the coded pick (#5302 / #1676)", () => {
  // BOTH DIRECTIONS, because only one of them was ever in doubt. A pick that seeds the
  // chip is the feature; a typed name that leaves it a prompt is the promise that the
  // app never claims a code nobody chose (#155's confirm-to-apply rule, as a chip).
  function typeName(text: string) {
    const field = screen.getByLabelText("Condition");
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: text } });
    return field;
  }

  // The picker commits on MOUSEDOWN, not click: focus never leaves the input, so the
  // row has to act before the blur that a click would land first.
  function pick(name: RegExp) {
    fireEvent.mouseDown(screen.getByRole("option", { name }));
  }

  it("a free-typed name leaves the code chip a prompt", () => {
    wrap(<ConditionForm action={noop} />);
    typeName("something nobody coded");
    expect(factState("condition-fact-code")).toBe("missing");
  });

  it("picking a catalog name seeds the chip, and marks it as a suggestion", () => {
    wrap(<ConditionForm action={noop} />);
    typeName("high blood pressure");
    pick(/Essential \(primary\) hypertension/);
    const chip = screen.getByTestId("condition-fact-code");
    expect(chip.getAttribute("data-fact-state")).toBe("stated");
    expect(chip.textContent).toContain("I10");
    // Seeded is not stated (#846): the app proposed this code, and the chip says so.
    expect(chip.getAttribute("data-suggested")).toBe("1");
  });

  it("editing the name away from the picked entry takes the code back off the row", () => {
    wrap(<ConditionForm action={noop} />);
    typeName("high blood pressure");
    pick(/Essential \(primary\) hypertension/);
    // The positive control: without it this test is green against a pick that never
    // seeded anything, since the end state is the state it started in.
    expect(factState("condition-fact-code")).toBe("stated");

    typeName("Something else entirely");
    expect(factState("condition-fact-code")).toBe("missing");
  });
});

describe("a record add door is gated on write access (#4694)", () => {
  // Asked PER FORM, because the gate is a value each section has to pass and the two
  // #5302 slice-1 sections are the first that do. The shell is the only gate; #4694
  // makes the prop required so a section cannot mount a door without it.
  it.each<{ formId: FormId; label: string }>([
    { formId: "condition", label: "Add condition" },
    { formId: "allergy", label: "Add allergy" },
  ])("$label renders for a writer and not for a read-only viewer", ({
    formId,
    label,
  }) => {
    const door = (access: "read" | "write") => (
      <AddEntryPanel
        formId={formId}
        access={access}
        label={label}
        panelId={`${formId}-panel`}
        testId={`add-${formId}-panel`}
        presentation="modal"
      >
        <p>form</p>
      </AddEntryPanel>
    );

    const writer = render(door("write"));
    expect(
      screen.getByTestId(`add-${formId}-panel-toggle`).textContent
    ).toContain(label);
    writer.unmount();

    // No door at all, not a disabled one: a control that cannot do anything still
    // says the write exists here, and still costs a tap to find out otherwise.
    render(door("read"));
    expect(screen.queryByTestId(`add-${formId}-panel-toggle`)).toBeNull();
    expect(screen.queryByText(label)).toBeNull();
  });
});
