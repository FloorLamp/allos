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
      expect(label?.getAttribute("title")).toBeNull();
      expect(button.getAttribute("title")).toBe(option.title ?? option.label);
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

  it("keeps a truncated link's full label on the interactive element", () => {
    render(
      <SegmentedControl
        options={[
          {
            value: "timeline",
            label: "A long timeline label",
            href: "/timeline",
          },
        ]}
        value="timeline"
        ariaLabel="Timeline view"
        fill
      />
    );

    const link = screen.getByRole("link", { name: "A long timeline label" });
    expect(link.getAttribute("title")).toBe("A long timeline label");
    expect(link.querySelector("span")?.getAttribute("title")).toBeNull();
  });

  it("keeps a disabled fill label visible instead of relying on a tooltip", () => {
    render(
      <SegmentedControl
        options={[
          {
            value: "unavailable",
            label: "A long unavailable range",
            disabled: true,
            title: "Unavailable because this range has no additional data",
          },
        ]}
        value="unavailable"
        onChange={vi.fn()}
        ariaLabel="Available ranges"
        fill
      />
    );

    const button = screen.getByRole("button", {
      name: "A long unavailable range",
    });
    expect(button.getAttribute("disabled")).not.toBeNull();
    expect(button.getAttribute("title")).toBeNull();
    expect(button.querySelector("span")?.className).toContain(
      "whitespace-normal"
    );
    expect(button.querySelector("span")?.className).not.toContain("truncate");
  });
});
