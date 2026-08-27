import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DuplicateResolutionActions from "@/components/DuplicateResolutionActions";

describe("DuplicateResolutionActions", () => {
  it("owns the complete pair action vocabulary and dispatches keeper choices", () => {
    const handlers = [vi.fn(), vi.fn(), vi.fn(), vi.fn()] as const;
    render(
      <DuplicateResolutionActions
        actions={[
          ["keeper", "Strava", handlers[0]],
          ["alternate-keeper", "Manual entry", handlers[1]],
          ["keep-both", null, handlers[2], {}],
          ["dismiss", null, handlers[3], {}],
        ]}
      />
    );

    const actions = screen.getByTestId("duplicate-resolution-actions");
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Merge, keep Strava",
      "Keep Manual entry instead",
      "Keep both",
      "Dismiss",
    ]);
    expect(actions.querySelectorAll("svg")).toHaveLength(3);
    expect(screen.getByTestId("dup-merge-secondary").textContent).toContain(
      "Manual entry"
    );
    for (const button of buttons) fireEvent.click(button);
    for (const handler of handlers) expect(handler).toHaveBeenCalledOnce();
  });

  it("owns cluster copy and disables every action while its controller is pending", () => {
    render(
      <DuplicateResolutionActions
        pending
        actions={[
          ["cluster-keeper", 4, vi.fn()],
          ["keep-all", null, vi.fn()],
          ["dismiss", null, vi.fn()],
        ]}
      />
    );

    const buttons = screen.getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Merge 4 into keeper",
      "Keep all",
      "Dismiss",
    ]);
    for (const button of buttons)
      expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("posts the local server-form controller and its exact payload", async () => {
    const result = Promise.withResolvers<void>();
    const submitted: Record<string, FormDataEntryValue>[] = [];
    const merge = vi.fn(async (formData: FormData) => {
      submitted.push(Object.fromEntries(formData.entries()));
      await result.promise;
    });

    render(
      <DuplicateResolutionActions
        actions={[
          [
            "keeper",
            "A",
            merge,
            { keep_id: 7, drop_id: 9, signature: "activity:7:9" },
          ],
          ["alternate-keeper", "B", vi.fn(), {}],
          ["keep-both", null, vi.fn(), {}],
          ["dismiss", null, vi.fn(), {}],
        ]}
      />
    );

    const button = screen.getByRole("button", { name: "Merge, keep A" });
    fireEvent.click(button);
    await waitFor(() => expect(merge).toHaveBeenCalledOnce());
    expect(submitted).toEqual([
      { keep_id: "7", drop_id: "9", signature: "activity:7:9" },
    ]);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await act(async () => result.resolve());
  });
});
