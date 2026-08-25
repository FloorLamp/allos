import { render, screen } from "@testing-library/react";
import { IconX } from "@tabler/icons-react";
import { describe, expect, it } from "vitest";
import IconButton from "@/components/IconButton";

describe("IconButton", () => {
  it("owns the icon-only name, title, and rendered tap floor", () => {
    render(
      <IconButton
        label="Dismiss sodium guidance"
        tooltip="Dismiss"
        type="submit"
        data-testid="subject"
        tone="amber"
      >
        <IconX data-testid="glyph" />
      </IconButton>
    );

    const button = screen.getByRole("button", {
      name: "Dismiss sodium guidance",
    });
    expect(button.getAttribute("type")).toBe("submit");
    expect(button.getAttribute("title")).toBe("Dismiss");
    expect(button.getAttribute("data-icon-button")).toBe("");
    expect(button.getAttribute("data-tone")).toBe("amber");
    expect(button.className).toContain("min-h-11");
    expect(button.className).toContain("min-w-11");
    expect(button.className).not.toContain("tap-target");
    expect(
      screen.getByTestId("glyph").closest("[aria-hidden='true']")
    ).not.toBeNull();
  });

  it("defaults to a non-submitting button and uses its label as hover text", () => {
    render(
      <IconButton label="Open actions">
        <IconX />
      </IconButton>
    );

    const button = screen.getByRole("button", { name: "Open actions" });
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("title")).toBe("Open actions");
  });
});
