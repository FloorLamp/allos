import { render, screen } from "@testing-library/react";
import type { ComponentPropsWithRef, ComponentType } from "react";
import { describe, expect, it, vi } from "vitest";
import DelegatedCard from "@/components/DelegatedCard";

vi.mock("next/link", () => ({
  default: ({ href, ...props }: ComponentPropsWithRef<"a">) => (
    <a href={String(href)} {...props} />
  ),
}));

describe("DelegatedCard", () => {
  it("renders only direct semantic parts and owns every gutter role", () => {
    render(
      <DelegatedCard labelledBy="card-heading" data-testid="card">
        <DelegatedCard.Header data-testid="header">
          <h2 id="card-heading">Readings</h2>
        </DelegatedCard.Header>
        <DelegatedCard.Cell density="compact" data-testid="compact-cell">
          Compact
        </DelegatedCard.Cell>
        <DelegatedCard.Cell data-testid="standard-cell">
          Standard
        </DelegatedCard.Cell>
        <DelegatedCard.Action data-testid="action">
          <button type="button">More</button>
        </DelegatedCard.Action>
      </DelegatedCard>
    );

    const card = screen.getByTestId("card");
    expect(card.tagName).toBe("SECTION");
    expect(card.getAttribute("aria-labelledby")).toBe("card-heading");
    expect(card.className).toBe("card card-delegated flex items-stretch");
    expect([...card.children]).toEqual([
      screen.getByTestId("header"),
      screen.getByTestId("compact-cell"),
      screen.getByTestId("standard-cell"),
      screen.getByTestId("action"),
    ]);
    expect(screen.getByTestId("header").className).toBe(
      "card-gutter-standard pt-2.5 pb-1 sm:pt-4 sm:pb-3"
    );
    expect(screen.getByTestId("compact-cell").className).toBe(
      "card-gutter-compact pb-2 sm:pb-5"
    );
    expect(screen.getByTestId("standard-cell").className).toBe(
      "card-gutter-standard py-4"
    );
    expect(screen.getByTestId("action").className).toBe(
      "card-gutter-action flex shrink-0 items-center"
    );
  });

  it("makes a destination header the focusable standard-gutter target", () => {
    render(
      <DelegatedCard data-testid="destination-card">
        <DelegatedCard.Header href="/trends" data-testid="destination">
          Trends
        </DelegatedCard.Header>
      </DelegatedCard>
    );

    const card = screen.getByTestId("destination-card");
    const destination = screen.getByRole("link", { name: "Trends" });
    expect(card.tagName).toBe("DIV");
    expect(card.firstElementChild).toBe(destination);
    expect(destination.getAttribute("href")).toBe("/trends");
    expect(destination.className).toContain("card-gutter-standard");
    expect(destination.className).toContain("min-h-14");
    expect(destination.className).toContain("focus-visible:ring-2");
    expect(destination.className).toContain("focus-visible:ring-brand-500");
  });

  it("owns the subdued summary-header treatment", () => {
    render(
      <DelegatedCard data-testid="summary-card">
        <DelegatedCard.Header subdued data-testid="subdued-header">
          Summary
        </DelegatedCard.Header>
      </DelegatedCard>
    );

    expect(screen.getByTestId("subdued-header").className).toBe(
      "card-gutter-standard border-b border-black/10 bg-slate-50/55 py-3.5 dark:border-white/10 dark:bg-ink-900/35"
    );
  });

  it("owns every supported grid column and separator layout", () => {
    const first = "min-w-0";
    const stack = "min-w-0 border-black/10 dark:border-white/10 border-t";
    const sibling = `${stack} sm:border-l sm:border-t-0`;
    const desktopSibling = `${sibling} xl:border-l-0 xl:border-t`;
    const rowSibling = `${stack} sm:border-l`;
    const desktopRowSibling = `${rowSibling} xl:border-l-0`;
    const cases = [
      [1, false, "sm:grid-cols-1", [first]],
      [2, false, "sm:grid-cols-2", [first, sibling]],
      [3, false, "sm:grid-cols-3", [first, sibling, sibling]],
      [4, false, "sm:grid-cols-2", [first, sibling, stack, rowSibling]],
      [1, true, "xl:grid-cols-1 sm:grid-cols-1", [first]],
      [2, true, "xl:grid-cols-1 sm:grid-cols-2", [first, desktopSibling]],
      [
        3,
        true,
        "xl:grid-cols-1 sm:grid-cols-3",
        [first, desktopSibling, desktopSibling],
      ],
      [
        4,
        true,
        "xl:grid-cols-1 sm:grid-cols-2",
        [first, desktopSibling, stack, desktopRowSibling],
      ],
    ] as const;

    for (const [count, desktopStack, columns, borders] of cases) {
      const { unmount } = render(
        <DelegatedCard>
          <DelegatedCard.Grid desktopStack={desktopStack} data-testid="grid">
            {Array.from({ length: count }, (_, index) => (
              <DelegatedCard.Cell key={index} data-testid={`cell-${index}`}>
                {index + 1}
              </DelegatedCard.Cell>
            ))}
          </DelegatedCard.Grid>
        </DelegatedCard>
      );
      const grid = screen.getByTestId("grid");
      expect(grid.className).toBe(`grid grid-cols-1 ${columns}`);
      expect(grid.children).toHaveLength(count);
      for (let index = 0; index < count; index += 1) {
        const cell = screen.getByTestId(`cell-${index}`);
        expect(cell.parentElement).toBe(grid);
        expect(cell.tagName).toBe("ARTICLE");
        expect(cell.className).toBe(borders[index]);
        expect(cell.firstElementChild?.className).toBe(
          "card-gutter-standard py-4"
        );
        expect(
          cell.firstElementChild?.getAttribute("data-delegated-card-gutter")
        ).toBe("standard");
      }
      unmount();
    }
  });

  it("drops spread styling and DOM attributes instead of forwarding an escape hatch", () => {
    const escape = {
      className: "px-8",
      style: { paddingInline: "32px" },
      id: "escaped",
      "aria-label": "escaped",
    };
    render(
      <DelegatedCard {...escape} data-testid="closed-card">
        <DelegatedCard.Header {...escape} data-testid="closed-header">
          Header
        </DelegatedCard.Header>
        <DelegatedCard.Cell {...escape} data-testid="closed-cell">
          Cell
        </DelegatedCard.Cell>
        <DelegatedCard.Action {...escape} data-testid="closed-action">
          Action
        </DelegatedCard.Action>
        <DelegatedCard.Grid {...escape} data-testid="closed-grid">
          <DelegatedCard.Cell {...escape} data-testid="closed-grid-cell">
            Grid cell
          </DelegatedCard.Cell>
        </DelegatedCard.Grid>
      </DelegatedCard>
    );

    for (const testId of [
      "closed-card",
      "closed-header",
      "closed-cell",
      "closed-action",
      "closed-grid",
      "closed-grid-cell",
    ]) {
      const part = screen.getByTestId(testId);
      expect(part.className).not.toContain("px-8");
      expect(part.getAttribute("style")).toBeNull();
      expect(part.getAttribute("id")).toBeNull();
      expect(part.getAttribute("aria-label")).toBeNull();
    }

    type CellProps = Parameters<typeof DelegatedCard.Cell>[0];
    const acceptsCell = (_props: CellProps) => undefined;
    // @ts-expect-error Callers cannot pass a className directly.
    acceptsCell({ children: "Invalid", className: "px-8" });
    // @ts-expect-error Callers cannot pass style directly.
    acceptsCell({ children: "Invalid", style: { padding: 32 } });
  });

  it("rejects caller wrappers instead of interpreting their topology", () => {
    type HeaderProps = Parameters<typeof DelegatedCard.Header>[0];
    const acceptsHeader = (_props: HeaderProps) => undefined;
    // @ts-expect-error A destination cannot select the summary treatment.
    acceptsHeader({
      href: "/trends",
      subdued: true,
      children: "Invalid",
    });
    // @ts-expect-error UrlObjects are not an alternate destination vocabulary.
    acceptsHeader({ href: { pathname: "/trends" }, children: "Invalid" });
    // @ts-expect-error An empty string is not an app destination.
    acceptsHeader({ href: "", children: "Invalid" });
    const UnsafeHeader = DelegatedCard.Header as ComponentType<{
      children: string;
      href?: string;
      subdued?: boolean;
    }>;

    expect(() =>
      render(
        <DelegatedCard>
          <div>
            <DelegatedCard.Cell>Wrapped</DelegatedCard.Cell>
          </div>
        </DelegatedCard>
      )
    ).toThrow(
      "DelegatedCard accepts direct Header, Cell, Action, or Grid children only"
    );

    expect(() =>
      render(
        <DelegatedCard>
          <DelegatedCard.Grid>
            <div>
              <DelegatedCard.Cell>Wrapped</DelegatedCard.Cell>
            </div>
          </DelegatedCard.Grid>
        </DelegatedCard>
      )
    ).toThrow("DelegatedCard.Grid accepts direct Cell children only");

    expect(() =>
      render(
        <DelegatedCard>
          <UnsafeHeader href="/trends" subdued>
            Invalid
          </UnsafeHeader>
        </DelegatedCard>
      )
    ).toThrow("DelegatedCard.Header cannot be subdued and a destination");

    for (const href of ["", "https://example.com"]) {
      expect(() =>
        render(
          <DelegatedCard>
            <UnsafeHeader href={href}>Invalid</UnsafeHeader>
          </DelegatedCard>
        )
      ).toThrow("DelegatedCard.Header requires an internal app route");
    }

    expect(() =>
      render(
        <DelegatedCard>
          <DelegatedCard.Grid>
            <DelegatedCard.Cell density="compact">Invalid</DelegatedCard.Cell>
          </DelegatedCard.Grid>
        </DelegatedCard>
      )
    ).toThrow("DelegatedCard.Grid cells use the standard gutter only");

    expect(() =>
      render(
        <DelegatedCard>
          <DelegatedCard.Grid>{null}</DelegatedCard.Grid>
        </DelegatedCard>
      )
    ).toThrow("DelegatedCard.Grid requires one to four Cell children");

    expect(() =>
      render(
        <DelegatedCard>
          <DelegatedCard.Grid>
            {Array.from({ length: 5 }, (_, index) => (
              <DelegatedCard.Cell key={index}>{index}</DelegatedCard.Cell>
            ))}
          </DelegatedCard.Grid>
        </DelegatedCard>
      )
    ).toThrow("DelegatedCard.Grid requires one to four Cell children");
  });
});
