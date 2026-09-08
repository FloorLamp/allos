import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import RouteDayContext from "@/components/RouteDayContext";
import { useOptionalDayContext } from "@/components/DayContext";
import FoodSuggestionsLayout, {
  useFoodSelectedDate,
} from "@/app/(app)/nutrition/FoodSuggestionsLayout";
import type { FoodLogDay } from "@/app/(app)/nutrition/FoodLogBar";

const route = vi.hoisted(() => ({ pathname: "/", query: "" }));
const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  usePathname: () => route.pathname,
  useSearchParams: () => new URLSearchParams(route.query),
  useRouter: () => ({ push }),
}));

function Probe() {
  const day = useOptionalDayContext();
  return (
    <output data-testid="route-day">
      {day ? `${day.parts.day}:${day.backing}` : "undated"}
    </output>
  );
}

beforeEach(() => {
  route.pathname = "/";
  route.query = "";
  push.mockReset();
});

afterEach(() => vi.useRealTimers());

it("keeps Nutrition projection local while the selected date navigates", () => {
  const days = [
    {
      date: "2026-09-07",
      label: "Today",
      counts: {},
      slotCounts: {},
      events: [],
    },
    {
      date: "2026-09-06",
      label: "Yesterday",
      counts: {},
      slotCounts: {},
      events: [],
    },
  ] as unknown as FoodLogDay[];
  function Logger() {
    const selected = useFoodSelectedDate();
    return (
      <button
        type="button"
        onClick={() => selected.setActiveDate(days[1].date)}
      >
        {selected.activeDate}
      </button>
    );
  }
  const layout = (initialDate?: string) => (
    <FoodSuggestionsLayout
      today={days[0].date}
      days={days}
      initialDate={initialDate}
      logger={<Logger />}
      todaySidebar={null}
      weeklySidebar={null}
      suggestionContent={null}
      suggestionCount={0}
    />
  );
  const view = render(layout());
  fireEvent.click(screen.getByRole("button", { name: days[0].date }));
  expect(push).toHaveBeenCalledWith("/nutrition?date=2026-09-06");

  view.rerender(layout(days[1].date));
  expect(screen.getByRole("button", { name: days[1].date })).not.toBeNull();
});

it("refreshes the route day when a persistent layout crosses local midnight", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-07T23:59:59.000Z"));
  route.pathname = "/history";
  route.query = "day=2026-09-08";
  render(
    <RouteDayContext profileId={7} timeZone="UTC">
      <Probe />
    </RouteDayContext>
  );
  expect(screen.getByTestId("route-day").textContent).toBe("2026-09-07:url");

  act(() => vi.advanceTimersByTime(1_100));
  expect(screen.getByTestId("route-day").textContent).toBe("2026-09-08:url");
});

it("provides dated history and Food contexts while Home and supplements stay undated", () => {
  const surface = () => (
    <RouteDayContext profileId={7} timeZone="UTC">
      <Probe />
    </RouteDayContext>
  );
  const view = render(surface());
  expect(screen.getByTestId("route-day").textContent).toBe("undated");

  route.pathname = "/history";
  route.query = "day=2026-09-05";
  view.rerender(surface());
  expect(screen.getByTestId("route-day").textContent).toBe("2026-09-05:url");

  route.pathname = "/nutrition";
  route.query = "date=2026-09-04";
  view.rerender(surface());
  expect(screen.getByTestId("route-day").textContent).toBe("2026-09-04:url");

  route.query = "tab=supplements&date=2026-09-04";
  view.rerender(surface());
  expect(screen.getByTestId("route-day").textContent).toBe("undated");
});
