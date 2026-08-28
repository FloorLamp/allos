import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import EventCalendar from "@/components/EventCalendar";
import SidebarLogButton from "@/components/SidebarLogButton";
import OverflowMenu, { MENU_ITEM } from "@/components/OverflowMenu";
import DateField from "@/components/DateField";
import { TimezoneProvider } from "@/components/TimezoneProvider";
import { WeekStartProvider } from "@/components/WeekStartProvider";
import { FormatPrefsProvider } from "@/components/FormatPrefsProvider";
import MobileChromeProvider from "@/components/MobileChromeProvider";

// WHAT THE TRIGGER PROMISED, KEPT (#3905). The #3889 refit moved the sidebar's
// calendar and log menu into `AnchoredPanel`, which portals them to <body> —
// under triggers declaring `aria-haspopup="dialog"`, over panels that declared no
// role, carried no name and never took focus. A keyboard user reached five to
// thirty controls only by tabbing past the whole page.
//
// jsdom has no layout, so `offsetParent` is null for every element and
// `focusablesIn`'s visibility filter would find NOTHING here — focus would fall
// back to the panel container and the converse case below could not fail at all
// (measured: with the role check deleted, DateField still kept its focus, for the
// wrong reason). The shim in `beforeEach` gives the filter a laid-out answer so
// each case can name the control focus must actually land on.
//
// No `matchMedia` in this environment, so `useCompactViewport` answers false and
// every case below is the DESKTOP branch — which is the only one with the defect.
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

// The kebab's toast and confirm seams, which are not what is on trial either.
vi.mock("@/components/Toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirmOpen: () => false }));

// The log panel's CONTENT is not what is on trial — its host wiring is. The real
// menu pulls a server action and two more providers in behind it, which would
// make this file a test of QuickLogMenu's dependencies.
vi.mock("@/components/QuickLogMenu", () => ({
  default: () => (
    <button type="button" data-testid="stub-log-row">
      Log food
    </button>
  ),
}));

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  // See the header: an attached element is a laid-out one.
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get(this: HTMLElement) {
      return this.parentElement;
    },
  });
});

function Providers({ children }: { children: React.ReactNode }) {
  return (
    <TimezoneProvider tz="UTC">
      <WeekStartProvider weekStart={0}>
        <FormatPrefsProvider prefs={{ dateFormat: "iso", timeFormat: "24h" }}>
          <MobileChromeProvider>{children}</MobileChromeProvider>
        </FormatPrefsProvider>
      </WeekStartProvider>
    </TimezoneProvider>
  );
}

function ControlledOverflowMenu() {
  const [open, setOpen] = useState(false);
  return (
    <OverflowMenu
      itemName="Vitamin D"
      kind="Supplement"
      open={open}
      onOpenChange={setOpen}
    >
      {() => (
        <button type="button" role="menuitem" className={MENU_ITEM}>
          Edit
        </button>
      )}
    </OverflowMenu>
  );
}

// name → what the trigger promises, and what the panel must therefore be.
const PANELS = [
  {
    what: "the sidebar calendar",
    // Dated well before today so the grid's own month bound leaves the first
    // control — the Previous-month arrow — enabled whenever this runs.
    node: <EventCalendar eventDates={["2020-01-05"]} />,
    trigger: "sidebar-calendar",
    panel: "sidebar-calendar-panel",
    role: "dialog",
    accessibleName: "Calendar",
    firstControl: '[aria-label="Previous month"]',
  },
  {
    what: "the sidebar log panel",
    node: <SidebarLogButton />,
    trigger: "sidebar-log",
    panel: "sidebar-log-panel",
    role: "dialog",
    accessibleName: "Log",
    firstControl: '[data-testid="stub-log-row"]',
  },
  {
    what: "an overflow menu",
    node: <ControlledOverflowMenu />,
    trigger: "overflow-menu-trigger",
    panel: null,
    role: "menu",
    // A menu's name is its trigger's; the panel does not repeat it.
    accessibleName: null,
    firstControl: '[role="menuitem"]',
  },
] as const;

describe("an anchored popover that declares a role (#3905)", () => {
  it.each(PANELS)(
    "$what declares it, names it where a dialog must, and takes focus",
    ({ node, trigger, panel, role, accessibleName, firstControl }) => {
      render(<Providers>{node}</Providers>);
      const button = screen.getByTestId(trigger);
      button.focus();
      expect(document.activeElement).toBe(button);

      fireEvent.click(button);
      const mounted = panel
        ? screen.getByTestId(panel)
        : document.body.querySelector<HTMLElement>(
            '[data-anchored-panel="popover"]'
          )!;
      expect(mounted).toBeTruthy();
      expect(mounted.parentElement).toBe(document.body);
      expect(mounted.getAttribute("role")).toBe(role);
      expect(mounted.getAttribute("aria-label")).toBe(accessibleName);
      // A popover is not a modal: the page behind it stays in play.
      expect(mounted.getAttribute("aria-modal")).toBe(null);
      expect(document.activeElement).toBe(mounted.querySelector(firstControl));

      fireEvent.keyDown(window, { key: "Escape" });
      expect(
        document.body.querySelector('[data-anchored-panel="popover"]')
      ).toBe(null);
      expect(document.activeElement).toBe(button);
    }
  );

  // THE CONVERSE, and it is why the rule is keyed on `role` rather than applied to
  // every popover. DateField opens its calendar when the FIELD takes focus, and
  // manual ISO entry has to keep working at every width (#3376) — a panel that
  // stole focus here would make the field untypable. Its trigger promises no popup
  // and its panel claims no role, so the primitive leaves it alone.
  it("leaves a role-less field popover's focus in the field", () => {
    render(
      <Providers>
        <DateField data-testid="due" />
      </Providers>
    );
    const input = screen.getByTestId("due");
    input.focus();
    fireEvent.focus(input);
    const calendar = screen.getByTestId("date-field-calendar");
    expect(calendar.parentElement).toBe(document.body);
    expect(calendar.getAttribute("role")).toBe(null);
    expect(calendar.querySelector('[aria-label="Month"]')).toBeTruthy();
    expect(document.activeElement).toBe(input);
  });
});
