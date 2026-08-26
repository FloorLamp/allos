import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { SupplyOption } from "@/lib/supply-product";
import SharedSupplyPicker from "@/components/intake/SharedSupplyPicker";

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

vi.mock("@/app/(app)/supplies/actions", () => ({
  listSharedSupplyOptions: vi.fn(async () => BOTTLES),
  createPoolAction: vi.fn(async () => ({ ok: true })),
  linkItemAction: vi.fn(async () => ({ ok: true })),
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

describe("SharedSupplyPicker offers by the kind a bottle's members lend (#3315)", () => {
  it.each([
    ["supplement" as const, [11, 33]],
    ["medication" as const, [22, 33]],
  ])("an existing %s item is offered %o", async (kind, ids) => {
    render(
      <SharedSupplyPicker
        itemId={7}
        itemName="Vitamin D3"
        kind={kind}
        supplyId={null}
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
        kind={kind}
        supplyId={null}
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
        kind="supplement"
        supplyId={22}
        supplyName="Ibuprofen"
      />
    );
    expect(await offeredBottleIds()).toEqual([22, 11, 33]);
  });
});
