/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SharedSupplyCard, {
  type SharedSupplyCardData,
} from "@/app/(app)/supplies/SharedSupplyCard";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import { ToastProvider } from "@/components/Toast";
import type { AlsoForResult } from "@/lib/intake-also-for";
import { medicationHref } from "@/lib/hrefs";

// THE CARD'S HALF OF "ALSO FOR" (#5230). Eligibility itself is derived server-side and
// pinned in the pure and db tiers; what only a mounted card can show is the owner's
// 2026-09-09 source ruling: ONE readable member is NAMED, SEVERAL need an explicit pick
// with nothing preselected, and the action stays disabled until there is one.

const alsoForAction = vi.fn(
  async (_posted: FormData): Promise<AlsoForResult> => ({
    ok: true,
    receipt: "Added for Ada · 200 mg from the adult label dose",
    href: medicationHref(9),
  })
);

vi.mock("@/app/(app)/supplies/actions", () => ({
  alsoForAction: (fd: FormData) => alsoForAction(fd),
  updatePoolAction: vi.fn(async () => ({ ok: true })),
  deletePoolAction: vi.fn(async () => ({ ok: true })),
}));

const MIRA = {
  itemId: 11,
  profileId: 2,
  personName: "Mira",
  scheduleLabel: "Daily · Morning, Evening",
};
const DUNE = {
  itemId: 12,
  profileId: 3,
  personName: "Dune",
  scheduleLabel: "As needed · Anytime",
};
const ADA = {
  profileId: 4,
  name: "Ada",
  basisBySource: { 11: "basis-mira", 12: "basis-dune" },
};

function card(over: Partial<SharedSupplyCardData> = {}): SharedSupplyCardData {
  return {
    id: 7,
    name: "Ibuprofen",
    strength: "200 mg",
    form: "tablet",
    notes: null,
    quantityOnHand: 40,
    lowSupplyDays: null,
    thresholdDays: 10,
    daysLeft: 20,
    low: false,
    orphaned: false,
    memberCount: 1,
    hiddenMemberCount: 0,
    members: [],
    alsoFor: { sources: [MIRA], offers: [ADA] },
    canWrite: true,
    ...over,
  };
}

function mount(data: SharedSupplyCardData) {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <SharedSupplyCard pool={data} />
      </ConfirmProvider>
    </ToastProvider>
  );
}

beforeEach(() => {
  alsoForAction.mockClear();
});

describe("the offer names the plan it will copy", () => {
  it("names the one readable member and its schedule, and acts on one tap", async () => {
    mount(card());
    expect(
      screen.getByTestId("shared-supply-also-for-source").textContent
    ).toBe("Copying Mira’s schedule · Daily · Morning, Evening");
    // Nothing to choose, so nothing to choose from.
    expect(screen.queryByTestId("shared-supply-also-for-select")).toBeNull();

    const chip = screen.getByTestId("shared-supply-also-for-chip");
    expect(chip.textContent).toBe("Ada · Also for");
    expect((chip as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(chip);
    await waitFor(() => expect(alsoForAction).toHaveBeenCalledTimes(1));
    const posted = alsoForAction.mock.calls[0][0];
    expect(posted.get("profile_id")).toBe("4");
    expect(posted.get("source_item_id")).toBe("11");
    expect(posted.get("source_profile_id")).toBe("2");
    // The basis of the SOURCE that was actually shown, so the write can refuse a
    // stale one instead of resolving it to somebody else's plan.
    expect(posted.get("basis")).toBe("basis-mira");

    await waitFor(() =>
      expect(
        screen.getByTestId("shared-supply-also-for-receipt").textContent
      ).toContain("Added for Ada · 200 mg from the adult label dose")
    );
  });

  it("preselects nothing when members disagree, and stays disabled until a pick", async () => {
    mount(card({ alsoFor: { sources: [MIRA, DUNE], offers: [ADA] } }));
    const select = screen.getByTestId("shared-supply-also-for-select");
    // NOT the first SQL row, and not the acting profile.
    expect((select as HTMLSelectElement).value).toBe("");
    const chip = screen.getByTestId("shared-supply-also-for-chip");
    expect((chip as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(chip);
    expect(alsoForAction).not.toHaveBeenCalled();

    fireEvent.change(select, { target: { value: "12" } });
    expect((chip as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(chip);
    await waitFor(() => expect(alsoForAction).toHaveBeenCalledTimes(1));
    const posted = alsoForAction.mock.calls[0][0];
    expect(posted.get("source_item_id")).toBe("12");
    expect(posted.get("basis")).toBe("basis-dune");
  });

  it("asks for a pick even when the two schedules read the same", () => {
    mount(
      card({
        alsoFor: {
          sources: [MIRA, { ...DUNE, scheduleLabel: MIRA.scheduleLabel }],
          offers: [ADA],
        },
      })
    );
    expect(
      (screen.getByTestId("shared-supply-also-for-select") as HTMLSelectElement)
        .value
    ).toBe("");
    expect(
      (screen.getByTestId("shared-supply-also-for-chip") as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });

  it("offers nothing when nobody is eligible, and nothing with no readable source", () => {
    const first = mount(card({ alsoFor: { sources: [MIRA], offers: [] } }));
    expect(screen.queryByTestId("shared-supply-also-for")).toBeNull();
    first.unmount();

    mount(card({ alsoFor: { sources: [], offers: [ADA] } }));
    expect(screen.queryByTestId("shared-supply-also-for")).toBeNull();
  });

  it("reports a refusal instead of claiming an add", async () => {
    alsoForAction.mockResolvedValueOnce({
      ok: false,
      error: "This offer changed. Reload the cabinet and try again.",
    });
    mount(card());
    fireEvent.click(screen.getByTestId("shared-supply-also-for-chip"));
    await waitFor(() =>
      expect(screen.getByText(/This offer changed/)).toBeTruthy()
    );
    expect(screen.queryByTestId("shared-supply-also-for-receipt")).toBeNull();
  });
});

describe("past a chip count the card falls back to a select", () => {
  it("offers one verb over a person selector, with nothing preselected", async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      profileId: 20 + i,
      name: `Person ${i}`,
      basisBySource: { 11: `basis-${i}` },
    }));
    mount(card({ alsoFor: { sources: [MIRA], offers: many } }));
    expect(screen.getAllByTestId("shared-supply-also-for-chip")).toHaveLength(
      1
    );
    const people = screen.getByTestId(
      "shared-supply-also-for-person"
    ) as HTMLSelectElement;
    expect(people.value).toBe("");
    const chip = screen.getByTestId(
      "shared-supply-also-for-chip"
    ) as HTMLButtonElement;
    expect(chip.disabled).toBe(true);

    fireEvent.change(people, { target: { value: "23" } });
    expect(chip.disabled).toBe(false);
    fireEvent.click(chip);
    await waitFor(() => expect(alsoForAction).toHaveBeenCalledTimes(1));
    const posted = alsoForAction.mock.calls[0][0];
    expect(posted.get("profile_id")).toBe("23");
    expect(posted.get("basis")).toBe("basis-3");
  });
});
