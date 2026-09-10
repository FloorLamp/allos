import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import HistoryAddRow from "@/app/(app)/history/HistoryAddRow";
import type { HistoryAddVocabulary } from "@/app/(app)/history/HistoryAddDoor";
import {
  IntradayInteractionProvider,
  useIntradayInteraction,
} from "@/components/IntradayInteraction";
import type { WeeklyRhythm } from "@/lib/weekly-rhythm";

// The add row says what it would write into, and hands it to the form it opens (#4950,
// #5618 ruling 1).
//
// The #4950 amendment deleted the chip and the armed mode: the window is what the chart
// is already showing. #5618 deleted the LINK — a chip was `?kind=`, so tapping one
// filtered the record away and left a second button to press. So what is asserted here
// is the DERIVATION reaching the label AND the door's props: no gesture, no mode, no
// navigation, and one chip disclosed at a time.
//
// THE DOOR IS STUBBED, AND ONLY THE DOOR. The row's whole job is now to decide which
// chip is pressed and what that chip's form opens on; the forms themselves, and every
// payload they post, are `history-add-door.test.tsx`'s subject and are not re-mocked
// here. The stub is a real button with the real trigger testid, so the row's own
// composition — the label first, the chips in the server's order — is still the thing
// being rendered.
vi.mock("@/app/(app)/history/HistoryAddDoor", async () => {
  const { createElement } = await import("react");
  return {
    default: ({
      kind,
      label,
      open,
      onOpen,
      onClose,
      date,
      window,
      defaultPractice,
    }: {
      kind: string;
      label: string;
      open: boolean;
      onOpen: () => void;
      onClose: () => void;
      date: string;
      window: { from: string; to?: string } | null;
      defaultPractice: string | null;
    }) =>
      createElement(
        "button",
        {
          type: "button",
          "data-testid": `history-add-open-${kind}`,
          "aria-expanded": open,
          "data-date": date,
          "data-window": window
            ? `${window.from}${window.to ? `–${window.to}` : ""}`
            : "",
          "data-default-practice": defaultPractice ?? "",
          onClick: () => (open ? onClose() : onOpen()),
        },
        label
      ),
  };
});

// The driver renders CONTROLS rather than publishing setters into module scope: a
// reassignment during render is a side effect (and `react-hooks/globals` says so), and
// clicking is what the chart's own gestures do anyway.
function Driver() {
  const { setView, setCursor, setPin } = useIntradayInteraction();
  return (
    <>
      <button
        data-testid="drive-zoom"
        onClick={() => setView({ from: 19 * 60 + 10, to: 20 * 60 + 40 })}
      />
      <button
        data-testid="drive-zoom-empty"
        onClick={() => setView({ from: 0, to: 0 })}
      />
      <button data-testid="drive-cursor" onClick={() => setCursor(20 * 60)} />
      <button data-testid="drive-pin" onClick={() => setPin(19 * 60 + 10)} />
      <button data-testid="drive-leave" onClick={() => setCursor(null)} />
    </>
  );
}

const drive = (what: "zoom" | "zoom-empty" | "cursor" | "pin" | "leave") =>
  fireEvent.click(screen.getByTestId(`drive-${what}`));

const DAY = "2026-09-03";

const CHIPS = [
  { kind: "practice" as const, label: "Practices" },
  { kind: "food" as const, label: "Food" },
];

// Enough vocabulary to satisfy the door's prop type; the stub reads none of it.
const VOCABULARY = {
  practices: ["Sauna", "Rowing"],
  substances: [],
  symptoms: [],
  doseItems: [],
  doseDefaultTime: "08:00",
  measurements: {
    form: "measurements",
    defaultDate: DAY,
    defaultStatedAt: null,
    maxDate: DAY,
    profileId: 7,
    weightUnit: "kg",
    temperatureUnit: "C",
    showCompositionEntry: true,
    showGrowth: false,
    showHeadCirc: false,
  },
  moodDay: { date: DAY, label: "Sep 3", mood: null },
  moodShowCalm: false,
  foodSlotBoundaries: { midday: 660, evening: 1020 },
} as unknown as HistoryAddVocabulary;

// A Thursday-evening habit whose usual length is the zoomed span (#4950 item 4).
const EVENING: WeeklyRhythm = {
  weekdays: [0, 1, 2, 3, 4, 5, 6],
  hour: 19,
  hasPattern: true,
};

