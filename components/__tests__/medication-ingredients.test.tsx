import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { IntakeItem } from "@/lib/types";
import type { IntakeItemIngredient } from "@/lib/intake-ingredients";
import MedicationCard from "@/app/(app)/medications/MedicationCard";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import { ToastProvider } from "@/components/Toast";

// "WHAT'S IN THIS" ON A MEDICATION (#3161).
//
// `intake_item_ingredients` is a child of `intake_items`, so composition is available
// for both kinds, and the engines that read it — the interaction detector above all —
// are deliberately kind-blind. The DISPLAY was not: the only renderer was on the
// supplement row, so a combination OTC product tracked as a medication carried its
// composition invisibly on the one surface that shows that item.
//
// Rendered through the real card rather than through the shared disclosure alone,
// because the defect was never in the markup — it was that this surface did not mount
// it, and only mounting the surface can see that.

const AMOXICILLIN = {
  id: 41,
  name: "Cold and flu day capsules",
  notes: null,
  active: 1,
  created_at: "2026-01-04T09:00:00Z",
  condition: "daily",
  obligation: "must",
  brand: null,
  product: null,
  situation: null,
  situation_id: null,
  pause_situation: null,
  pause_situation_id: null,
  stack: null,
  critical: 0,
  escalate_after_min: null,
  escalate_chat_id: null,
  quantity_on_hand: null,
  qty_per_dose: 1,
  supply_id: null,
  kind: "medication",
  // The card reads a wide slice of IntakeItem and every unset field here is null or
  // absent in the same way a freshly added medication's row is.
} as unknown as IntakeItem;

const INGREDIENTS: IntakeItemIngredient[] = [
  {
    id: 1,
    item_id: 41,
    name: "Paracetamol",
    amount: 500,
    unit: "mg",
    amount_text: null,
    sort: 0,
  },
  {
    id: 2,
    item_id: 41,
    name: "Phenylephrine",
    amount: 10,
    unit: "mg",
    amount_text: null,
    sort: 1,
  },
];

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/medications/41",
  useSearchParams: () => new URLSearchParams(),
}));

// jsdom has no media-query engine, and the toast provider asks it about reduced
// motion the moment it mounts.
beforeEach(() => {
  window.matchMedia ??= ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  })) as any;
});

// The card's own hooks need the app shell's two providers; nothing below asserts on
// either, they are what makes the real component mountable at all.
function renderCard(ingredients: IntakeItemIngredient[]) {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <MedicationCard
          medication={AMOXICILLIN}
          doses={[]}
          allIntakeItems={[]}
          stackItems={[]}
          pgxVariants={[]}
          pairs={[]}
          takenDoseIds={new Set<number>()}
          skippedDoseIds={new Set<number>()}
          due={false}
          courses={[]}
          sideEffects={[]}
          strip={[]}
          refillRate={null}
          todayStr="2026-03-02"
          nowIso="2026-03-02T13:20:00Z"
          timezone="UTC"
          historyMaxDate="2026-03-02"
          defaultHistoryTime="13:20"
          ingredients={ingredients}
        />
      </ConfirmProvider>
    </ToastProvider>
  );
}

describe("a medication card shows its label composition (#3161)", () => {
  it("lists every ingredient it is given", () => {
    renderCard(INGREDIENTS);
    const block = screen.getByTestId("medication-ingredients");
    expect(block.querySelector("summary")?.textContent).toBe(
      "What's in this (2)"
    );
    expect(
      [...block.querySelectorAll("li")].map((li) => li.textContent)
    ).toEqual(["Paracetamol 500 mg", "Phenylephrine 10 mg"]);
  });

  // Nearly every medication has no recorded composition, so the disclosure must not
  // leave an empty control behind on the card.
  it("renders nothing when the medication has no composition", () => {
    renderCard([]);
    expect(screen.queryByTestId("medication-ingredients")).toBeNull();
  });
});
