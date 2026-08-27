import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { OverflowMenuSubmitItem } from "@/components/OverflowMenu";

describe("OverflowMenuSubmitItem", () => {
  it("owns menu semantics and pending form submission", async () => {
    const result = Promise.withResolvers<void>();
    const action = vi.fn((_data: FormData) => result.promise);

    render(
      <form action={action}>
        <input type="hidden" name="id" value="42" />
        <OverflowMenuSubmitItem pendingLabel="Removing…">
          Remove condition
        </OverflowMenuSubmitItem>
      </form>
    );

    const item = screen.getByRole("menuitem", { name: "Remove condition" });
    expect(item.getAttribute("type")).toBe("submit");
    fireEvent.click(item);

    await waitFor(() => expect(action).toHaveBeenCalledOnce());
    expect(action.mock.calls[0][0].get("id")).toBe("42");
    const pending = screen.getByRole("menuitem", { name: "Removing…" });
    expect(pending.getAttribute("aria-busy")).toBe("true");
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    expect(pending.querySelector("svg")).not.toBeNull();

    await act(async () => result.resolve());
  });
});
