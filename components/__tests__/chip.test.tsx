import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import Chip from "@/components/Chip";
import FilterPills from "@/components/FilterPills";
import { dateRangeFilterModel } from "@/components/DateRangeControl";

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
    expect(link.className).toBe("chip-base chip-nav");
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
    expect(button.className).toBe("chip-base chip-filter chip-sm");
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
    expect(link.className).toBe("chip-base chip-filter");
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

describe("FilterPills", () => {
  it("keeps an extra range labelled __all distinct from All time", () => {
    const extra = [{ label: "__all", from: "2026-01-01", to: "2026-01-02" }];
    const allTime = dateRangeFilterModel({}, extra);
    expect(allTime.value).toBe(null);
    expect(allTime.options[0]?.value).toBe(0);

    const selectedExtra = dateRangeFilterModel(
      { from: "2026-01-01", to: "2026-01-02" },
      extra
    );
    expect(selectedExtra.value).toBe(0);
  });

  it("owns Timeline's phone-scroll to sm-wrap layout", () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      }
    );
    render(
      <FilterPills
        mode="link"
        layout="responsive"
        label="Timeline category"
        value="all"
        options={[{ value: "all", label: "All", href: "/timeline" }]}
      />
    );

    const group = screen.getByRole("group", { name: "Timeline category" });
    expect(group.className).toContain("overflow-x-auto");
    expect(group.className).toContain("-mx-2");
    expect(group.className).toContain("sm:mx-0");
    expect(group.className).toContain("sm:flex-wrap");
    expect(group.className).toContain("sm:overflow-visible");
    vi.unstubAllGlobals();
  });

  it("keeps null All distinct from a real __all option", () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <FilterPills
        mode="button"
        layout="wrap"
        label="Photo series"
        value={null}
        onSelect={onSelect}
        options={[
          { value: null, label: "All" },
          { value: "__all", label: "Series named __all" },
        ]}
      />
    );

    const all = screen.getByRole("button", { name: "All" });
    const named = screen.getByRole("button", { name: "Series named __all" });
    expect(all.getAttribute("aria-pressed")).toBe("true");
    expect(named.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(named);
    expect(onSelect).toHaveBeenCalledWith("__all");

    rerender(
      <FilterPills
        mode="button"
        layout="wrap"
        label="Photo series"
        value="__all"
        onSelect={onSelect}
        options={[
          { value: null, label: "All" },
          { value: "__all", label: "Series named __all" },
        ]}
      />
    );
    expect(all.getAttribute("aria-pressed")).toBe("false");
    expect(named.getAttribute("aria-pressed")).toBe("true");
  });

  it("derives current state for a whole link group", () => {
    render(
      <FilterPills
        mode="link"
        layout="wrap"
        label="Status"
        value="active"
        options={[
          { value: "all", label: "All", href: "/records" },
          { value: "active", label: "Active", href: "/timeline" },
        ]}
      />
    );

    expect(
      screen.getByRole("link", { name: "Active" }).getAttribute("aria-current")
    ).toBe("true");
    expect(
      screen.getByRole("link", { name: "All" }).hasAttribute("aria-current")
    ).toBe(false);
  });

  it("derives a single-choice group from domain options", () => {
    const onSelect = vi.fn();
    render(
      <FilterPills
        mode="button"
        layout="wrap"
        label="Pose"
        density="dense"
        value="front"
        onSelect={onSelect}
        options={[
          { value: "front", label: "Front", testId: "front" },
          {
            value: "side",
            label: "Side",
            content: <span>Side pose</span>,
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
