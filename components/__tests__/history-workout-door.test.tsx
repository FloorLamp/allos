import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HistoryAddRow from "@/app/(app)/history/HistoryAddRow";
import {
  IntradayInteractionProvider,
  useIntradayInteraction,
} from "@/components/IntradayInteraction";

// THE WORKOUTS DOOR (#4950 item 5). The training log keeps its own editor, so what the
// record's add row owns is the CALL: the day being read, and the window the chart is
// already showing, handed to the shared `openCreate`.
//
// What is asserted is the ARGUMENT, not a rendered field. This lane does not own what
// the training editor does with the clocks — only that it is told the right ones, and
// told NO activity type at all: heart rate cannot tell a run from a sauna.

const opened: unknown[] = [];
let trainingRelevant = true;
vi.mock("@/components/ActivityEditorProvider", () => ({
  useActivityEditor: () => ({
    openCreate: (prefill: unknown) => opened.push(prefill),
    trainingRelevant,
  }),
}));

const CHIPS = [
  {
    kind: "practice" as const,
    label: "Practice",
    params: { kind: "practice" as const, day: "2026-09-03" },
  },
];

// The chart's own two interactions, as controls: a zoom IS the window, and at full day
// a crosshair is a start alone (#4950's amendment).
function Driver() {
  const { setView, setCursor } = useIntradayInteraction();
  return (
    <>
      <button
        data-testid="drive-zoom"
        onClick={() => setView({ from: 19 * 60 + 10, to: 20 * 60 + 40 })}
      />
      <button
        data-testid="drive-cursor"
        onClick={() => setCursor(19 * 60 + 10)}
      />
    </>
  );
}

function row(workoutsDate: string | null): void {
  render(
    <IntradayInteractionProvider>
      <HistoryAddRow
        chips={CHIPS}
        timeFormat="24h"
        workoutsDate={workoutsDate}
      />
      <Driver />
    </IntradayInteractionProvider>
  );
}

const tap = () => fireEvent.click(screen.getByTestId("history-add-workout"));

beforeEach(() => {
  opened.length = 0;
  trainingRelevant = true;
});
afterEach(cleanup);

describe("the record's workouts door", () => {
  it("opens the editor on the day and the window the chart is showing", () => {
    row("2026-09-03");
    fireEvent.click(screen.getByTestId("drive-zoom"));
    tap();
    expect(opened).toEqual([
      { date: "2026-09-03", startTime: "19:10", endTime: "20:40" },
    ]);
  });

  it("carries a start alone from the crosshair, and no end", () => {
    // Inventing an end here would state a length nobody gave, exactly as it would in
    // the practice form.
    row("2026-09-03");
    fireEvent.click(screen.getByTestId("drive-cursor"));
    tap();
    expect(opened).toEqual([
      { date: "2026-09-03", startTime: "19:10", endTime: undefined },
    ]);
  });

  it("opens on the day alone when the chart states no window", () => {
    // The chip renders with or without a window, like every other kind in the row.
    row("2026-09-03");
    tap();
    expect(opened).toEqual([
      { date: "2026-09-03", startTime: undefined, endTime: undefined },
    ]);
  });

  it("never names an activity type", () => {
    row("2026-09-03");
    fireEvent.click(screen.getByTestId("drive-zoom"));
    tap();
    expect(opened[0]).not.toHaveProperty("type");
  });

  it("is not in the row where there is no day", () => {
    // The feed has no chart, so it has no window and no day to open an activity on.
    row(null);
    expect(screen.queryByTestId("history-add-workout")).toBeNull();
  });

  it("offers nothing to a profile that does not train", () => {
    trainingRelevant = false;
    row("2026-09-03");
    expect(screen.queryByTestId("history-add-workout")).toBeNull();
  });
});
