import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import TimeRangeFields from "@/components/TimeRangeFields";
import { FormatPrefsProvider } from "@/components/FormatPrefsProvider";

// THE LABEL PAIR AND OVERNIGHT MODE (#4976 ruling + item 2). Two claims from the
// issue's acceptance criteria, both about the pair as a black box:
// - the label pair is content, defaulting to "Start"/"End" and overridable per host;
// - in `overnight` mode the SAME 22:32 -> 06:22 pair that a default-mode host
//   refuses is accepted and reports its span as "7h 50m".
//
// jsdom has no layout/matchMedia beyond the tier's stand-in, same as
// time-field.test.tsx, so the picker mounts in its desktop host — irrelevant here,
// since nothing below opens the wheel.
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

/** A host holding the pair like a real form, with the props under test threaded
 *  through — everything else fixed to values that don't matter to these assertions. */
function Host({
  startTime: initialStart,
  endTime: initialEnd,
  timeError = false,
  overnight = false,
  startLabel,
  endLabel,
}: {
  startTime: string;
  endTime: string;
  timeError?: boolean;
  overnight?: boolean;
  startLabel?: string;
  endLabel?: string;
}) {
  const [startTime, setStartTime] = useState(initialStart);
  const [endTime, setEndTime] = useState(initialEnd);
  return (
    <FormatPrefsProvider prefs={{ dateFormat: "iso", timeFormat: "24h" }}>
      <TimeRangeFields
        idPrefix="t"
        startTime={startTime}
        endTime={endTime}
        tz="UTC"
        timeError={timeError}
        derivableDurationMin={null}
        overnight={overnight}
        startLabel={startLabel}
        endLabel={endLabel}
        onStartTime={setStartTime}
        onEndTime={setEndTime}
      />
    </FormatPrefsProvider>
  );
}

describe("TimeRangeFields — label pair (#4976 ruling)", () => {
  it("defaults to Start/End when no labels are given", () => {
    render(<Host startTime="09:00" endTime="10:00" />);
    expect(screen.getByLabelText("Start")).toBeTruthy();
    expect(screen.getByLabelText("End")).toBeTruthy();
  });

  it("takes a content label pair, e.g. Bed time / Wake time", () => {
    render(
      <Host
        startTime="22:00"
        endTime="06:00"
        overnight
        startLabel="Bed time"
        endLabel="Wake time"
      />
    );
    expect(screen.getByLabelText("Bed time")).toBeTruthy();
    expect(screen.getByLabelText("Wake time")).toBeTruthy();
    expect(screen.queryByLabelText("Start")).toBeNull();
    expect(screen.queryByLabelText("End")).toBeNull();
  });
});

describe("TimeRangeFields — overnight mode (#4976 item 2)", () => {
  it("accepts an End before Start and reports the span, where default mode refuses it", () => {
    const { rerender } = render(
      <FormatPrefsProvider prefs={{ dateFormat: "iso", timeFormat: "24h" }}>
        <TimeRangeFields
          idPrefix="t"
          startTime="22:32"
          endTime="06:22"
          tz="UTC"
          timeError={true}
          derivableDurationMin={null}
          overnight
          onStartTime={() => {}}
          onEndTime={() => {}}
        />
      </FormatPrefsProvider>
    );
    // Accepted: no refusal text, the span is reported instead.
    expect(
      screen.queryByText("End time must be after the start time.")
    ).toBeNull();
    expect(screen.getByTestId("time-range-span").textContent).toBe("7h 50m");

    // Same pair, `overnight` off: the host's own `timeError` (unchanged input,
    // still computed the ordinary way) refuses it exactly as it always has.
    rerender(
      <FormatPrefsProvider prefs={{ dateFormat: "iso", timeFormat: "24h" }}>
        <TimeRangeFields
          idPrefix="t"
          startTime="22:32"
          endTime="06:22"
          tz="UTC"
          timeError={true}
          derivableDurationMin={null}
          overnight={false}
          onStartTime={() => {}}
          onEndTime={() => {}}
        />
      </FormatPrefsProvider>
    );
    expect(
      screen.getByText("End time must be after the start time.")
    ).toBeTruthy();
    expect(screen.queryByTestId("time-range-span")).toBeNull();
  });

  it("refuses a same-instant pair in overnight mode instead of reporting a zero span", () => {
    render(<Host startTime="22:00" endTime="22:00" overnight />);
    expect(
      screen.getByText("Bed and wake can’t be the same time.")
    ).toBeTruthy();
    expect(screen.queryByTestId("time-range-span")).toBeNull();
  });

  it("shows neither the span nor a refusal until both clocks are set", () => {
    render(<Host startTime="22:00" endTime="" overnight />);
    expect(screen.queryByTestId("time-range-span")).toBeNull();
    expect(
      screen.queryByText("Bed and wake can’t be the same time.")
    ).toBeNull();
  });
});
