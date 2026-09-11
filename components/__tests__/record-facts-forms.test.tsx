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
import CarePlanForm from "@/app/(app)/records/care/overview/CarePlanForm";
import CareGoalForm from "@/app/(app)/records/care/overview/CareGoalForm";
import FamilyHistoryForm from "@/app/(app)/records/care/overview/FamilyHistoryForm";
import SkinLesionForm from "@/app/(app)/records/specialty/skin/SkinLesionForm";
import DentalProcedureForm from "@/app/(app)/records/specialty/dental/DentalProcedureForm";
import ProcedureForm from "@/app/(app)/records/history/procedures/ProcedureForm";
import type {
  Allergy,
  CareGoal,
  CarePlanItem,
  Condition,
  DentalProcedure,
  FamilyHistory,
  Procedure,
  SkinLesion,
} from "@/lib/types";
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
vi.mock("@/app/(app)/records/specialty/skin/actions", () => ({}));
vi.mock("@/app/(app)/records/specialty/dental/actions", () => ({}));
vi.mock("@/app/(app)/records/history/procedures/actions", () => ({}));

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

describe("no standing prose on a record form (#5300 rule 4)", () => {
  // The allergy form carried one sentence about what a refuted allergy stops doing.
  // It is the VALUE's meaning, so it belongs inside the editor that chooses the
  // value — the one sentence an open editor may carry — and nowhere else.
  //
  // Asked as reachability rather than as text-in-the-document: this form is
  // DOM-collected, so a closed editor is HIDDEN and not unmounted. "Is it on screen"
  // is therefore "is it inside a hidden panel", which is exactly what a person sees.
  const MEANING = /A refuted allergy stays on record/;

  it("the refuted-allergy sentence is behind the verification editor, not on the form", () => {
    wrap(<AllergyForm action={noop} />);
    // The state where the unwanted effect could occur: the form is up and its chip
    // row is on screen, so an inert harness cannot pass this by rendering nothing.
    expect(screen.getByTestId("allergy-fact-row")).toBeTruthy();
    expect(screen.getByText(MEANING).closest("[hidden]")).not.toBeNull();

    // And the positive half: it is there for the person choosing the value. An unset
    // verification is an absent OPTIONAL, so the way in is the trailing affordance
    // that names it — which is also the routing every one of the thirteen forms uses.
    fireEvent.click(screen.getByTestId("allergy-fact-more"));
    fireEvent.click(screen.getByTestId("allergy-more-verification"));
    expect(screen.getByText(MEANING).closest("[hidden]")).toBeNull();
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
    // #5302 slice 2's three care-overview doors. Same claim at each address, because
    // the gate is a value each SECTION passes and the three sections are three
    // separate call sites — a form is gated only if its own section wired it.
    { formId: "family-history", label: "Add family history" },
    { formId: "care-plan", label: "Add care-plan item" },
    { formId: "care-goal", label: "Add health goal" },
    // #5302 slice 3's three, across three separate panes — the skin pane resolves no
    // scope at all and gets its value from `accessForProfile` on the page, which is a
    // third way for a section to supply the prop and so a third chance to miss it.
    { formId: "skin-lesion", label: "Add skin lesion" },
    { formId: "dental-procedure", label: "Add dental record" },
    { formId: "procedure", label: "Add procedure" },
  ])(
    "$label renders for a writer and not for a read-only viewer",
    ({ formId, label }) => {
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
    }
  );
});

// The three care-overview records, each seeded MISSING the essential its form declares
// (#5302 slice 2). One fixture per form rather than one shared row: the essentials are
// each form's own judgement, so the thing being seeded away differs at every address.
const undatedCarePlanItem: CarePlanItem = {
  id: 11,
  description: "Follow-up colonoscopy",
  code: null,
  code_system: null,
  category: "procedure",
  planned_date: null,
  status: "planned",
  provider_id: null,
  provider_name: null,
  notes: null,
  source: null,
  document_id: null,
  external_id: null,
  created_at: "2026-09-01T10:00:00Z",
  source_kind: null,
  source_imaging_study_id: null,
  source_medical_record_id: null,
  source_dental_procedure_id: null,
  source_skin_lesion_id: null,
  recommended_interval_days: null,
  resolution: null,
  resolved_by_imaging_study_id: null,
  resolved_by_medical_record_id: null,
  resolved_by_dental_procedure_id: null,
  resolved_by_skin_lesion_id: null,
  resolved_at: null,
  settled_disposition: null,
  settled_on: null,
  settled_reason: null,
};

