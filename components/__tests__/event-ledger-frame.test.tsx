import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import EventLedgerFrame from "@/components/ledger/EventLedgerFrame";
import type { AppRoute } from "@/lib/hrefs";

// THE SHARED FRAME'S OWN ORDERING (#3484 part 2, inheriting #3478 item 3).
//
// The rule this pins — "empty, the STATE leads and the backfill slot follows it;
// populated, the slot keeps its place above rows that are actually there" — used to
// live inside the bespoke dose shell, where the only tier that could see it was a
// phone-width Playwright run against a dedicated fixture profile. It is now a
// property of the frame every ledger mounts, so it is worth a cheaper guard than a
// browser: this is the component tier's stated purpose, a claim about one component's
// markup that jsdom renders exactly as a browser does
// (docs/internals/component-tests.md).
//
// The e2e still runs and still matters — it proves the REAL page, over the real
// Server/Client boundary, with real rows. What it cannot do is fail in two seconds
// when the next mount of this frame reorders the slot.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/medications/dose-history",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: ReactNode;
  }) => (
    <a href={String(href)} {...rest}>
      {children}
    </a>
  ),
  useLinkStatus: () => ({ pending: false }),
}));

// ScrollFade (the chip row's masked scroller) measures with a ResizeObserver, which
// jsdom does not implement. The stub is the same one AnalyzePicker's test installs.
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

const HREF = "/medications/dose-history" as AppRoute;

function mount(over: { empty: boolean; backfill?: ReactNode; note?: string }) {
  // `"note" in over` and not `??`: one case here states NO window, and a default
  // applied to an explicitly-absent note would quietly test the other case.
  const note =
    "note" in over ? over.note : "Showing probe events from Aug 1 to Aug 23.";
  return render(
    <EventLedgerFrame
      idPrefix="probe-ledger"
      back={{ href: HREF, label: "Back to medications" }}
      title="Probe history"
      basePath="/medications/dose-history"
      range={{ from: "2026-08-01", to: "2026-08-23" }}
      todayStr="2026-08-23"
      buildRangeHref={() => HREF}
      chips={{
        options: [
          { value: "all", label: "All", href: HREF },
          { value: "one", label: "One", href: HREF },
        ],
        value: "all",
        label: "Filter the probe ledger",
      }}
      itemFilter={{
        options: [{ id: 7, label: "Probe item" }],
        value: undefined,
      }}
      pagination={{
        page: 1,
        pageCount: 2,
        pageSize: 10,
        total: 14,
        visibleCount: 10,
        prevHref: null,
        nextHref: HREF,
      }}
      empty={over.empty}
      note={note}
      emptyNote="No probe events yet. Widen the date range."
      backfill={over.backfill}
      footer={<p data-testid="probe-footer">footer</p>}
    >
      <div data-testid="probe-rows">rows</div>
    </EventLedgerFrame>
  );
}

/** The rendered order of the ledger body's parts, read from the DOM. */
function bodyOrder(): string[] {
  const body = screen.getByTestId("probe-ledger");
  return [...body.querySelectorAll("[data-testid]")].map(
    (n) => n.getAttribute("data-testid") ?? ""
  );
}

/**
 * How many boxes the body actually contains, which the id order above cannot see: an
 * omitted slot and an EMPTY slot wrapper produce the same list of test ids and a
 * different amount of vertical space.
 */
function bodyChildCount(): number {
  return screen.getByTestId("probe-ledger").children.length;
}

describe("the event-ledger frame's body order", () => {
  it("leads with the state when the page is empty, and puts the backfill slot after it", () => {
    mount({
      empty: true,
      backfill: <button data-testid="probe-backfill">Log past thing</button>,
    });

    const order = bodyOrder();
    expect(order).toEqual(["probe-ledger-empty", "probe-backfill"]);
    expect(bodyChildCount()).toBe(2);
    // The empty sentence carries the window; the populated note is NOT also printed,
    // which is the stacking #3478 removed.
    expect(screen.getByTestId("probe-ledger-empty")).toHaveProperty(
      "textContent",
      "No probe events yet. Widen the date range."
    );
    expect(screen.queryByTestId("probe-ledger-window-note")).toBeNull();
    // And an empty page renders no rows — the mount's children are for rows that exist.
    expect(screen.queryByTestId("probe-rows")).toBeNull();
  });

  it("puts the backfill slot first when there are rows, then the window note, then the rows", () => {
    mount({
      empty: false,
      backfill: <button data-testid="probe-backfill">Log past thing</button>,
    });

    // THE CONTROL for the absence assertion above: the identical mount that DOES
    // reach every part. If this order ever equalled the empty one, the test above
    // would be reporting a harness that never rendered a backfill slot at all.
    expect(bodyOrder()).toEqual([
      "probe-backfill",
      "probe-ledger-window-note",
      "probe-rows",
    ]);
    expect(screen.queryByTestId("probe-ledger-empty")).toBeNull();
  });

  it("omits the backfill slot entirely for a mount that supplies none", () => {
    // A reader with no write reach on the profile gets rows and no slot — not an
    // empty box where the slot was.
    mount({ empty: false });
    expect(bodyOrder()).toEqual(["probe-ledger-window-note", "probe-rows"]);
    // Nothing stands in for the slot. A wrapper rendered around `null` costs the
    // reader a margin and shows up nowhere in the id order above.
    expect(bodyChildCount()).toBe(2);
  });

  it("omits the window note when the mount states no window", () => {
    mount({ empty: false, note: undefined });
    expect(bodyOrder()).toEqual(["probe-rows"]);
    expect(bodyChildCount()).toBe(1);
  });
});

describe("the event-ledger frame names every part off one prefix", () => {
  it("derives the page, body, chip, item, pager and note ids from idPrefix", () => {
    // Two ledgers whose pagers answered to different ids would be two frames again
    // as far as any spec or census is concerned. A mount passes ONE prefix and gets
    // the whole naming scheme; it cannot name the frame's internals itself.
    mount({ empty: false });
    for (const id of [
      "probe-ledger-page",
      "probe-ledger",
      "probe-ledger-kind-filter",
      "probe-ledger-item-filter",
      "probe-ledger-window-note",
      "probe-ledger-pagination",
    ])
      expect(screen.getByTestId(id), id).toBeTruthy();
  });

  it("hangs the mount's footer off the page, below the ledger card", () => {
    // The footer is the mount's own aside — a cross-link to the same question asked
    // as a chart, say. It belongs to the PAGE, not to the card: inside the card it
    // reads as part of the record rather than as a way onward. Asserted as its
    // parent, because "not inside the rows" is also true of a footer tucked into the
    // card beside the pager.
    mount({ empty: false });
    const footer = screen.getByTestId("probe-footer");
    expect(footer.parentElement).toBe(screen.getByTestId("probe-ledger-page"));
  });
});
