import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import MeasurementsQuickAdd from "@/app/(app)/trends/MeasurementsQuickAdd";

// #4425 — A REFUSED DAY REACHES THE PERSON, not just the result type.
//
// `addMeasurements` answers with NOTICES, not errors, so before this issue a refused
// day came back as `{}` — byte-identical to a clean save that stated no time — and
// this form toasted "Measurements saved" and reset over an empty table. The action
// tier pins that the refusal is now ANSWERED
// (lib/__action_tests__/measurements.actions.test.ts); this tier is the other half,
// because a result field nothing renders is the same false success wearing a struct.

const toasted: string[] = [];
const saved: { dateRefused?: true }[] = [];

vi.mock("@/components/Toast", () => ({
  useToast: () => (text: string) => {
    toasted.push(text);
  },
}));
vi.mock("@/components/OfflineQueueProvider", () => ({
  useOfflineQueue: () => ({ enqueue: vi.fn() }),
}));
vi.mock("@/components/LoggedViaSurface", () => ({
  useLoggedViaStamp: () => (fd: FormData) => fd,
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/(app)/trends/measurement-actions", () => ({
  addMeasurements: async () => saved.shift() ?? {},
}));

beforeEach(() => {
  toasted.length = 0;
  saved.length = 0;
});

function submitAWeightOn(day: string): Promise<void> {
  fireEvent.change(screen.getByTestId("m-date"), { target: { value: day } });
  fireEvent.change(screen.getByLabelText(/weight/i), {
    target: { value: "80" },
  });
  return act(async () => {
    fireEvent.submit(screen.getByTestId("measurements-quick-add"));
  });
}

describe("a day the cores refuse is said out loud (#4425)", () => {
  it("shows the refusal and does not claim the measurements saved", async () => {
    saved.push({ dateRefused: true });
    render(<MeasurementsQuickAdd defaultDate="2026-05-20" weightUnit="kg" />);

    await submitAWeightOn("2026-05-21");

    expect(screen.getByRole("alert").textContent).toContain(
      "hasn't happened yet"
    );
    expect(toasted).toEqual([]);
    // The day the sentence is ABOUT is still on the form beside it — the date is React
    // state, so it survives the action reset that clears the number fields. Read off
    // the hidden field that actually posts, not off the control's rendered label.
    expect(
      screen
        .getByTestId("measurements-quick-add")
        .querySelector<HTMLInputElement>('input[name="date"]')?.value
    ).toBe("2026-05-21");
  });

  // The converse through the SAME submit, so the branch cannot pass by refusing every
  // save: an ordinary answer still toasts and still clears.
  it("still confirms an ordinary save", async () => {
    saved.push({});
    render(<MeasurementsQuickAdd defaultDate="2026-05-20" weightUnit="kg" />);

    await submitAWeightOn("2026-05-20");

    expect(screen.queryByRole("alert")).toBeNull();
    expect(toasted).toEqual(["Measurements saved"]);
  });
});