const row = (timeFormat: "24h" | "12h" = "24h") => (
  <IntradayInteractionProvider>
    <Driver />
    <HistoryAddRow
      chips={CHIPS}
      timeFormat={timeFormat}
      date={DAY}
      maxDate={DAY}
      vocabulary={VOCABULARY}
      practiceCandidates={[
        { name: "Sauna", rhythm: EVENING, usualDurationMin: 90 },
      ]}
    />
  </IntradayInteractionProvider>
);

const chip = (kind: string) => screen.getByTestId(`history-add-open-${kind}`);
const windowOf = (kind: string) => chip(kind).getAttribute("data-window");

afterEach(cleanup);

describe("the add row and the chart's window", () => {
  it("says only Add, and hands no window to any form, when the chart shows nothing", () => {
    render(row());
    expect(screen.getByTestId("history-add-label").textContent).toBe("Add");
    expect(windowOf("practice")).toBe("");
    expect(windowOf("food")).toBe("");
  });

  it("names the zoomed span and opens every kind's form on it", () => {
    render(row());
    drive("zoom");
    expect(screen.getByTestId("history-add-label").textContent).toBe(
      "Add at 19:10–20:40"
    );
    for (const kind of ["practice", "food"]) {
      expect(windowOf(kind)).toBe("19:10–20:40");
    }
  });

  it("names the pinned start and keeps hover out of the label and the forms", () => {
    render(row());
    drive("cursor");
    const label = screen.getByTestId("history-add-label");
    expect(label.textContent).toBe("Add");
    expect(windowOf("practice")).toBe("");
    drive("pin");
    expect(label.textContent).toBe("Add at 19:10");
    // A start alone is a whole answer: no end is invented for it.
    expect(windowOf("practice")).toBe("19:10");
    drive("leave");
    expect(label.textContent).toBe("Add at 19:10");
    expect(windowOf("practice")).toBe("19:10");
    // Explicitly requested by #5386 for the clock-bearing label.
    expect(label.classList.contains("tabular-nums")).toBe(true);
  });

  it("clears with the view, because the zoom reset is the only clearing path", () => {
    render(row());
    drive("zoom");
    expect(screen.getByTestId("history-add-label").textContent).not.toBe("Add");
    drive("zoom-empty");
    // A zero-width view is not a window; `windowFromView` refuses it rather than
    // repairing it, so the row falls back to saying nothing.
    expect(screen.getByTestId("history-add-label").textContent).toBe("Add");
    expect(windowOf("practice")).toBe("");
  });

  it("prints the clocks in the login's own format", () => {
    render(row("12h"));
    drive("zoom");
    expect(screen.getByTestId("history-add-label").textContent).toBe(
      "Add at 7:10 PM–8:40 PM"
    );
  });

  it("opens each form on the day being read, whatever the chart is showing", () => {
    render(row());
    expect(chip("practice").getAttribute("data-date")).toBe(DAY);
    drive("zoom");
    expect(chip("food").getAttribute("data-date")).toBe(DAY);
  });

  it("offers the practice the window looks like, and none without a window", () => {
    render(row());
    expect(chip("practice").getAttribute("data-default-practice")).toBe("");
    drive("zoom");
    expect(chip("practice").getAttribute("data-default-practice")).toBe(
      "Sauna"
    );
  });
});

// #5618 ruling 1: "a kind chip opens its form in place and never narrows the record."
describe("a kind chip is a disclosure, not a filter", () => {
  it("is a button that reads pressed while its form is open", () => {
    render(row());
    const practice = chip("practice");
    // NOT A LINK. The chip was `<a href="?kind=practice">`, and following it is what
    // filtered every other row off the page before any form appeared.
    expect(practice.tagName).toBe("BUTTON");
    expect(practice.getAttribute("href")).toBeNull();
    expect(practice.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(practice);
    expect(chip("practice").getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(chip("practice"));
    expect(chip("practice").getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps every other chip in the row, and only one of them open", () => {
    render(row());
    fireEvent.click(chip("practice"));
    // The row does not swap for a single door: the siblings are still there, which is
    // the half of the defect that made the whole page change.
    expect(chip("food")).toBeTruthy();
    fireEvent.click(chip("food"));
    expect(chip("food").getAttribute("aria-expanded")).toBe("true");
    expect(chip("practice").getAttribute("aria-expanded")).toBe("false");
  });
});
