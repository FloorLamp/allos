import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SupplyOption } from "@/lib/supply-product";
import SharedSupplyPicker from "@/components/intake/SharedSupplyPicker";
import MedicationCard from "@/app/(app)/medications/MedicationCard";
import MedicationAddWorkspace from "@/app/(app)/medications/MedicationAddWorkspace";
import AddSupplementModal from "@/components/nutrition/AddSupplementModal";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import CreateAction from "@/components/CreateAction";
import { ToastProvider } from "@/components/Toast";
import { intakeKindAffordances } from "@/lib/intake-kind-affordances";

// WHICH BOTTLES THE SHARED-SUPPLY PICKER OFFERS (#3315).
//
// The picker offered EVERY household bottle whatever the item's kind, so a supplement
// item could be linked to the household's ibuprofen — after which the bottle's
// membership is mixed, poolSurfaceKind reads it as a medication, and it leaves the Add
// supplement door for everyone.
//
// WHY THIS TIER AND NOT A PURE TEST. The rule itself is pure and pinned in
// lib/__tests__/supply-product.test.ts. What could not be pinned there is that the
// PICKER applies it: the list it renders is fetched in an effect and filtered in the
// component, and the shipped bug was a correct rule with an unfiltered consumer. The
// assertions read option VALUES rather than row text, per the issue's own criterion —
// the failure mode in #3270 was an unfiltered list rendering perfectly plausibly.

const BOTTLES: SupplyOption[] = [
  {
    id: 11,
    name: "Vitamin D3",
    strength: "5000 IU",
    form: "capsule",
    siblingKind: "supplement",
  },
  {
    id: 22,
    name: "Ibuprofen",
    strength: "200 mg",
    form: "tablet",
    siblingKind: "medication",
  },
  // Nobody links it yet, so it contradicts nothing and every door offers it (#3270's
  // no-sibling ruling, which this picker inherits rather than re-deciding).
  { id: 33, name: "Magnesium", strength: null, form: null, siblingKind: null },
];

const TRACKED_MEDICATION = {
  medication: { id: 7, name: "Aspirin", quantity_on_hand: 90 },
  courses: [],
  sideEffects: [],
  initialAction: "edit",
} as unknown as Parameters<typeof MedicationCard>[0];

const supplyActions = vi.hoisted(() => ({
  list: vi.fn(async () => BOTTLES),
  link: vi.fn(async () => ({ ok: true as const, supply: BOTTLES[1] })),
}));

vi.mock("@/app/(app)/nutrition/intake-actions", () => ({
  updateIntakeItem: vi.fn(async () => ({ ok: true })),
  lookupRxcui: vi.fn(async () => [
    { rxcui: "5640", name: "Ibuprofen", score: 100 },
  ]),
  lookupRxcuiIngredients: vi.fn(async () => ["5640"]),
}));