const undatedCareGoal: CareGoal = {
  id: 12,
  description: "A1c below 7.0%",
  code: null,
  code_system: null,
  target_date: null,
  status: null,
  notes: null,
  source: null,
  document_id: null,
  external_id: null,
  created_at: "2026-09-01T10:00:00Z",
};

const uncodedRelative: FamilyHistory = {
  id: 13,
  relation: null,
  condition: "Coronary artery disease",
  code: null,
  code_system: null,
  onset_age: null,
  deceased: null,
  age_at_death: null,
  cause_of_death: null,
  relation_type: null,
  lineage: null,
  notes: null,
  source: null,
  document_id: null,
  external_id: null,
  created_at: "2026-09-01T10:00:00Z",
};

describe("the care-overview rows prompt for the essentials they are missing (#5302)", () => {
  // THE SAME QUIET FAILURE the condition case above names, asked at the three slice-2
  // addresses: an absent OPTIONAL renders nothing at all, so a form that classified an
  // essential as optional just looks like a shorter row. Tabled because the three
  // differ only in which form renders and which chip is owed.
  it.each<{ name: string; render: () => void; prompts: string[] }>([
    {
      name: "the care-plan row prompts for a planned date it does not have",
      render: () =>
        wrap(<CarePlanForm action={noop} item={undatedCarePlanItem} />),
      prompts: ["care-plan-fact-planned"],
    },
    {
      name: "the care-goal row prompts for both the target date and the status",
      render: () => wrap(<CareGoalForm action={noop} goal={undatedCareGoal} />),
      prompts: ["care-goal-fact-target", "care-goal-fact-status"],
    },
    {
      name: "the family-history row prompts for the relative and the code",
      render: () =>
        wrap(<FamilyHistoryForm action={noop} entry={uncodedRelative} />),
      prompts: ["family-history-fact-relation", "family-history-fact-code"],
    },
  ])("$name", ({ render: renderForm, prompts }) => {
    renderForm();
    const rowId = prompts[0].replace(/-fact-.*$/, "-fact-row");
    for (const testId of prompts) {
      const chip = screen.getByTestId(testId);
      expect(chip.getAttribute("data-fact-state")).toBe("missing");
      // It is the row's own chip, not something behind the trailing affordance.
      expect(within(screen.getByTestId(rowId)).getByTestId(testId)).toBe(chip);
      // A missing chip carries NO suggestion marking: a fact with no value cannot
      // have borrowed one (FactChipRow's `suggestedAttrs`).
      expect(chip.hasAttribute("data-suggested")).toBe(false);
    }
  });

  it("an unstated care-plan status goes quiet instead of prompting", () => {
    // The positive control for the asymmetry the grammar declares: the same field is
    // essential on the care-goal form and optional here, so this asserts the absence
    // renders as absence rather than as a fourth dashed chip.
    wrap(
      <CarePlanForm
        action={noop}
        item={{ ...undatedCarePlanItem, status: null }}
      />
    );
    expect(screen.queryByTestId("care-plan-fact-status")).toBeNull();
    expect(screen.getByTestId("care-plan-fact-more")).toBeTruthy();
  });
});

describe("the family-history code chip follows the coded pick (#5302 / #1676)", () => {
  // The condition form's claim at the second address that applies a curated code from
  // the SAME picker. Both directions, with the intermediate state asserted so the test
  // cannot pass against a pick that never seeded anything.
  it("picking a catalog condition seeds the chip and marks it a suggestion", () => {
    wrap(<FamilyHistoryForm action={noop} />);
    const field = screen.getByLabelText("Condition");
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "high blood pressure" } });
    // The picker commits on MOUSEDOWN, not click: focus never leaves the input.
    fireEvent.mouseDown(
      screen.getByRole("option", { name: /Essential \(primary\) hypertension/ })
    );

    const chip = screen.getByTestId("family-history-fact-code");
    expect(chip.getAttribute("data-fact-state")).toBe("stated");
    expect(chip.textContent).toContain("I10");
    // Seeded is not stated (#846): the app proposed this code, and the chip says so.
    expect(chip.getAttribute("data-suggested")).toBe("1");

    // Typing the condition away retracts the code the pick applied.
    fireEvent.change(field, { target: { value: "Something else entirely" } });
    expect(
      screen
        .getByTestId("family-history-fact-code")
        .getAttribute("data-fact-state")
    ).toBe("missing");
  });
});

