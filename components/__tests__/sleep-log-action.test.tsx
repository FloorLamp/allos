import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SleepLogAction from "@/app/(app)/sleep/SleepLogAction";

vi.mock("@/app/(app)/sleep/SleepMoodEditDialog", () => ({
  default: ({ onClose }: { onClose: () => void }) => (
    <div role="dialog" aria-label="Sleep and mood entry">
      <button type="button" onClick={onClose}>
        Close editor
      </button>
    </div>
  ),
}));

describe("SleepLogAction", () => {
  it("uses the ordinary Button treatment and keeps the dialog behavior", () => {
    render(
      <SleepLogAction
        history={[]}
        today="2026-08-25"
        minDate="2026-05-28"
        testId="sleep-add-entry"
      />
    );

    const action = screen.getByRole("button", { name: "Add entry" });
    expect(action.getAttribute("type")).toBe("button");
    expect(action.getAttribute("data-testid")).toBe("sleep-add-entry");
    expect(action.getAttribute("data-button-control")).toBe("");
    expect(
      screen.queryByRole("dialog", { name: "Sleep and mood entry" })
    ).toBeNull();

    fireEvent.click(action);
    expect(
      screen.getByRole("dialog", { name: "Sleep and mood entry" })
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
    expect(
      screen.queryByRole("dialog", { name: "Sleep and mood entry" })
    ).toBeNull();
  });

  // RANK IS THE PAGE'S DECISION, NOT THIS COMPONENT'S (#3982). The same component
  // renders the page header's action — filled `btn btn-sm` until #3759 converged
  // it — and two mounts that were LINK-styled, inside the stale card and mid
  // sentence in the empty state. It forwards the variant and picks nothing.
  it.each([
    { mount: "the page header", variant: "primary", filled: true },
    { mount: "the stale and empty states", variant: undefined, filled: false },
  ] as const)("carries $mount's rank", ({ variant, filled }) => {
    render(
      <SleepLogAction
        history={[]}
        today="2026-08-25"
        minDate="2026-05-28"
        testId="sleep-add-entry"
        variant={variant}
      />
    );
    expect(
      screen
        .getByTestId("sleep-add-entry")
        .classList.contains("button-control-primary")
    ).toBe(filled);
  });
});