class R {
  observe() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", R);

vi.mock("@/app/(app)/supplies/actions", () => ({
  listSharedSupplyOptions: supplyActions.list,
  createPoolAction: vi.fn(async () => ({ ok: true })),
  linkItemAction: supplyActions.link,
  unlinkItemAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/nutrition",
  useSearchParams: () => new URLSearchParams(),
}));

/** The bottle ids the mounted picker is offering, in render order. */
async function offeredBottleIds(): Promise<number[]> {
  const select = await screen.findByRole("combobox");
  await waitFor(() =>
    expect(select.querySelectorAll("option").length).toBeGreaterThan(1)
  );
  return [...select.querySelectorAll("option")]
    .map((o) => Number(o.value))
    .filter((v) => Number.isInteger(v) && v > 0);
}

const bottles = (ids: number[]) => BOTTLES.filter((b) => ids.includes(b.id));

describe("SharedSupplyPicker offers by the kind a bottle's members lend (#3315)", () => {
  it.each([
    ["supplement" as const, [11, 33]],
    ["medication" as const, [22, 33]],
  ])("an existing %s item is offered %o", async (kind, ids) => {
    render(
      <SharedSupplyPicker
        itemId={7}
        itemName="Vitamin D3"
        options={bottles(ids)}
        supplyId=""
        supplyName={null}
      />
    );
    expect(await offeredBottleIds()).toEqual(ids);
  });

  // The create-mode branch is a different render with its own list, and it is the one
  // whose pick rides along on the item's own save (#1705).
  it.each([
    ["supplement" as const, [11, 33]],
    ["medication" as const, [22, 33]],
  ])("a new %s item is offered %o", async (kind, ids) => {
    render(
      <SharedSupplyPicker
        itemName="Vitamin D3"
        options={bottles(ids)}
        supplyId=""
        supplyName={null}
      />
    );
    expect(await offeredBottleIds()).toEqual(ids);
  });

  // A link that already exists is a fact, not an offer. A supplement item sitting on a
  // bottle whose members read as medication predates this filter, and hiding its own
  // bottle would leave it with no way to unlink.
  it("keeps the bottle the item is already linked to", async () => {
    render(
      <SharedSupplyPicker
        itemId={7}
        itemName="Vitamin D3"
        options={[BOTTLES[1], BOTTLES[0], BOTTLES[2]]}
        supplyId="22"
        supplyName="Ibuprofen"
      />
    );
    expect(await offeredBottleIds()).toEqual([22, 11, 33]);
  });
});

async function saveBottle(kind: "medication" | "supplement", name: string) {
  const action = vi.fn(async (_data: FormData) => ({ ok: true as const }));
  const common = {
    action,
    allIntakeItems: [],
    stackItems: [],
    pgxVariants: [],
  };
  const supplement = <AddSupplementModal {...common} />;
  const form =
    kind === "medication" ? (
      <MedicationAddWorkspace
        {...common}
        subtitle=""
        todayStr="2026-09-01"
        conditions={[]}
      />
    ) : (
      <CreateAction
        declaration={{ kind: "supplement", control: supplement }}
        housing="section"
      />
    );
  render(
    <ToastProvider>
      <ConfirmProvider>{form}</ConfirmProvider>
    </ToastProvider>
  );
  fireEvent.click(screen.getByTestId(`${kind}-add-toggle`));
  fireEvent.click(screen.getByTestId("intake-fact-importance"));
  expect(
    (screen.getByTestId("intake-obligation") as HTMLSelectElement).value
  ).toBe(intakeKindAffordances(kind).defaultObligation);
  fireEvent.click(screen.getByTestId("intake-editor-done"));
  const input = screen.getByRole("combobox", { name: "Name" });
  fireEvent.focus(input);
  const option = await screen.findByRole("option", {
    name: new RegExp(`^${name}.*— shared bottle$`),
  });
  const excluded = kind === "medication" ? "Vitamin D3" : "Ibuprofen";
  expect(screen.queryByText(new RegExp(`^${excluded}`))).toBeNull();
  fireEvent.mouseDown(option);
  await waitFor(() => expect((input as HTMLInputElement).value).toBe(name));
  if (kind === "medication") await screen.findByTestId("rxcui-current");
  screen.getByRole("button", { name: "Add" }).click();
  await waitFor(() => expect(action).toHaveBeenCalledOnce());
  return action.mock.calls[0]![0];
}

describe("IntakeItemForm bottle picks (#4608)", () => {
  it("saves the product name and applies medication prefill", async () => {
    const data = await saveBottle("medication", "Ibuprofen");
    expect(data.get("name")).toBe("Ibuprofen");
    expect(data.get("rxcui")).toBe("5640");
    expect(data.get("obligation")).toBe("may");
    expect(data.get("min_interval_hours")).toBe("6");
    expect(data.get("max_daily_count")).toBe("4");
    expect(data.get("supply_id")).toBe("22");
  });

  it("keeps bottle strength while applying supplement catalog timing", async () => {
    const data = await saveBottle("supplement", "Vitamin D3");
    const [dose] = JSON.parse(String(data.get("doses")));
    expect(dose.amount).toBe("5000 IU");
    expect(dose.time_of_day).toBe("Morning");
    expect(data.get("supply_id")).toBe("11");
  });
});

it("updates the supply fact after edit apply without changing item identity (#4670)", async () => {
  supplyActions.list.mockClear();
  render(
    <ToastProvider>
      <ConfirmProvider>
        <MedicationCard {...TRACKED_MEDICATION} />
      </ConfirmProvider>
    </ToastProvider>
  );

  fireEvent.click(screen.getByTestId("intake-fact-supply"));
  fireEvent.change(await screen.findByLabelText("Shared supply"), {
    target: { value: "22" },
  });
  fireEvent.click(screen.getByTestId("shared-supply-apply"));
  await screen.findByText("Linked to “Ibuprofen”.");
  expect(
    screen
      .getByLabelText("Quantity on hand")
      .closest("[aria-hidden]")
      ?.getAttribute("aria-hidden")
  ).toBe("true");
  fireEvent.click(screen.getByTestId("intake-editor-done"));

  expect(screen.getByTestId("intake-fact-supply").textContent).toContain(
    "Ibuprofen"
  );
  expect(
    (screen.getByRole("combobox", { name: "Name" }) as HTMLInputElement).value
  ).toBe("Aspirin");
  expect(supplyActions.list).toHaveBeenCalledOnce();
});
