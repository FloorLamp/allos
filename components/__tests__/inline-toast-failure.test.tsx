import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useInlineToastFailure } from "@/components/useInlineToastFailure";

const toast = vi.fn();
vi.mock("@/components/Toast", () => ({ useToast: () => toast }));

function Harness() {
  const { error, clearError, fail } = useInlineToastFailure();
  return (
    <>
      <button type="button" onClick={() => fail("Fix this field.")}>
        Fail
      </button>
      <button type="button" onClick={clearError}>
        Clear
      </button>
      {error && <p role="alert">{error}</p>}
    </>
  );
}

describe("useInlineToastFailure", () => {
  beforeEach(() => toast.mockClear());

  it("publishes the same failure inline and through the error toast", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Fail" }));
    expect(screen.getByRole("alert").textContent).toBe("Fix this field.");
    expect(toast).toHaveBeenCalledWith("Fix this field.", { tone: "error" });

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
