import { render, screen } from "@testing-library/react";
import { IconX } from "@tabler/icons-react";
import { describe, expect, it } from "vitest";
import IconButton from "@/components/IconButton";

describe("IconButton", () => {
  it("owns the icon-only name and rendered tap floor", () => {
    render(
      <IconButton
        label="Dismiss sodium guidance"
        type="submit"
        data-testid="subject"
        tone="amber"
        pressed
        tabIndex={-1}
      >
        <IconX data-testid="glyph" />
      </IconButton>
    );

    const button = screen.getByRole("button", {
      name: "Dismiss sodium guidance",
    });
    expect(button.getAttribute("type")).toBe("submit");
    expect(button.getAttribute("title")).toBeNull();
    expect(button.getAttribute("data-icon-button")).toBe("");
    expect(button.getAttribute("data-tone")).toBe("amber");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.getAttribute("tabindex")).toBe("-1");
    // The control box, not a self-rendered 44 (#3938): an icon-only round target
    // renders the box and takes the rest of the floor as contained reach.
    expect(button.className).toContain("min-h-(--control-box)");
    expect(button.className).toContain("min-w-(--control-box)");
    expect(button.className).toContain("aria-pressed:bg-brand-50");
    expect(button.className).toContain("tap-target");
    expect(
      screen.getByTestId("glyph").closest("[aria-hidden='true']")
    ).not.toBeNull();
  });

  it("defaults to a non-submitting button", () => {
    render(
      <IconButton label="Open actions">
        <IconX />
      </IconButton>
    );

    const button = screen.getByRole("button", { name: "Open actions" });
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("title")).toBeNull();
  });
});
