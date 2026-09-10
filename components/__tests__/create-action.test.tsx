import { intakeFormContext } from "./intake-form-context-fixture";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CreateAction, {
  CREATE_ACTIONS,
  SectionCreateHeader,
  type CreateActionDeclaration,
  type CreateActionHousing,
  type CreateActionKind,
  type HousedKind,
  useCreateActionLabel,
} from "@/components/CreateAction";
import TabFirstPage from "@/components/TabFirstPage";
import { TRAINING_TAB_FIRST_PAGE } from "@/components/tab-first-pages";
import { PageHeader } from "@/components/ui";
import { MedicationCreateControl } from "@/app/(app)/medications/MedicationAddWorkspace";
import AddPracticeButton from "@/app/(app)/wellness/AddPracticeButton";
import AddTrainingActivityButton from "@/app/(app)/training/AddTrainingActivityButton";
import ProtocolFormModal from "@/app/(app)/protocols/ProtocolFormModal";
import { GoalCreateControl } from "@/app/(app)/training/GoalsManager";
import { RoutineCreateControl } from "@/app/(app)/training/RoutinesManager";
import { CatalogCreateControl } from "@/components/CatalogEditor";
import AddSupplementModal from "@/components/nutrition/AddSupplementModal";

const UnopenedForm = vi.hoisted(() => () => null);
const unexpectedAction = vi.hoisted(() => () => {
  throw new Error("create-action tests do not submit domain actions");
});

vi.mock("@/components/ActivityEditorProvider", () => ({
  useActivityEditor: () => ({ openCreate: vi.fn() }),
}));

vi.mock("@/components/ModalShell", () => ({
  default: ({ title }: { title: string }) => (
    <div role="dialog" aria-label={title} />
  ),
}));

vi.mock("@/components/TabFirstTabs", () => ({
  default: () => <nav data-testid="desktop-tabs" />,
}));

// The live create triggers are the subject. Their modal bodies and domain writes
// are not opened or submitted here, so keep those dependency graphs outside this
// component test and fail loudly if a case starts reaching an action.
vi.mock("@/components/IntakeItemForm", () => ({ default: UnopenedForm }));
vi.mock("@/app/(app)/wellness/PracticeEditor", () => ({
  default: UnopenedForm,
}));
vi.mock("@/app/(app)/protocols/ProtocolForm", () => ({
  default: UnopenedForm,
}));
vi.mock("@/app/(app)/training/GoalForm", () => ({ default: UnopenedForm }));
vi.mock("@/app/(app)/training/RoutineBuilder", () => ({
  default: UnopenedForm,
}));
vi.mock("@/app/(app)/training/goal-actions", () => ({
  updateProgress: unexpectedAction,
  setStatus: unexpectedAction,
  setArchived: unexpectedAction,
  deleteGoal: unexpectedAction,
}));
vi.mock("@/app/(app)/training/actions", () => ({
  adoptRoutineTemplateAction: unexpectedAction,
  activateRoutineAction: unexpectedAction,
  deactivateRoutineAction: unexpectedAction,
  deleteRoutineAction: unexpectedAction,
  restartRoutineCycleAction: unexpectedAction,
}));
vi.mock("@/app/(app)/equipment/actions", () => ({
  createEquipmentAction: unexpectedAction,
  updateEquipmentAction: unexpectedAction,
  deleteEquipmentAction: unexpectedAction,
  setEquipmentRetiredAction: unexpectedAction,
}));

function TestControl() {
  const label = useCreateActionLabel();
  return <button type="button">{label}</button>;
}

function DriftingControl() {
  const label = useCreateActionLabel();
  return <button type="button">{label.replace("Add", "New")}</button>;
}

function housedIn<H extends CreateActionHousing>(
  kind: CreateActionKind,
  housing: H
): kind is HousedKind<H> {
  const declared: readonly CreateActionHousing[] = CREATE_ACTIONS[kind].housing;
  return declared.includes(housing);
}

function housedAction(
  kind: CreateActionKind,
  control: React.ReactElement
): React.ReactElement {
  return housedIn(kind, "page") ? (
    <PageHeader title="Test page" createAction={{ kind, control }} />
  ) : (
    <SectionCreateHeader
      title="Test section"
      createAction={{ kind, control }}
    />
  );
}

function assertCanonicalRender(
  kind: CreateActionKind,
  control: React.ReactElement
) {
  const view = render(housedAction(kind, control));
  const label = CREATE_ACTIONS[kind].label;
  expect(screen.getByRole("button", { name: label })).toBeTruthy();
  view.unmount();
}

