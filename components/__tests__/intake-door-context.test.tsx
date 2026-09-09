import { describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  lookupRxcui,
  lookupRxcuiIngredients,
} from "@/app/(app)/nutrition/intake-actions";
import AddSupplementModal from "@/components/nutrition/AddSupplementModal";
import CreateAction from "@/components/CreateAction";
import MedicationAddWorkspace from "@/app/(app)/medications/MedicationAddWorkspace";
import IllnessMedicationLogger from "@/components/illness/IllnessMedicationLogger";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import { ToastProvider } from "@/components/Toast";
import type { IntakeFormContext } from "@/lib/intake-form-context";
import QuickEntryProvider, {
  useQuickEntry,
} from "@/components/QuickEntryProvider";
import { ProfileDaysBoundary } from "@/components/DayContext";
import type { SessionProfile } from "@/lib/auth";

// Hold the subject context fixed across entry points. The adult is the positive
// control for the age gate; stack and PGx notices prove the form has its context.

const addIntakeItem = vi.hoisted(() =>
  vi.fn(async (_data: FormData) => ({ ok: true as const }))
);
const loadQuickEntry = vi.hoisted(() => vi.fn());
const loadQuickEntryIntakeContext = vi.hoisted(() => vi.fn());

vi.mock("@/app/(app)/quick-entry-actions", () => ({
  loadQuickEntry,
  loadQuickEntryIntakeContext,
}));