describe("no standing prose on a care-overview form (#5300 rule 4)", () => {
  // The care-plan form carried one paragraph about what an unrecognized status costs.
  // It is the VALUE's meaning, so it belongs inside the editor that chooses the value
  // — the one sentence an open editor may carry — and nowhere else.
  //
  // Asked as reachability rather than as text-in-the-document, for the reason the
  // allergy case above records: this form is DOM-collected, so a closed editor is
  // HIDDEN and not unmounted, and "is it on screen" is "is it inside a hidden panel".
  const MEANING = /keeps counting as open/;

  it("the unrecognized-status notice is behind the status editor, not on the form", () => {
    wrap(<CarePlanForm action={noop} />);
    // Reach the state where the notice exists at all: the free-text escape, holding a
    // status the open/closed machinery does not recognize. The picker is inside the
    // closed panel, which is where a DOM-collected form keeps it.
    fireEvent.change(screen.getByTestId("cp-status-select-new"), {
      target: { value: "__other" },
    });
    fireEvent.change(screen.getByTestId("cp-status-other-new"), {
      target: { value: "finished" },
    });

    // The state where the unwanted effect could occur: the form is up and its chip
    // row is on screen, so an inert harness cannot pass this by rendering nothing.
    expect(screen.getByTestId("care-plan-fact-row")).toBeTruthy();
    expect(screen.getByText(MEANING).closest("[hidden]")).not.toBeNull();

    // And the positive half: it is there for the person choosing the value. The
    // status now reads back as stated, so its own chip is the way in.
    fireEvent.click(screen.getByTestId("care-plan-fact-status"));
    expect(screen.getByText(MEANING).closest("[hidden]")).toBeNull();
  });
});

// The three slice-3 records, each seeded MISSING the essential its form declares
// (#5302). One fixture per form, for the reason the slice-2 block above records: the
// essentials are each form's own judgement.
const unplacedLesion: SkinLesion = {
  id: 21,
  label: "Upper arm mole",
  body_region: null,
  body_side: null,
  size_mm: null,
  asymmetry: 0,
  border: 0,
  color: 0,
  diameter: 0,
  evolving: 0,
  status: "watch",
  observed_date: null,
  finding: null,
  follow_up_interval_days: null,
  provider_id: null,
  provider_name: null,
  encounter_id: null,
  notes: null,
  source: null,
  document_id: null,
  external_id: null,
  created_at: "2026-09-01T10:00:00Z",
};

const uncodedDentalRecord: DentalProcedure = {
  id: 22,
  name: "Caries watch",
  status: "watch",
  tooth: null,
  tooth_system: null,
  surface: null,
  cdt_code: null,
  procedure_date: null,
  finding: null,
  follow_up_interval_days: null,
  provider_id: null,
  provider_name: null,
  notes: null,
  source: null,
  document_id: null,
  external_id: null,
  created_at: "2026-09-01T10:00:00Z",
};

const uncodedProcedure: Procedure = {
  id: 23,
  name: "Colonoscopy",
  code: null,
  code_system: null,
  date: null,
  provider_id: null,
  provider_name: null,
  notes: null,
  source: null,
  document_id: null,
  external_id: null,
  created_at: "2026-09-01T10:00:00Z",
};

