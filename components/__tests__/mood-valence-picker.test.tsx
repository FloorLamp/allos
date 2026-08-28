import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MoodValencePicker from "@/components/MoodValencePicker";

describe("MoodValencePicker", () => {
  it("renders all five choices through the pressed IconButton contract", () => {
    const onChange = vi.fn();
    render(<MoodValencePicker value={3} onChange={onChange} />);

    const choices = screen.getAllByRole("button");
    expect(choices).toHaveLength(5);
    for (const choice of choices) {
      expect(choice.getAttribute("data-icon-button")).toBe("");
      expect(choice.className).toContain("min-h-(--control-box)");
      expect(choice.className).toContain("min-w-(--control-box)");
    }
    expect(
      screen
        .getByRole("button", { name: "Mood: Okay" })
        .getAttribute("aria-pressed")
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "Mood: Good" })
        .getAttribute("aria-pressed")
    ).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Mood: Good" }));
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(4);
  });
});