vi.mock("@/app/(app)/nutrition/intake-actions", () => ({
  addIntakeItem,
  updateIntakeItem: vi.fn(async () => ({ ok: true })),
  lookupRxcui: vi.fn(async () => []),
  lookupRxcuiIngredients: vi.fn(async () => []),
}));
vi.mock("@/app/(app)/supplies/actions", () => ({
  listSharedSupplyOptions: vi.fn(async () => []),
  createPoolAction: vi.fn(async () => ({ ok: true })),
  linkItemAction: vi.fn(async () => ({ ok: true })),
  unlinkItemAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

const TODAY = "2026-09-02";

// One household context, parameterised only by the subject's age in months. The stack
// carries warfarin (moderate with acetaminophen) and ibuprofen (major with warfarin),
// and the variants a CYP2C9 poor metaboliser (warfarin), so one fixture reaches all
// three notices without needing three.
function context(ageMonths: number): IntakeFormContext {
  return {
    allIntakeItems: [
      { id: 31, name: "Warfarin", active: 1 },
      { id: 32, name: "Ibuprofen", active: 1 },
    ] as unknown as IntakeFormContext["allIntakeItems"],
    stackItems: [
      {
        id: 31,
        name: "Warfarin",
        rxcui: "11289",
        rxcuiIngredients: [],
        ingredients: [],
        active: true,
      },
      {
        id: 32,
        name: "Ibuprofen",
        rxcui: "5640",
        rxcuiIngredients: [],
        ingredients: [],
        active: true,
      },
    ],
    pgxVariants: [
      {
        id: 41,
        gene: "CYP2C9",
        star_allele: "*3/*3",
        genotype: null,
        variant: null,
        interpretation: "Poor metabolizer",
        notes: null,
      },
    ],
    conditions: [{ id: 51, name: "Ear infection", status: "active" }],
    pediatric: {
      ageMonths,
      weightKg: 21,
      weightDate: TODAY,
      weightUnit: "kg",
      today: TODAY,
    },
    todayStr: TODAY,
  };
}

const CHILD = context(72); // six years old — the screenshot's case
const ADULT = context(492); // forty-one

type Door = "medications" | "illness" | "supplements";

/** Open the door and type `name` into the one Name field, then report what it says. */
async function openDoor(door: Door, ctx: IntakeFormContext, name: string) {
  render(
    <ToastProvider>
      <ConfirmProvider>
        {door === "medications" ? (
          <MedicationAddWorkspace
            subtitle=""
            action={addIntakeItem}
            intakeContext={ctx}
          />
        ) : door === "supplements" ? (
          <CreateAction
            declaration={{
              kind: "supplement",
              control: (
                <AddSupplementModal
                  action={addIntakeItem}
                  intakeContext={ctx}
                />
              ),
            }}
            housing="section"
          />
        ) : (
          <IllnessMedicationLogger
            meds={[]}
            tz="UTC"
            intakeContext={ctx}
            canAdd
            nowIso={`${TODAY}T12:00:00.000Z`}
          />
        )}
      </ConfirmProvider>
    </ToastProvider>
  );
  fireEvent.click(
    screen.getByTestId(
      door === "medications"
        ? "medication-add-toggle"
        : door === "supplements"
          ? "supplement-add-toggle"
          : "illness-add-medication"
    )
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Name" }), {
    target: { value: name },
  });
  return {
    notices: () =>
      ["interaction-notice", "pgx-notice", "food-notice"].filter(
        (id) => screen.queryAllByTestId(id).length > 0
      ),
  };
}

const DOORS: Door[] = ["medications", "illness", "supplements"];

function QuickLogMedicationDoor() {
  const { open } = useQuickEntry();
  return (
    <button
      type="button"
      onClick={() => open("dose", { doseIntakeKind: "medication" }, 7)}
    >
      Add quick medication
    </button>
  );
}

describe("every add door feeds IntakeItemForm the same subject context (#4609)", () => {
  it("the lazy quick-log door reaches the same child safety context", async () => {
    loadQuickEntry.mockImplementationOnce(() => new Promise(() => {}));
    loadQuickEntryIntakeContext.mockResolvedValueOnce({
      kind: "ready",
      context: CHILD,
    });
    const profile: SessionProfile = {
      id: 7,
      name: "Example Child",
      photo_path: null,
      photo_version: 0,
    };
    render(
      <ToastProvider>
        <ConfirmProvider>
          <ProfileDaysBoundary
            clocks={new Map([[7, { today: TODAY, timeZone: "UTC" }]])}
          >
            <QuickEntryProvider
              actingProfileId={7}
              writableProfiles={[profile]}
              measurements={{
                form: "measurements",
                defaultDate: TODAY,
                defaultStatedAt: null,
                maxDate: TODAY,
                profileId: 7,
                weightUnit: "kg",
                temperatureUnit: "C",
                showCompositionEntry: true,
                showGrowth: true,
                showHeadCirc: false,
              }}
            >
              <QuickLogMedicationDoor />
            </QuickEntryProvider>
          </ProfileDaysBoundary>
        </ConfirmProvider>
      </ToastProvider>
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Add quick medication" })
    );
    const name = await screen.findByRole("combobox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Warfarin" } });

    await waitFor(() =>
      expect(screen.getByTestId("pgx-notice").textContent).toContain("CYP2C9")
    );
    expect(screen.getByTestId("interaction-notice").textContent).toContain(
      "Warfarin + Ibuprofen"
    );
    expect(loadQuickEntryIntakeContext).toHaveBeenCalledWith(7);
  });

  // The alcohol note is `minLifeStage: "adult"`, and an UNKNOWN age is eligible — so
  // the broken illness door and a genuine adult were indistinguishable.
  it.each(DOORS)(
    "%s: an adult sees the acetaminophen alcohol note and a child does not",
    async (door) => {
      const adult = await openDoor(door, ADULT, "Tylenol");
      await waitFor(() => expect(adult.notices()).toContain("food-notice"));
      expect(screen.getByTestId("food-notice").textContent).toContain(
        "Alcohol"
      );
      cleanup();

      const child = await openDoor(door, CHILD, "Tylenol");
      // The FIXTURE reaches the state: the same name still finds its stack
      // interaction, so an empty food notice is the age gate and not an empty form.
      await waitFor(() =>
        expect(child.notices()).toContain("interaction-notice")
      );
      expect(child.notices()).not.toContain("food-notice");
      cleanup();
    }
  );

  it.each(DOORS)(
    "%s: surfaces the stack interaction and the PGx note",
    async (door) => {
      const { notices } = await openDoor(door, CHILD, "Warfarin");
      await waitFor(() => expect(notices()).toContain("pgx-notice"));
      expect(notices()).toContain("interaction-notice");
      expect(screen.getByTestId("interaction-notice").textContent).toContain(
        "Warfarin + Ibuprofen"
      );
      expect(screen.getByTestId("pgx-notice").textContent).toContain("CYP2C9");
      cleanup();
    }
  );

  it.each([
    ["Acetaminophen (with Codeine)", false],
    ["Acetaminophen (with Codeine)", true],
    ["Tylenol / 可待因", false],
  ] as const)(
    "refuses %s and withdraws only its prior offer (manual: %s)",
    async (name, manual) => {
      await openDoor("medications", CHILD, "Acetaminophen");
      await act(async () => {
        fireEvent.keyDown(screen.getByRole("combobox", { name: "Name" }), {
          key: "Enter",
        });
      });
      fireEvent.click(screen.getByTestId("intake-fact-dose"));
      expect(screen.getByTestId("pediatric-band-picker")).toBeTruthy();
      const amount = () =>
        screen.getByRole("combobox", { name: "Amount" }) as HTMLInputElement;
      expect(amount().value).toBe("240 mg");
      if (manual) fireEvent.change(amount(), { target: { value: "180 mg" } });
      fireEvent.change(screen.getByRole("combobox", { name: "Name" }), {
        target: { value: name },
      });
      // Commit and settle the free-text pick: a refused chart must also withdraw
      // the old automatic dose, while a caregiver's own amount remains theirs.
      await act(async () => {
        fireEvent.keyDown(screen.getByRole("combobox", { name: "Name" }), {
          key: "Enter",
        });
      });
      expect(
        screen.getByTestId("medication-pediatric-no-chart").textContent
      ).toContain("ask a pharmacist");
      expect(screen.queryByTestId("pediatric-band-picker")).toBeNull();
      expect(screen.queryByTestId("pediatric-suggestion")).toBeNull();
      expect(amount().value).toBe(manual ? "180 mg" : "");
      expect(screen.getByTestId("interaction-notice").textContent).toContain(
        "Warfarin"
      );
      expect(
        (screen.getByRole("combobox", { name: "Name" }) as HTMLInputElement)
          .value
      ).toBe(name);
    }
  );

  it("withdraws the label offer when a confirmed product has multiple ingredients", async () => {
    await openDoor("medications", CHILD, "Acetaminophen");
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("combobox", { name: "Name" }), {
        key: "Enter",
      });
    });
    expect(screen.getByTestId("intake-fact-dose").textContent).toContain(
      "240 mg"
    );
    vi.mocked(lookupRxcui).mockResolvedValueOnce([
      { rxcui: "99999", name: "Acetaminophen / codeine", score: 100 },
    ]);
    vi.mocked(lookupRxcuiIngredients).mockResolvedValueOnce(["161", "2670"]);
    // Opening the RxNorm chip IS the lookup (#5301); the candidates are its editor.
    fireEvent.click(screen.getByTestId("intake-fact-rxnorm"));
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByTestId("rxcui-use-99999"));
    });
    fireEvent.click(screen.getByTestId("intake-editor-done"));
    fireEvent.click(screen.getByTestId("intake-fact-dose"));
    // The refused chart says so in the dose editor, beside the label's other refusals.
    expect(screen.getByTestId("medication-pediatric-no-chart")).toBeTruthy();
    expect(
      (screen.getByRole("combobox", { name: "Amount" }) as HTMLInputElement)
        .value
    ).toBe("");
    expect(screen.queryByTestId("pediatric-band-picker")).toBeNull();
  });

  // Both doors receive the local day for context, but neither may turn it into
  // a start date the person has not stated.
  it.each(["medications", "illness"] as const)(
    "%s: leaves an unstated start date unknown",
    async (door) => {
      addIntakeItem.mockClear();
      await openDoor(door, CHILD, "Tylenol");
      screen.getByRole("button", { name: "Add" }).click();
      await waitFor(() => expect(addIntakeItem).toHaveBeenCalledOnce());
      expect(addIntakeItem.mock.calls[0]![0].get("started_on")).toBeNull();
      cleanup();
    }
  );
});
