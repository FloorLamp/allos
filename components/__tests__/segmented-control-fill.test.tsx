import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SegmentedControl from "@/components/SegmentedControl";

describe("SegmentedControl fill mode (#3675)", () => {
  const options = [
    {
      value: "train",
      label: "Train",
      accessibleLabel: undefined,
      title: undefined,
    },
    {
      value: "consume",
      label: "A deliberately long Consume label",
      accessibleLabel: "Consume, all recorded values are 0",
      title: "All recorded values are 0",
    },
  ] as const;

  it("owns a filling root and equal, truncating option boxes", () => {
    render(
      <SegmentedControl
        options={[...options]}
        value="train"
        onChange={vi.fn()}
        ariaLabel="Log kind"
        fill
      />
    );

    const group = screen.getByRole("group", { name: "Log kind" });
    expect(group.className).toContain("flex w-full");
    expect(group.className).not.toContain("inline-flex rounded-lg");

    for (const option of options) {
      const button = screen.getByRole("button", {
        name: option.accessibleLabel ?? option.label,
      });
      expect(button.className).toContain("min-w-0 flex-1");
      expect(button.className).not.toContain("shrink-0");
      const label = button.querySelector("span");
      expect(label?.className).toContain("truncate");
      expect(label?.getAttribute("title")).toBe(option.title ?? option.label);
    }
  });

  it("leaves intrinsic consumers' root, option class, and body shape unchanged", () => {
    render(
      <SegmentedControl
        options={[...options]}
        value="train"
        onChange={vi.fn()}
        ariaLabel="Intrinsic kind"
      />
    );

    const group = screen.getByRole("group", { name: "Intrinsic kind" });
    expect(group.className).toContain("inline-flex");
    expect(group.className).not.toContain("flex w-full");
    for (const option of options) {
      const button = screen.getByRole("button", {
        name: option.accessibleLabel ?? option.label,
      });
      expect(button.className).toContain("shrink-0");
      expect(button.className).not.toContain("min-w-0 flex-1");
      expect(button.querySelector("span")).toBeNull();
    }
  });
});
