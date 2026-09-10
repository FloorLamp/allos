import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import FrequencyTargets from "@/app/(app)/training/FrequencyTargets";

// THE WEEKLY-TARGETS EDITOR IS ONE SURFACE, AND IT HAS ONE LOUD CONTROL (#4978).
// Selecting a chip loads that target into the fold and reveals a Delete beside the
// form's `primary` Save — the only state in `app/(app)/training` where a
// destructive control shares a surface with a commit.
//
// Ruling 5 (2026-09-09 20:05 UTC) named this Delete and filled it. Ruling 10
// (2026-09-10 01:30 UTC) then narrowed the filled danger to a STANDALONE
// destructive action and to the CONFIRM STEP, because a filled danger spends the
// surface's loud-control budget. This Delete is neither: Save is right beside it,
// so two fills here is what ruling 10 forbids. The fill it gives up is not lost —
// `remove()` opens a confirm whose destructive button stays filled, and that
// dialog is a `z-110` overlay rather than a control on this card, so ruling 6's
// two-fills-on-one-card carve-out is not reached.
//
// Asserted as the form's loud budget by LABEL rather than per control: the claim
// is that Save is the only fill, which couples the commit's rank to its
// neighbour's quiet and fails for exactly one reason. A per-control assertion
// cannot see a second fill arriving beside the one it checks, and a document-wide
// count answers for surfaces this test is not about.
//
// Asserted on the RENDERED class, not the call site. `ButtonProps` is closed and
// `Button` destructures every prop by name with no rest spread, so a rank that
// stopped being forwarded would typecheck, lint, and still paint wrong.
vi.mock("@/app/(app)/training/frequency-actions", () => ({
  createFrequencyTarget: () => {
    throw new Error("this test does not submit domain actions");
  },
  deleteFrequencyTarget: () => {
    throw new Error("this test does not submit domain actions");
  },
}));
vi.mock("@/components/ConfirmDialog", () => ({
  useConfirm: () => async () => false,
}));
vi.mock("@/components/Toast", () => ({ useToast: () => () => {} }));

// Both loud paints, scoped to the form, by label.
function loudIn(surface: HTMLElement): string[] {
  return [
    ...surface.querySelectorAll(
      ".button-control-primary, .button-control-danger"
    ),
  ].map((el) => el.textContent?.trim() ?? "");
}

const items = [
  {
    id: 7,
    label: "Chest",
    count: 1,
    perWeek: 2,
    pace: "on-pace" as const,
    scopeKind: "region" as const,
    scopeValue: "Chest",
  },
];

afterEach(cleanup);

// Selecting the chip is the only route to the editing state, so the fold is
// opened the way a person opens it rather than by reaching into state.
function openEditor(): HTMLElement {
  render(<FrequencyTargets items={items} />);
  fireEvent.click(screen.getByTestId("weekly-target-chip"));
  const del = screen.getByRole("button", { name: "Delete" });
  return del.closest("form") as HTMLElement;
}

describe("the weekly-target editor's loud budget (#4978 ruling 10)", () => {
  it("fills the commit and nothing else once Delete is on the surface", () => {
    const form = openEditor();
    expect(
      loudIn(form),
      "ruling 10: the danger shares this surface with Save, so only the commit is loud"
    ).toEqual(["Save"]);
  });

  it("keeps Delete on the primitive at secondary rank, not a red-tinted ghost", () => {
    openEditor();
    const del = screen.getByRole("button", { name: "Delete" });
    expect(del.getAttribute("data-button-control")).toBe("");
    expect(del.className).toContain("button-control");
    // Ruling 5's other half still stands: no red-tinted ghost exists to spell a
    // quiet destructive action, so going quiet means the ordinary secondary paint.
    expect(del.className).not.toMatch(/text-rose|btn-danger/);
  });
});