describe("CreateAction", () => {
  it("supplies registry copy at render time inside PageHeader", () => {
    render(
      <PageHeader
        title="Training"
        createAction={{ kind: "training-activity", control: <TestControl /> }}
        action={<button type="button">Filter</button>}
      />
    );

    const create = screen.getByRole("button", { name: "Add activity" });
    const filter = screen.getByRole("button", { name: "Filter" });
    expect(create.parentElement).toBe(filter.parentElement);
  });

  it("places the create and ordinary action in the TabFirstPage action row", () => {
    render(
      <TabFirstPage
        config={TRAINING_TAB_FIRST_PAGE}
        testId="training"
        createAction={{ kind: "training-activity", control: <TestControl /> }}
        action={<button type="button">Equipment</button>}
      >
        Log
      </TabFirstPage>
    );

    const row = screen.getByTestId("training-action");
    expect(
      row.contains(screen.getByRole("button", { name: "Add activity" }))
    ).toBe(true);
    expect(
      row.contains(screen.getByRole("button", { name: "Equipment" }))
    ).toBe(true);
  });

  it("owns section heading/action placement", () => {
    render(
      <SectionCreateHeader
        title="Goals"
        action={<button type="button">Show archived</button>}
        createAction={{ kind: "goal", control: <TestControl /> }}
      />
    );
    const heading = screen.getByRole("heading", { name: "Goals" });
    const create = screen.getByRole("button", { name: "Add goal" });
    expect(
      heading.parentElement?.parentElement?.parentElement?.contains(create)
    ).toBe(true);
  });

  it("omits unavailable page and section action containers", () => {
    const pageHeader = render(
      <PageHeader
        title="Training"
        createAction={{
          kind: "training-activity",
          available: false,
          control: <TestControl />,
        }}
      />
    );
    expect(screen.queryByRole("button", { name: "Add activity" })).toBeNull();
    expect(pageHeader.container.firstElementChild?.children).toHaveLength(1);
    pageHeader.unmount();

    render(
      <TabFirstPage
        config={TRAINING_TAB_FIRST_PAGE}
        testId="unavailable-training"
        createAction={{
          kind: "training-activity",
          available: false,
          control: <TestControl />,
        }}
      >
        Plan
      </TabFirstPage>
    );
    expect(screen.queryByTestId("unavailable-training-action")).toBeNull();
    cleanup();

    const sectionHeader = render(
      <SectionCreateHeader
        title="Equipment"
        createAction={{
          kind: "equipment",
          available: false,
          control: <TestControl />,
        }}
      />
    );
    expect(screen.queryByRole("button", { name: "Add equipment" })).toBeNull();
    expect(sectionHeader.container.firstElementChild?.children).toHaveLength(1);
  });

  it("makes label drift fail through the rendered accessible name", () => {
    assertCanonicalRender("goal", <TestControl />);
    expect(() => assertCanonicalRender("goal", <DriftingControl />)).toThrow();
  });

  // A kind mounts in ANY housing it declared and is refused in one it did not —
  // whether a housing another kind declared or one outside the vocabulary (#4667).
  // At a literal call site the type already forbids the refused rows; the table's
  // union is what reaches the runtime guard, so it needs the one expect-error.
  it.each([
    ["medication", "page", null],
    ["medication", "section", null],
    ["goal", "page", "goal create action requires section housing"],
    [
      "medication",
      "modal",
      "medication create action requires page or section housing",
    ],
  ] as const)("%s mounted in %s housing", (kind, housing, refusal) => {
    const mount = () =>
      render(
        <CreateAction
          declaration={{ kind, control: <TestControl /> }}
          // @ts-expect-error The refused rows are the ones the runtime guard proves.
          housing={housing}
        />
      );
    if (refusal) {
      expect(mount).toThrow(refusal);
    } else {
      mount();
      expect(
        screen.getByRole("button", { name: CREATE_ACTIONS[kind].label })
      ).toBeTruthy();
    }
  });

  it("renders every exact registered trigger with registry-owned copy", () => {
    const action = vi.fn(async () => ({ ok: false as const, error: "test" }));
    const controls: { kind: CreateActionKind; control: React.ReactElement }[] =
      [
        {
          kind: "medication",
          control: <MedicationCreateControl open={false} onToggle={vi.fn()} />,
        },
        { kind: "practice", control: <AddPracticeButton /> },
        { kind: "training-activity", control: <AddTrainingActivityButton /> },
        {
          kind: "protocol",
          control: (
            <ProtocolFormModal
              action={action}
              options={[]}
              equipment={[]}
              intakeItems={[]}
              template={null}
            />
          ),
        },
        { kind: "goal", control: <GoalCreateControl onActivate={vi.fn()} /> },
        {
          kind: "routine",
          control: <RoutineCreateControl onActivate={vi.fn()} />,
        },
        {
          kind: "equipment",
          control: <CatalogCreateControl onActivate={vi.fn()} />,
        },
        {
          kind: "supplement",
          control: (
            <AddSupplementModal
              action={action}
              intakeContext={intakeFormContext("2026-09-01")}
            />
          ),
        },
      ];

    for (const { kind, control } of controls) {
      expect(() => render(control)).toThrow(
        "Registered create controls require CreateAction"
      );
      cleanup();
      render(housedAction(kind, control));
      const trigger = screen.getByRole("button", {
        name: CREATE_ACTIONS[kind].label,
      });
      expect(trigger).toBeTruthy();
      if (kind === "practice") {
        expect(trigger.querySelector("span")?.textContent).toBe("Add");
      }
      cleanup();
    }
  });

  // ONE PHRASE, TRIGGER AND DIALOG (#5300 rule 6, adopted by #5617). This used to
  // pin the opposite — a registry-owned dialog title carrying an article over a
  // control that had none — and practice was the only kind that carried a second
  // title at all. The article form retires with the record door's four renamings, so
  // the seam that held it is gone rather than restated shorter.
  it("titles the practice dialog with the same phrase as its trigger", () => {
    render(housedAction("practice", <AddPracticeButton />));

    fireEvent.click(screen.getByRole("button", { name: "Add practice" }));
    expect(screen.getByRole("dialog", { name: "Add practice" })).toBeTruthy();
  });

  it("keeps the registry closed to canonical copy and housing", () => {
    expect(CREATE_ACTIONS).toEqual({
      medication: { label: "Add medication", housing: ["page", "section"] },
      practice: { label: "Add practice", housing: ["page"] },
      "training-activity": { label: "Add activity", housing: ["page"] },
      protocol: { label: "Add protocol", housing: ["section"] },
      goal: { label: "Add goal", housing: ["section"] },
      routine: { label: "Add routine", housing: ["section"] },
      equipment: { label: "Add equipment", housing: ["section"] },
      supplement: { label: "Add supplement", housing: ["section"] },
    });

    const accepts = (_declaration: CreateActionDeclaration) => undefined;
    // @ts-expect-error A create label is selected by kind, not rewritten locally.
    accepts({ kind: "activity", control: <TestControl /> });
    accepts({
      kind: "routine",
      control: <TestControl />,
      // @ts-expect-error The semantic primitive has no caller styling seam.
      className: "px-8",
    });
  });
});

