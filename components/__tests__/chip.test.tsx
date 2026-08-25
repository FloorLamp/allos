import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import Chip from "@/components/Chip";
import ChipGroup from "@/components/ChipGroup";

describe("Chip", () => {
  it("binds navigation paint to current link semantics", () => {
    render(
      <Chip role="nav" href="/records" current testId="subject">
        Records
      </Chip>
    );

    const link = screen.getByRole("link", { name: "Records" });
    expect(link.getAttribute("href")).toBe("/records");
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(link.className).toBe("chip chip-nav");
  });

  it("binds filter paint and disabled behavior to button semantics", () => {
    const onClick = vi.fn();
    render(
      <Chip role="filter" density="dense" pressed disabled onClick={onClick}>
        Breakfast
      </Chip>
    );

    const button = screen.getByRole("button", { name: "Breakfast" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.className).toBe("chip chip-filter chip-sm");
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("gives dense links and buttons the same primitive-owned floor", () => {
    render(
      <>
        <Chip role="nav" density="dense" href="/records" current={false}>
          Records
        </Chip>
        <Chip role="filter" density="dense" pressed={false}>
          Active
        </Chip>
      </>
    );

    expect(screen.getByRole("link").className).toContain("chip-sm");
    expect(screen.getByRole("button").className).toContain("chip-sm");
  });

  it("uses location semantics for current hash navigation", () => {
    render(
      <Chip role="nav" href="#details" current>
        Details
      </Chip>
    );

    const link = screen.getByRole("link", { name: "Details" });
    expect(link.getAttribute("aria-current")).toBe("location");
  });

  it("keeps timeline behavior behind the primitive-owned adapter", () => {
    render(
      <Chip role="filter" href="/timeline" current linkBehavior="timeline">
        30D
      </Chip>
    );

    const link = screen.getByRole("link", { name: "30D" });
    expect(link.className).toBe("chip chip-filter");
    expect(link.getAttribute("aria-current")).toBe("true");
    expect(link.getAttribute("data-testid")).toBeNull();
  });

  it("keeps the visible label in an enriched accessible name", () => {
    render(
      <Chip
        role="filter"
        pressed={false}
        accessibleLabel="Speed, all recorded values are 0"
      >
        Speed
      </Chip>
    );

    expect(
      screen.getByRole("button", {
        name: "Speed, all recorded values are 0",
      }).textContent
    ).toContain("Speed");
  });
});

describe("ChipGroup", () => {
  it("derives a single-choice group from domain options", () => {
    const onSelect = vi.fn();
    render(
      <ChipGroup
        label="Pose"
        density="dense"
        value="front"
        onSelect={onSelect}
        options={[
          { value: "front", label: "Front", testId: "front" },
          {
            value: "side",
            label: "Side",
            disabled: true,
            data: { "data-pose": "side" },
          },
        ]}
      />
    );

    expect(screen.getByRole("group", { name: "Pose" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Front" }).getAttribute("aria-pressed")
    ).toBe("true");
    const side = screen.getByRole("button", { name: "Side" });
    expect(side.getAttribute("aria-pressed")).toBe("false");
    expect(side.getAttribute("data-pose")).toBe("side");
    expect((side as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Front" }));
    expect(onSelect).toHaveBeenCalledWith("front");
  });
});
