import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import Chip, { type ChipLinkRenderProps } from "@/components/Chip";

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

  it("keeps a custom link renderer inside primitive-owned presentation", () => {
    function CustomLink({
      href,
      className,
      current,
      ariaCurrent,
      children,
    }: ChipLinkRenderProps) {
      return (
        <a
          href={href}
          className={className}
          aria-current={current ? ariaCurrent : undefined}
        >
          {children}
        </a>
      );
    }

    render(
      <Chip
        role="filter"
        href="/timeline"
        current={false}
        LinkComponent={CustomLink}
      >
        30D
      </Chip>
    );

    const link = screen.getByRole("link", { name: "30D" });
    expect(link.className).toBe("chip chip-filter");
    expect(link.hasAttribute("aria-current")).toBe(false);
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
