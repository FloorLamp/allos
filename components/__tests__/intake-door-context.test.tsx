import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import MedicationAddWorkspace from "@/app/(app)/medications/MedicationAddWorkspace";
import IllnessMedicationLogger from "@/components/illness/IllnessMedicationLogger";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import { ToastProvider } from "@/components/Toast";
import type { IntakeFormContext } from "@/lib/intake-form-context";

// THE TWO ADD DOORS FEED THE SAME FORM THE SAME THING (#4609).
//
// The illness "Meds add" fold passed IntakeItemForm the pediatric context and nothing
// else. The form therefore KNEW the profile was a child — it drew the weight-band
// dosing copy — while the food-note age gate ran on "unknown" and printed chronic-
// alcohol counselling underneath it, on a six-year-old. Its stack-interaction and PGx
// notices had nothing to check against, and without `todayStr` it posted no
// `started_on` at all, which is what decides whether addIntakeItem validates a start
// date. Everything looked complete.
//
// So the door is the PARAMETER here and the context is held fixed: whatever the
// /medications door renders from a context, the illness door must render from the same
// one. The adult row is not decoration — it is the positive control. Without it, "the
// child sees no alcohol note" passes just as well on a form that rendered nothing.

const addIntakeItem = vi.hoisted(() =>
  vi.fn(async (_data: FormData) => ({ ok: true as const }))
);

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

type Door = "medications" | "illness";

/** Open the door and type `name` into the one Name field, then report what it says. */
async function openDoor(door: Door, ctx: IntakeFormContext, name: string) {
  render(
    <ToastProvider>
      <ConfirmProvider>
        {door === "medications" ? (
          <MedicationAddWorkspace
            subtitle=""
            action={addIntakeItem}
            allIntakeItems={ctx.allIntakeItems}
            stackItems={ctx.stackItems}
            pgxVariants={ctx.pgxVariants}
            conditions={ctx.conditions}
            pediatric={ctx.pediatric}
            todayStr={ctx.todayStr}
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
      door === "medications" ? "medication-add-toggle" : "illness-add-medication"
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

const DOORS: Door[] = ["medications", "illness"];

describe("every add door feeds IntakeItemForm the same subject context (#4609)", () => {
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

  it.each(DOORS)("%s: surfaces the stack interaction and the PGx note", async (door) => {
    const { notices } = await openDoor(door, CHILD, "Warfarin");
    await waitFor(() => expect(notices()).toContain("pgx-notice"));
    expect(notices()).toContain("interaction-notice");
    expect(screen.getByTestId("interaction-notice").textContent).toContain(
      "Warfarin + Ibuprofen"
    );
    expect(screen.getByTestId("pgx-notice").textContent).toContain("CYP2C9");
    cleanup();
  });

  // `todayStr` is not cosmetic: with it absent the form posts no `started_on`, and
  // addIntakeItem skips its whole start-date branch on `formData.has("started_on")`.
  it.each(DOORS)("%s: posts the subject's local day as the start date", async (door) => {
    addIntakeItem.mockClear();
    await openDoor(door, CHILD, "Tylenol");
    screen.getByRole("button", { name: "Add" }).click();
    await waitFor(() => expect(addIntakeItem).toHaveBeenCalledOnce());
    expect(addIntakeItem.mock.calls[0]![0].get("started_on")).toBe(TODAY);
    cleanup();
  });
});
