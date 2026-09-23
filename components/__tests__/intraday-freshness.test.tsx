import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import IntradayChart from "@/components/IntradayChart";
import IntradayFreshness from "@/components/IntradayFreshness";
import { TimezoneProvider } from "@/components/TimezoneProvider";
import { DEFAULT_FORMAT_PREFS } from "@/lib/format-date";
import { buildIntradayModel } from "@/lib/intraday";

// #5146: between syncs the lag sentence counts up on the client, and the chart's
// now-line reads the same clock.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
}));

const DAY = "2026-09-03";

// HR 06:00–06:59 (drawn in buckets, the last at 06:55), stamped by the server at 07:22.
const model = (nowMinute: number | null) =>
  buildIntradayModel({
    date: DAY,
    events: [],
    hr: Array.from({ length: 60 }, (_, i) => ({
      ts: `${DAY}T06:${String(i).padStart(2, "0")}`,
      bpm: 62,
    })),
    sleep: [],
    zone2: null,
    nowMinute,
    solarDay: null,
    expectedSleep: null,
  })!;

const renderDay = (nowMinute: number | null) => {
  const m = model(nowMinute);
  render(
    <TimezoneProvider tz="America/New_York">
      <IntradayFreshness model={m} profileId={1} className="" />
      <IntradayChart
        model={m}
        formatPrefs={DEFAULT_FORMAT_PREFS}
        profileId={1}
        className=""
      />
    </TimezoneProvider>
  );
};

const nowLineTitles = () =>
  screen
    .queryAllByTestId("intraday-now")
    .map((line) => line.querySelector("title")?.textContent);

describe("IntradayFreshness (#5146)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 07:22:10 in the profile's zone (EDT), a different wall clock from UTC's.
    vi.setSystemTime(new Date(`${DAY}T11:22:10Z`));
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("counts up with the now-line on one clock", () => {
    renderDay(442);
    const sentence = screen.getByTestId("intraday-freshness");
    expect(sentence.textContent).toBe("Synced 27 min ago");
    expect(nowLineTitles()).toEqual(["Now · 07:22", "Now · 07:22"]);

    act(() => vi.advanceTimersByTime(60_000));
    expect(sentence.textContent).toBe("Synced 28 min ago");
    expect(nowLineTitles()).toEqual(["Now · 07:23", "Now · 07:23"]);
  });

  it("stays silent on a past day", () => {
    renderDay(null);
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.queryByTestId("intraday-freshness")).toBeNull();
    expect(nowLineTitles()).toEqual([]);
  });
});
