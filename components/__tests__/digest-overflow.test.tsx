import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import DigestOverflow from "@/app/(app)/trends/DigestOverflow";

describe("DigestOverflow", () => {
  it("reveals its overflow children from the collapsed disclosure", () => {
    render(
      <DigestOverflow total={4}>
        <span data-testid="digest-overflow-child">Fourth trend</span>
      </DigestOverflow>
    );

    const toggle = screen.getByTestId("digest-show-all");
    expect(toggle.textContent).toBe("Show all 4");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("digest-overflow-child")).toBeNull();

    fireEvent.click(toggle);

    expect(toggle.textContent).toBe("Show fewer");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("digest-overflow-child").textContent).toBe(
      "Fourth trend"
    );
  });
});
