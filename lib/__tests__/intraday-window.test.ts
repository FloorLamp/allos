import { describe, it, expect } from "vitest";
import {
  formatClockMinute,
  intradayWindowParams,
  parseClockMinute,
  parseIntradayWindow,
  snapToBucket,
  windowFromView,
} from "@/lib/intraday-window";
import { INTRADAY_BUCKET_MINUTES } from "@/lib/intraday";
import { MIN_ZOOM_MINUTES } from "@/lib/intraday-layout";

// The window a day-chart drag states, as it survives a URL (#4950).
//
// The subject is REFUSAL. `historyHref` writes these two params and this reads them, so
// the round trip is a closed loop nobody types by hand — but a URL is shared, bookmarked
// and edited, and the form on the other end submits what it is prefilled with. Every
// case below that returns null is a time the person did not state.

describe("parseClockMinute", () => {
  it.each([
    ["00:00", 0],
    ["09:05", 545],
    ["19:10", 1150],
    ["23:59", 1439],
  ])("reads %s", (input, expected) => {
    expect(parseClockMinute(input)).toBe(expected);
  });

  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["a word", "lunchtime"],
    ["one-digit hour", "9:05"],
    ["one-digit minute", "09:5"],
    ["hour 24", "24:00"],
    ["minute 60", "12:60"],
    ["seconds", "12:30:00"],
    ["negative", "-1:00"],
    ["padded whitespace", " 12:30"],
  ])("refuses %s", (_label, input) => {
    expect(parseClockMinute(input)).toBeNull();
  });

  it("does not fold a malformed clock to midnight the way hhmmToMinutes does", () => {
    // The whole reason this parser exists beside `hhmmToMinutes`: there, 0 is the safe
    // answer because every caller is a window comparison; here it would prefill a form
    // with midnight and say nothing about having invented it.
    expect(parseClockMinute("not-a-time")).toBeNull();
  });
});

describe("snapToBucket", () => {
  it("snaps to the NEAREST bucket, in both directions", () => {
    expect(snapToBucket(1152)).toBe(1150); // 19:12 -> 19:10
    expect(snapToBucket(1153)).toBe(1155); // 19:13 -> 19:15
  });

  it("leaves a clock already on a bucket alone", () => {
    expect(snapToBucket(1150) % INTRADAY_BUCKET_MINUTES).toBe(0);
    expect(snapToBucket(1150)).toBe(1150);
  });

  it("never leaves the day", () => {
    expect(snapToBucket(-30)).toBe(0);
    expect(snapToBucket(24 * 60)).toBe(24 * 60 - 5);
  });
});

describe("parseIntradayWindow", () => {
  it("reads a dragged window and snaps both edges", () => {
    expect(parseIntradayWindow("19:12", "20:41")).toEqual({
      from: 1150, // 19:10
      to: 1240, // 20:40
    });
  });

  it("reads a tap as a start alone", () => {
    expect(parseIntradayWindow("19:10", undefined)).toEqual({
      from: 1150,
      to: null,
    });
  });

  it.each([
    ["an inverted pair", "20:40", "19:10"],
    ["an equal pair", "19:10", "19:10"],
    ["a span under the chart's own minimum", "19:10", "19:15"],
    ["a malformed start", "lunchtime", "20:40"],
    ["a malformed end", "19:10", "whenever"],
    ["an out-of-day start", "24:00", "24:30"],
  ])("drops %s entirely rather than repairing it", (_label, from, to) => {
    expect(parseIntradayWindow(from, to)).toBeNull();
  });

  it("judges the minimum span on the SNAPPED edges, not the raw ones", () => {
    // 19:11 -> 19:10 and 19:21 -> 19:20. The raw span is 10 and passes; the drawn span
    // is 10 and passes too. One minute later on each side is the case that separates
    // them: 19:13 -> 19:15 and 19:22 -> 19:20 inverts once snapped.
    expect(parseIntradayWindow("19:11", "19:21")).toEqual({
      from: 1150,
      to: 1160,
    });
    expect(parseIntradayWindow("19:13", "19:22")).toBeNull();
  });

  it("admits exactly the chart's minimum drag", () => {
    const from = 19 * 60 + 10;
    expect(
      parseIntradayWindow(
        formatClockMinute(from),
        formatClockMinute(from + MIN_ZOOM_MINUTES)
      )
    ).toEqual({ from, to: from + MIN_ZOOM_MINUTES });
  });
});

describe("the round trip closes", () => {
  it.each([
    ["a window", { from: 1150, to: 1240 }],
    ["a start alone", { from: 1150, to: null }],
    ["midnight", { from: 0, to: 30 }],
    ["the last bucket of the day", { from: 1425, to: 1435 }],
  ])("writes %s in the spelling it reads back", (_label, window) => {
    const params = intradayWindowParams(window);
    expect(parseIntradayWindow(params.from, params.to)).toEqual(window);
  });
});

// The amendment's derivation: the window is what the chart already shows (#4950).
describe("windowFromView", () => {
  it("takes the zoomed view as the window", () => {
    expect(
      windowFromView({ from: 19 * 60 + 10, to: 20 * 60 + 40 }, null)
    ).toEqual({ from: 1150, to: 1240 });
  });

  it("prefers the view over the cursor, because a zoom is the more specific answer", () => {
    // A cursor survives inside a zoom; the span the person framed is what they meant.
    expect(
      windowFromView({ from: 19 * 60 + 10, to: 20 * 60 + 40 }, 19 * 60 + 30)
    ).toEqual({ from: 1150, to: 1240 });
  });

  it("takes the crosshair as a start alone at full day", () => {
    expect(windowFromView(null, 19 * 60 + 10)).toEqual({
      from: 1150,
      to: null,
    });
  });

  it("offers nothing when the chart shows nothing", () => {
    expect(windowFromView(null, null)).toBeNull();
  });

  it("snaps both a view and a cursor to the chart's bucket", () => {
    expect(windowFromView({ from: 1152, to: 1241 }, null)).toEqual({
      from: 1150,
      to: 1240,
    });
    expect(windowFromView(null, 1152)).toEqual({ from: 1150, to: null });
  });

  it("refuses a view narrower than the chart's own minimum drag", () => {
    // Zoom cannot produce one, but a wheel or a pinch can land on it. It is not a
    // window, and — as everywhere in this module — it is not widened into one.
    expect(windowFromView({ from: 1150, to: 1155 }, null)).toBeNull();
  });

  it("round-trips through the params, so what the chart shows is what a chip carries", () => {
    const shown = windowFromView(
      { from: 19 * 60 + 10, to: 20 * 60 + 40 },
      null
    );
    const params = intradayWindowParams(shown!);
    expect(parseIntradayWindow(params.from, params.to)).toEqual(shown);
  });
});