// PageHeader's back slot (#5411). The header owns both halves of a back link:
// the place (above the h1, never below it or inside a card) and the survival of
// `compactBelowSm`. That second half is the whole reason the day view can carry
// one: `compactBelowSm` sends the h1 `sr-only`, so on a phone the back link is
// the header's ONE visible line. A slot drawn inside the title block would
// vanish with it and the day view would be back to having no way out.
describe("PageHeader's back slot", () => {
  function renderCompactHeader() {
    render(
      <PageHeader
        title="History"
        compactBelowSm
        back={{ href: "/history?kind=dose", destination: "History" }}
      />
    );
    return {
      back: screen.getByRole("link", { name: "History" }),
      title: screen.getByRole("heading", { name: "History" }),
    };
  }

  it("places a compact page's return link before its title", () => {
    const { back, title } = renderCompactHeader();
    expect(back.getAttribute("href")).toBe("/history?kind=dose");
    expect(
      back.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("keeps the link visible below sm while the title goes sr-only", () => {
    const { back, title } = renderCompactHeader();
    expect(title.className).toContain("sr-only");
    // Nothing between the link and the header root withdraws it below `sm`.
    const withdrawn: string[] = [];
    for (
      let node: HTMLElement | null = back;
      node && node !== document.body;
      node = node.parentElement
    ) {
      if (/\b(sr-only|hidden)\b/.test(node.className)) {
        withdrawn.push(node.className);
      }
    }
    expect(withdrawn).toEqual([]);
  });
});
