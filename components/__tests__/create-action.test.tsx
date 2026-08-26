import { cleanup, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CreateAction, {
  CREATE_ACTIONS,
  SectionCreateHeader,
  type CreateActionKind,
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
import { EquipmentCreateControl } from "@/components/EquipmentManager";
import AddSupplementModal from "@/components/nutrition/AddSupplementModal";

vi.mock("@/components/ActivityEditorProvider", () => ({
  useActivityEditor: () => ({ openCreate: vi.fn() }),
}));

vi.mock("@/components/TabFirstTabs", () => ({
  default: () => <nav data-testid="desktop-tabs" />,
}));

function TestControl() {
  const label = useCreateActionLabel();
  return <button type="button">{label}</button>;
}

function DriftingControl() {
  const label = useCreateActionLabel();
  return <button type="button">{label.replace("Add", "New")}</button>;
}

function assertCanonicalRender(
  kind: CreateActionKind,
  control: React.ReactElement
) {
  const view = render(<CreateAction kind={kind}>{control}</CreateAction>);
  const label = CREATE_ACTIONS[kind].label;
  expect(screen.getByRole("button", { name: label })).toBeTruthy();
  view.unmount();
}

describe("CreateAction", () => {
  it("supplies registry copy at render time inside PageHeader", () => {
    render(
      <PageHeader
        title="Training"
        createAction={
          <CreateAction kind="training-activity">
            <TestControl />
          </CreateAction>
        }
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
        createAction={
          <CreateAction kind="training-activity">
            <TestControl />
          </CreateAction>
        }
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
        createAction={
          <CreateAction kind="goal">
            <TestControl />
          </CreateAction>
        }
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
        createAction={
          <CreateAction kind="training-activity" available={false}>
            <TestControl />
          </CreateAction>
        }
      />
    );
    expect(screen.queryByRole("button", { name: "Add activity" })).toBeNull();
    expect(pageHeader.container.firstElementChild?.children).toHaveLength(1);
    pageHeader.unmount();

    render(
      <TabFirstPage
        config={TRAINING_TAB_FIRST_PAGE}
        testId="unavailable-training"
        createAction={
          <CreateAction kind="training-activity" available={false}>
            <TestControl />
          </CreateAction>
        }
      >
        Plan
      </TabFirstPage>
    );
    expect(screen.queryByTestId("unavailable-training-action")).toBeNull();
    cleanup();

    const sectionHeader = render(
      <SectionCreateHeader
        title="Equipment"
        createAction={
          <CreateAction kind="equipment" available={false}>
            <TestControl />
          </CreateAction>
        }
      />
    );
    expect(screen.queryByRole("button", { name: "Add equipment" })).toBeNull();
    expect(sectionHeader.container.firstElementChild?.children).toHaveLength(1);
  });

  it("makes label drift fail through the rendered accessible name", () => {
    assertCanonicalRender("goal", <TestControl />);
    expect(() => assertCanonicalRender("goal", <DriftingControl />)).toThrow();
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
          control: <EquipmentCreateControl onActivate={vi.fn()} />,
        },
        {
          kind: "supplement",
          control: (
            <AddSupplementModal
              action={action}
              allIntakeItems={[]}
              stackItems={[]}
              pgxVariants={[]}
            />
          ),
        },
      ];

    for (const { kind, control } of controls) {
      expect(() => render(control)).toThrow(
        "Registered create controls require CreateAction"
      );
      cleanup();
      render(<CreateAction kind={kind}>{control}</CreateAction>);
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

  it("keeps the registry closed to canonical copy and housing", () => {
    expect(CREATE_ACTIONS).toEqual({
      medication: { label: "Add medication", housing: "page" },
      practice: { label: "Add practice", housing: "page" },
      "training-activity": { label: "Add activity", housing: "page" },
      protocol: { label: "Add protocol", housing: "section" },
      goal: { label: "Add goal", housing: "section" },
      routine: { label: "Add routine", housing: "section" },
      equipment: { label: "Add equipment", housing: "section" },
      supplement: { label: "Add supplement", housing: "section" },
    });

    type Props = Parameters<typeof CreateAction>[0];
    const accepts = (_props: Props) => undefined;
    // @ts-expect-error A create label is selected by kind, not rewritten locally.
    accepts({ kind: "activity", children: <TestControl /> });
    accepts({
      kind: "routine",
      children: <TestControl />,
      // @ts-expect-error The semantic primitive has no caller styling seam.
      className: "px-8",
    });
  });
});