describe("the specialty and history rows prompt for the essentials they are missing (#5302)", () => {
  // THE SAME QUIET FAILURE the condition case above names, asked at the three slice-3
  // addresses: an absent OPTIONAL renders nothing at all, so a form that classified an
  // essential as optional just looks like a shorter row.
  it.each<{ name: string; render: () => void; prompts: string[] }>([
    {
      name: "the skin-lesion row prompts for the body map and the observation date",
      render: () =>
        wrap(<SkinLesionForm action={noop} record={unplacedLesion} />),
      prompts: ["skin-lesion-fact-location", "skin-lesion-fact-observed"],
    },
    {
      name: "the dental row prompts for the date and the CDT code",
      render: () =>
        wrap(
          <DentalProcedureForm action={noop} record={uncodedDentalRecord} />
        ),
      prompts: ["dental-procedure-fact-date", "dental-procedure-fact-cdt"],
    },
    {
      name: "the procedure row prompts for both the code and the date",
      render: () =>
        wrap(<ProcedureForm action={noop} procedure={uncodedProcedure} />),
      prompts: ["procedure-fact-code", "procedure-fact-date"],
    },
  ])("$name", ({ render: renderForm, prompts }) => {
    renderForm();
    const rowId = prompts[0].replace(/-fact-.*$/, "-fact-row");
    for (const testId of prompts) {
      const chip = screen.getByTestId(testId);
      expect(chip.getAttribute("data-fact-state")).toBe("missing");
      // It is the row's own chip, not something behind the trailing affordance.
      expect(within(screen.getByTestId(rowId)).getByTestId(testId)).toBe(chip);
      // A missing chip carries NO suggestion marking: a fact with no value cannot
      // have borrowed one (FactChipRow's `suggestedAttrs`).
      expect(chip.hasAttribute("data-suggested")).toBe(false);
    }
  });

  it("an untoothed dental record goes quiet while an unplaced lesion prompts", () => {
    // THE ASYMMETRY, asserted rather than only argued in the grammar. Both facts say
    // "where on the body" and the two resolution matchers read absence in opposite
    // directions: `sameLesion` is strict, so a lesion with no region splits its own
    // track; `sameTooth` matches on recency when either side is unspecified.
    wrap(<DentalProcedureForm action={noop} record={uncodedDentalRecord} />);
    expect(screen.queryByTestId("dental-procedure-fact-tooth")).toBeNull();
    expect(screen.getByTestId("dental-procedure-fact-more")).toBeTruthy();
    cleanup();

    wrap(<SkinLesionForm action={noop} record={unplacedLesion} />);
    expect(factState("skin-lesion-fact-location")).toBe("missing");
  });

  it("the five ABCDE checkboxes are one chip over one editor", () => {
    // The grouped-fact claim at the DOM: one chip, and the editor it opens holds all
    // five named inputs — which is also why they stay mounted when it closes.
    wrap(<SkinLesionForm action={noop} record={unplacedLesion} />);
    // Unobserved, so the fact is behind the trailing affordance rather than on the row.
    fireEvent.click(screen.getByTestId("skin-lesion-fact-more"));
    fireEvent.click(screen.getByTestId("skin-lesion-more-abcde"));
    const editor = screen.getByTestId("skin-lesion-editor");
    expect(editor.getAttribute("data-panel")).toBe("abcde");
    // By NAME, because the names are what post: the five are one fact on the row and
    // five separate columns in the write, and this is the claim that they all live
    // under the one panel.
    expect(
      [...editor.querySelectorAll("input[type='checkbox']")].map((el) =>
        el.getAttribute("name")
      )
    ).toEqual(["asymmetry", "border", "color", "diameter", "evolving"]);
    // And no chip of their own: five would state one set of observations five times.
    fireEvent.click(screen.getByTestId("skin-lesion-editor-done"));
    expect(screen.queryByTestId("skin-lesion-fact-asymmetry")).toBeNull();
  });
});

describe("no standing prose on a specialty record form (#5300 rule 4)", () => {
  // The skin form carried the ABCDE fieldset's legend — "what you noticed, not an
  // assessment" — standing open on every render. It is the VALUE's meaning (#715's
  // scope law, said where the observations are recorded), so it belongs inside the
  // editor that records them and nowhere else.
  //
  // Asked as reachability rather than as text-in-the-document, for the reason the
  // allergy case above records: this form is DOM-collected, so a closed editor is
  // HIDDEN and not unmounted.
  const MEANING = /not an assessment/;

  it("the ABCDE scope sentence is behind its editor, not on the form", () => {
    wrap(<SkinLesionForm action={noop} />);
    // The state where the unwanted effect could occur: the form is up and its chip
    // row is on screen, so an inert harness cannot pass this by rendering nothing.
    expect(screen.getByTestId("skin-lesion-fact-row")).toBeTruthy();
    expect(screen.getByText(MEANING).closest("[hidden]")).not.toBeNull();

    // And the positive half: it is there for the person recording the observations.
    fireEvent.click(screen.getByTestId("skin-lesion-fact-more"));
    fireEvent.click(screen.getByTestId("skin-lesion-more-abcde"));
    expect(screen.getByText(MEANING).closest("[hidden]")).toBeNull();
  });
});
