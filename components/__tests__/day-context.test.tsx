import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useState } from "react";
import BoundedDaySwitcher from "@/components/BoundedDaySwitcher";
import { DayContextProvider, useDayContext } from "@/components/DayContext";
import { FormatPrefsProvider } from "@/components/FormatPrefsProvider";
import { SHEET_REACH } from "@/lib/log-manifest";
import { historyDayHref } from "@/lib/hrefs";

function CurrentDay() {
  const context = useDayContext();
  return (
    <output data-testid="current-day">
      {context.parts.day}:{context.isPrimaryDay ? "primary" : "past"}
    </output>
  );
}

describe("the shared bounded day context", () => {
  it("moves every consumer together and links past its offered window", () => {
    render(
      <FormatPrefsProvider prefs={{ dateFormat: "iso", timeFormat: "24h" }}>
        <DayContextProvider
          profileId={7}
          today="2026-09-07"
          reach={SHEET_REACH}
          backing={{ kind: "state", initialDay: "2026-09-07" }}
        >
          <BoundedDaySwitcher />
          <CurrentDay />
        </DayContextProvider>
      </FormatPrefsProvider>
    );

    expect(screen.getByTestId("current-day").textContent).toBe(
      "2026-09-07:primary"
    );
    fireEvent.click(screen.getByTestId("day-context-2"));
    expect(screen.getByTestId("current-day").textContent).toBe(
      "2026-09-05:past"
    );
    expect(
      screen.getByRole("link", { name: "Earlier…" }).getAttribute("href")
    ).toBe(historyDayHref("2026-09-04"));
  });

  it("refuses a state day outside its declared reach", () => {
    function OutOfReachAttempt() {
      const context = useDayContext();
      return (
        <>
          <CurrentDay />
          <button type="button" onClick={() => context.select?.("2026-09-04")}>
            Select unavailable day
          </button>
        </>
      );
    }

    render(
      <DayContextProvider
        profileId={7}
        today="2026-09-07"
        reach={SHEET_REACH}
        backing={{ kind: "state", initialDay: "2026-09-05" }}
      >
        <OutOfReachAttempt />
      </DayContextProvider>
    );
    expect(screen.getByTestId("current-day").textContent).toBe(
      "2026-09-05:past"
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Select unavailable day" })
    );
    expect(screen.getByTestId("current-day").textContent).toBe(
      "2026-09-05:past"
    );
  });

  it("takes a URL-backed day from its controlled route value", () => {
    const renderDay = (day: string) => (
      <DayContextProvider
        profileId={7}
        today="2026-09-07"
        reach={{ kind: "dated" }}
        backing={{
          kind: "url",
          day,
          hrefForDay: historyDayHref,
        }}
      >
        <CurrentDay />
      </DayContextProvider>
    );
    const view = render(renderDay("2026-09-05"));
    expect(screen.getByTestId("current-day").textContent).toBe(
      "2026-09-05:past"
    );
    view.rerender(renderDay("2026-09-06"));
    expect(screen.getByTestId("current-day").textContent).toBe(
      "2026-09-06:past"
    );
  });

  it("drops a selected day when a later today moves it outside reach", () => {
    function Draft() {
      const [value, setValue] = useState("");
      return (
        <input
          aria-label="Draft"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      );
    }
    const renderToday = (today: string) => (
      <DayContextProvider
        profileId={7}
        today={today}
        reach={SHEET_REACH}
        backing={{ kind: "state", initialDay: "2026-09-07" }}
      >
        <BoundedDaySwitcher />
        <CurrentDay />
        <Draft />
      </DayContextProvider>
    );
    const view = render(renderToday("2026-09-07"));
    fireEvent.click(screen.getByTestId("day-context-1"));
    expect(screen.getByTestId("current-day").textContent).toBe(
      "2026-09-06:past"
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Draft" }), {
      target: { value: "kept" },
    });

    view.rerender(renderToday("2026-09-08"));
    // Yesterday advanced, but the selected day is still inside the two-day reach.
    expect(screen.getByTestId("current-day").textContent).toBe(
      "2026-09-06:past"
    );
    expect(
      (screen.getByRole("textbox", { name: "Draft" }) as HTMLInputElement).value
    ).toBe("kept");

    view.rerender(renderToday("2026-09-09"));
    expect(screen.getByTestId("current-day").textContent).toBe(
      "2026-09-07:past"
    );
  });
});
