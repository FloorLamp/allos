import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ClearLogControl from "@/components/ClearLogControl";

describe("ClearLogControl", () => {
  it("owns confirmation, focus, pending, completion, failure, and cancel", async () => {
    const failure = Promise.withResolvers<void>();
    const retryFailure = Promise.withResolvers<void>();
    const success = Promise.withResolvers<void>();
    const clear = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(failure.promise)
      .mockReturnValueOnce(retryFailure.promise)
      .mockReturnValueOnce(success.promise);
    const onCleared = vi.fn();
    render(<ClearLogControl log="ai" clear={clear} onCleared={onCleared} />);
    const initial = screen.getByTestId("ai-log-clear");
    expect(initial.textContent).toBe("Clear");
    fireEvent.click(initial);
    let confirm = screen.getByTestId("ai-log-clear-confirm");
    expect(document.activeElement).toBe(confirm);
    fireEvent.click(confirm);
    expect(confirm.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")
    ).toBe(true);
    expect(confirm.textContent).toBe("Clearing…");
    await act(async () => failure.reject(new Error("failed")));
    expect(confirm.hasAttribute("disabled")).toBe(false);
    expect(document.activeElement).toBe(confirm);
    expect(onCleared).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe(
      "Couldn't clear the log. Try again."
    );

    fireEvent.click(confirm);
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => retryFailure.reject(new Error("failed again")));
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("ai-log-clear"));

    fireEvent.click(screen.getByTestId("ai-log-clear"));
    confirm = screen.getByTestId("ai-log-clear-confirm");
    fireEvent.click(confirm);
    await act(async () => success.resolve());
    expect(onCleared).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("ai-log-clear"));
  });
});
