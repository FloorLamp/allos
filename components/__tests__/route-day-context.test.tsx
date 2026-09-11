import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useState } from "react";
import RouteDayContext, {
  RouteDayBoundary,
} from "@/components/RouteDayContext";
import {
  useLiveProfileDays,
  useOptionalDayContext,
} from "@/components/DayContext";
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

// A GLOBAL MOUNT: a sibling of the page rather than a child of it — where the
// sidebar's `+ Log` panel, the dock sheet, the palette and the shortcut handler
// stand in the shell. #5769's ruling is that these never read the route's day.
function GlobalMountProbe() {
  const day = useOptionalDayContext();
  return (
    <output data-testid="global-mount-day">
      {day ? `${day.parts.day}:${day.backing}` : "undated"}
    </output>
  );
}

function ProfileDayProbe({ profileId }: { profileId: number }) {
  const days = useLiveProfileDays();
  return (
    <output data-testid={`profile-day-${profileId}`}>
      {days.get(profileId)}
    </output>
  );
}

function ChildState() {
  const [value, setValue] = useState("");
  return (
    <input
      aria-label="Persistent child"
      value={value}
      onChange={(event) => setValue(event.target.value)}
    />
  );
}

beforeEach(() => {
  route.pathname = "/";
  route.query = "";
  push.mockReset();
});

afterEach(() => vi.useRealTimers());

it("keeps Nutrition projection local while the selected date navigates", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-07T12:00:00.000Z"));
  const today = {
    date: "2026-09-07",
    label: "Today",
    counts: {},
    slotCounts: {},
    events: [],
  } as unknown as FoodLogDay;
  const earlier = {
    date: "2026-08-20",
    label: "Thu, 2026-08-20",
    counts: { berries: 2 },
    slotCounts: {},
    events: [],
  } as unknown as FoodLogDay;
  const days = [
    {
      ...today,
    },
  ] as unknown as FoodLogDay[];
  function Logger() {
    const selected = useFoodSelectedDate();
    return (
      <>
        <button
          type="button"
          onClick={() => selected.setActiveDate(earlier.date)}
        >
          {selected.activeDate}
        </button>
        <output data-testid="selected-berries">
          {selected.countsByDate[selected.activeDate]?.berries ?? 0}
        </output>
        <button
          type="button"
          onClick={() =>
            selected.setProjection((current) => ({
              ...current,
              countsByDate: {
                ...current.countsByDate,
                [earlier.date]: { berries: 3 },
              },
            }))
          }
        >
          Optimistic serving
        </button>
      </>
    );
  }
  const layout = (offered: FoodLogDay[]) => (
    <RouteDayContext profileId={7} timeZone="UTC">
      <RouteDayBoundary profileId={7} timeZone="UTC">
        <FoodSuggestionsLayout
          today={today.date}
          days={offered}
          logger={<Logger />}
          todaySidebar={null}
          weeklySidebar={null}
          suggestionContent={null}
          suggestionCount={0}
        />
      </RouteDayBoundary>
    </RouteDayContext>
  );
  route.pathname = "/nutrition";
  route.query = "";
  const view = render(layout(days));
  fireEvent.click(screen.getByRole("button", { name: today.date }));
  expect(push).toHaveBeenCalledWith("/nutrition?date=2026-08-20");

  route.query = `date=${earlier.date}`;
  view.rerender(layout([today, earlier]));
  expect(screen.getByTestId("selected-berries").textContent).toBe("2");
  fireEvent.click(screen.getByRole("button", { name: "Optimistic serving" }));
  expect(screen.getByTestId("selected-berries").textContent).toBe("3");
  route.query = `date=${earlier.date}`;
  view.rerender(layout([today, earlier]));
  expect(screen.getByTestId("selected-berries").textContent).toBe("3");
});

it("refreshes the route day when a persistent layout crosses local midnight", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-07T23:59:59.000Z"));
  route.pathname = "/history";
  route.query = "day=2026-09-08";
  render(
    <RouteDayContext profileId={7} timeZone="UTC">
      <RouteDayBoundary profileId={7} timeZone="UTC">
        <Probe />
      </RouteDayBoundary>
    </RouteDayContext>
  );
  expect(screen.getByTestId("route-day").textContent).toBe("2026-09-07:url");

  act(() => vi.advanceTimersByTime(1_100));
  expect(screen.getByTestId("route-day").textContent).toBe("2026-09-08:url");
});

