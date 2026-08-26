import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CreatedShareLink from "@/components/CreatedShareLink";

function clipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

describe("CreatedShareLink", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("owns the one-time notice, selectable value, copy receipt, and timer cleanup", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    clipboard(writeText);
    const value = "https://allos.test/share/secret";
    const view = render(<CreatedShareLink value={value} />);

    expect(
      screen.getByText(/copy it now.*won’t be shown again/i)
    ).not.toBeNull();
    const input = screen.getByRole("textbox", { name: "Created share link" });
    expect(input.getAttribute("readonly")).not.toBeNull();

    const copy = screen.getByRole("button", { name: "Copy link" });
    expect(copy.getAttribute("data-button-control")).toBe("");
    await act(async () => fireEvent.click(copy));
    expect(writeText).toHaveBeenCalledWith(value);
    expect(screen.getByRole("status").textContent).toBe("Link copied.");
    act(() => vi.advanceTimersByTime(1_499));
    expect(screen.getByRole("status").textContent).toBe("Link copied.");
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("status").textContent).toBe("");

    await act(async () => fireEvent.click(copy));
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("selects the value and explains manual copy when clipboard access fails", async () => {
    clipboard(vi.fn().mockRejectedValue(new Error("clipboard unavailable")));
    const value = "https://allos.test/share/manual";
    render(<CreatedShareLink value={value} />);

    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Copy link" }))
    );

    const input = screen.getByRole("textbox", { name: "Created share link" });
    expect(document.activeElement).toBe(input);
    expect((input as HTMLInputElement).selectionStart).toBe(0);
    expect((input as HTMLInputElement).selectionEnd).toBe(value.length);
    expect(screen.getByRole("status").textContent).toMatch(/selected.*manual/i);
  });
});
