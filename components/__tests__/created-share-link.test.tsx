import { act, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
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

  it("survives StrictMode and owns copy, fallback, exact receipt, and cleanup", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    clipboard(writeText);
    const value = "https://allos.test/share/secret";
    const view = render(
      <StrictMode>
        <CreatedShareLink value={value} />
      </StrictMode>
    );

    expect(screen.getByText(/won’t be shown again/i)).not.toBeNull();
    const input = screen.getByRole("textbox", { name: "Created share link" });
    expect(input.getAttribute("readonly")).not.toBeNull();

    const copy = screen.getByRole("button", { name: "Copy link" });
    await act(async () => fireEvent.click(copy));
    expect(writeText).toHaveBeenCalledWith(value);
    expect(screen.getByRole("status").textContent).toBe("Link copied.");
    act(() => vi.advanceTimersByTime(1_499));
    expect(screen.getByRole("status").textContent).toBe("Link copied.");
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("status").textContent).toBe("");

    writeText.mockRejectedValueOnce(new Error("clipboard unavailable"));
    await act(async () => fireEvent.click(copy));
    expect(document.activeElement).toBe(input);
    expect((input as HTMLInputElement).selectionStart).toBe(0);
    expect((input as HTMLInputElement).selectionEnd).toBe(value.length);
    expect(screen.getByRole("status").textContent).toMatch(/selected.*manual/i);
    act(() => vi.runOnlyPendingTimers());

    await act(async () => fireEvent.click(copy));
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores stale completion and invalidates a pending latest attempt on unmount", async () => {
    const old = Promise.withResolvers<void>();
    const last = Promise.withResolvers<void>();
    const write = vi.fn();
    write.mockReturnValueOnce(old.promise).mockReturnValueOnce(last.promise);
    clipboard(write);
    const view = render(<CreatedShareLink value="/share/race" />);

    const copy = screen.getByRole("button", { name: "Copy link" });
    fireEvent.click(copy);
    fireEvent.click(copy);
    await act(async () => last.resolve());
    expect(screen.getByRole("status").textContent).toBe("Link copied.");
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => old.resolve());
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
