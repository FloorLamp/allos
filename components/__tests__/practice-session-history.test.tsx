import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import PracticeSessionHistory from "@/components/practices/PracticeSessionHistory";
import { overflowMenuLabel } from "@/lib/overflow-menu-label";
import type { PracticeLog } from "@/lib/types";

vi.mock("@/components/Toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/components/ConfirmDialog", () => ({
  useConfirm: () => vi.fn(),
  useConfirmOpen: () => false,
}));
vi.mock("@/components/overlay/AnchoredPanel", () => ({
  default: () => null,
}));
vi.mock("@/app/(app)/wellness/actions", () => ({
  editPracticeSession: vi.fn(),
  removePracticeSession: vi.fn(),
}));
vi.mock("@/app/(app)/undo-actions", () => ({
  undoDelete: vi.fn(),
  undoDeletes: vi.fn(),
}));

const SESSION: PracticeLog = {
  id: 17,
  practice: "Ledger practice",
  date: "2026-08-20",
  start_time: "08:30",
  end_time: null,
  live: 0,
  duration_min: 20,
  notes: null,
  source: null,
  external_id: null,
  edited: 0,
  created_at: "2026-08-20 12:30:00",
};

describe("practice session identity", () => {
  it("names each row and its action menu in the cross-practice ledger", () => {
    render(
      <PracticeSessionHistory sessions={[SESSION]} ledger showPracticeName />
    );

    const row = screen.getByTestId("practice-session-17");
    expect(row.textContent).toContain(
      "Ledger practice · Aug 20, 2026 · 08:30 · 20 min"
    );
    expect(
      within(row).getByRole("button", {
        name: overflowMenuLabel("Ledger practice — Aug 20, 2026", "Session"),
      })
    ).toBeTruthy();
  });

  it("keeps the compact per-practice history free of repeated identity", () => {
    render(<PracticeSessionHistory sessions={[SESSION]} />);

    const row = screen.getByTestId("practice-session-17");
    expect(row.textContent).toContain("Aug 20, 2026 · 08:30 · 20 min");
    expect(row.textContent).not.toContain("Ledger practice");
    expect(
      within(row).getByRole("button", {
        name: overflowMenuLabel("Aug 20, 2026", "Session"),
      })
    ).toBeTruthy();
  });
});
