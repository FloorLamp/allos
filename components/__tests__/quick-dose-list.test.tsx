import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LoggedViaSurface } from "@/components/LoggedViaSurface";
import QuickDoseList from "@/components/quick-entry/QuickDoseList";

const actions = vi.hoisted(() => ({ markTaken: vi.fn() }));
const toast = vi.hoisted(() => vi.fn());
vi.mock("@/app/(app)/upcoming/actions", () => ({
  markTaken: actions.markTaken,
}));
vi.mock("@/components/Toast", () => ({ useToast: () => toast }));

describe("QuickDoseList", () => {
  it("posts Mark taken through Button with its pending state", async () => {
    const result = Promise.withResolvers<{
      ok: true;
      outcome: "logged";
    }>();
    actions.markTaken.mockReturnValueOnce(result.promise);
    const onDone = vi.fn();
    render(
      <LoggedViaSurface value="quick-log">
        <QuickDoseList
          doses={[
            {
              doseId: 42,
              title: "Vitamin D",
              detail: "1 tablet",
              dueText: "Due now",
            },
          ]}
          onDone={onDone}
        />
      </LoggedViaSurface>
    );

    const button = screen.getByRole("button", { name: "Mark taken" });
    expect(button.className).toBe("button-control");
    expect(button.getAttribute("data-button-control")).toBe("");
    fireEvent.click(button);

    await waitFor(() => expect(actions.markTaken).toHaveBeenCalledOnce());
    const submitted = actions.markTaken.mock.calls[0][0] as FormData;
    expect([submitted.get("dose_id"), submitted.get("logged_via")]).toEqual([
      "42",
      "quick-log",
    ]);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.querySelector('svg[aria-hidden="true"]')).not.toBeNull();

    await act(async () => result.resolve({ ok: true, outcome: "logged" }));
    expect(onDone).toHaveBeenCalledOnce();
  });
});
