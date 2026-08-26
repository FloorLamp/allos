import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ClearLogControl from "@/components/ClearLogControl";

const LOG_IDS = [
  ["ai", "ai-log-clear"],
  ["error", "error-log-clear"],
  ["notify", "notify-log-clear"],
] as const;

describe("ClearLogControl", () => {
  it.each(LOG_IDS)("keeps the %s log on its own test IDs", (log, testId) => {
    render(<ClearLogControl log={log} clear={vi.fn()} />);
    const otherIds = LOG_IDS.map(([, id]) => id).filter((id) => id !== testId);

    const initial = screen.getByTestId(testId);
    for (const otherId of otherIds)
      expect(screen.queryByTestId(otherId)).toBeNull();
    fireEvent.click(initial);
    expect(screen.getByTestId(`${testId}-confirm`)).toBeTruthy();
    for (const otherId of otherIds)
      expect(screen.queryByTestId(`${otherId}-confirm`)).toBeNull();
  });

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