it("owns one live clock for authorized subjects on opposite calendar days", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-07T09:59:59.000Z"));
  render(
    <RouteDayContext
      profileId={7}
      timeZone="UTC"
      profileTimeZones={[
        { profileId: 7, timeZone: "UTC" },
        { profileId: 8, timeZone: "Pacific/Kiritimati" },
      ]}
    >
      <ProfileDayProbe profileId={7} />
      <ProfileDayProbe profileId={8} />
    </RouteDayContext>
  );

  expect(screen.getByTestId("profile-day-7").textContent).toBe("2026-09-07");
  expect(screen.getByTestId("profile-day-8").textContent).toBe("2026-09-07");

  act(() => vi.advanceTimersByTime(1_100));
  expect(screen.getByTestId("profile-day-7").textContent).toBe("2026-09-07");
  expect(screen.getByTestId("profile-day-8").textContent).toBe("2026-09-08");
});

it("rearms through a local midnight gap until the calendar day changes", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2018-11-04T01:59:59.000Z"));
  route.pathname = "/history";
  route.query = "day=2018-11-04";
  render(
    <RouteDayContext profileId={7} timeZone="America/Sao_Paulo">
      <RouteDayBoundary profileId={7} timeZone="America/Sao_Paulo">
        <Probe />
      </RouteDayBoundary>
    </RouteDayContext>
  );
  expect(screen.getByTestId("route-day").textContent).toBe("2018-11-03:url");

  act(() => vi.advanceTimersByTime(1_100));
  expect(screen.getByTestId("route-day").textContent).toBe("2018-11-03:url");
  act(() => vi.advanceTimersByTime(60 * 60 * 1_000));
  expect(screen.getByTestId("route-day").textContent).toBe("2018-11-04:url");
});

it("dates the page's own subtree while global mounts beside it stay undated (#5769)", () => {
  const surface = () => (
    <RouteDayContext profileId={7} timeZone="UTC">
      <GlobalMountProbe />
      <RouteDayBoundary profileId={7} timeZone="UTC">
        <Probe />
        <ChildState />
      </RouteDayBoundary>
    </RouteDayContext>
  );
  const view = render(surface());
  expect(screen.getByTestId("route-day").textContent).toBe("undated");
  expect(screen.getByTestId("global-mount-day").textContent).toBe("undated");
  fireEvent.change(screen.getByRole("textbox", { name: "Persistent child" }), {
    target: { value: "kept" },
  });

  route.pathname = "/history";
  route.query = "day=2026-09-05";
  view.rerender(surface());
  expect(screen.getByTestId("route-day").textContent).toBe("2026-09-05:url");
  // THE WHOLE POINT (#5769): the same render, one level up, has no day at all.
  expect(screen.getByTestId("global-mount-day").textContent).toBe("undated");
  expect(
    (
      screen.getByRole("textbox", {
        name: "Persistent child",
      }) as HTMLInputElement
    ).value
  ).toBe("kept");

  route.pathname = "/nutrition";
  route.query = "date=2026-09-04";
  view.rerender(surface());
  expect(screen.getByTestId("route-day").textContent).toBe("2026-09-04:url");
  expect(screen.getByTestId("global-mount-day").textContent).toBe("undated");

  route.query = "tab=supplements&date=2026-09-04";
  view.rerender(surface());
  expect(screen.getByTestId("route-day").textContent).toBe("undated");

  route.pathname = "/";
  route.query = "";
  view.rerender(surface());
  expect(
    (
      screen.getByRole("textbox", {
        name: "Persistent child",
      }) as HTMLInputElement
    ).value
  ).toBe("kept");

  route.pathname = "/nutrition";
  route.query = "tab=bogus&date=2026-09-04";
  view.rerender(surface());
  expect(screen.getByTestId("route-day").textContent).toBe("2026-09-04:url");

  route.pathname = "/history";
  route.query = "day=2026-02-30";
  view.rerender(surface());
  expect(screen.getByTestId("route-day").textContent).toBe("undated");
});
