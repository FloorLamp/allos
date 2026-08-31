import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import DoseBackfillLauncher from "@/components/intake/DoseBackfillLauncher";
import type { DoseLedgerItem } from "@/components/intake/dose-ledger-entry";

vi.mock("@/components/FormatPrefsProvider", () => ({
  useFormatPrefs: () => ({ timeFormat: "24h", dateFormat: "iso" }),
}));

vi.mock("@/components/medications/HistoricalDoseForm", () => ({
  default: ({ onDone }: { onDone: () => void }) => (
    <div data-testid="historical-dose-form">
      <button type="button" onClick={onDone}>
        Cancel
      </button>
    </div>
  ),
}));

const ITEM: DoseLedgerItem = {
  id: 7,
  name: "Creatine",
  kind: "supplement",
  product: null,
  asNeeded: false,
  doses: [{ id: 11, amount: "5 g", time_of_day: "Morning" }],
};

it("keeps the ledger backfill control's identity while its form owns dismissal (#3911)", () => {
  render(
    <DoseBackfillLauncher
      loggable={[ITEM]}
      maxDate="2026-08-30"
      defaultTime="08:00"
    />
  );

  const launcher = screen.getByTestId("dose-ledger-add");
  expect(launcher.textContent).toBe("Log past dose");
  expect(launcher.getAttribute("aria-expanded")).toBe("false");

  fireEvent.click(launcher);
  expect(launcher.textContent).toBe("Log past dose");
  expect(launcher.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByTestId("historical-dose-form")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(launcher.textContent).toBe("Log past dose");
  expect(launcher.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByTestId("historical-dose-form")).toBeNull();
});
