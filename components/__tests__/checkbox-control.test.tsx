import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CheckboxControl from "@/components/CheckboxControl";

describe("CheckboxControl", () => {
  it("keeps the native box controlled inside its fixed associated target", () => {
    const onChange = vi.fn();
    render(
      <CheckboxControl
        label="Select row 1"
        checked={false}
        onChange={onChange}
        data-testid="subject"
      />
    );

    const checkbox = screen.getByRole("checkbox", { name: "Select row 1" });
    const target = checkbox.closest("label");
    expect(target?.className).toBe("checkbox-control");
    expect(target?.getAttribute("data-checkbox-control")).toBe("");
    expect(checkbox.className).toBe("h-4 w-4 accent-brand-600");
    expect((checkbox as HTMLInputElement).checked).toBe(false);
    expect(checkbox.getAttribute("data-testid")).toBe("subject");

    fireEvent.click(target!);
    expect(onChange).toHaveBeenCalledWith(true);
    expect((checkbox as HTMLInputElement).checked).toBe(false);
  });

  it("owns disabled, indeterminate and title metadata", () => {
    const onChange = vi.fn();
    render(
      <CheckboxControl
        label="All Telegram kinds"
        checked={false}
        disabled
        indeterminate
        title="Some Telegram kinds are on"
        onChange={onChange}
      />
    );

    const checkbox = screen.getByRole("checkbox", {
      name: "All Telegram kinds",
    }) as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.indeterminate).toBe(true);
    expect(checkbox.title).toBe("Some Telegram kinds are on");
    expect(onChange).not.toHaveBeenCalled();
  });
});
