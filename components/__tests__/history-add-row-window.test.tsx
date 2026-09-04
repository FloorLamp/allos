import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import HistoryAddRow from "@/app/(app)/history/HistoryAddRow";
import {
  IntradayInteractionProvider,
  useIntradayInteraction,
} from "@/components/IntradayInteraction";

// The add row says what it would write into, and its chips carry it (#4950).
//
// The amendment deleted the chip and the armed mode: the window is what the chart is
// already showing. So what is asserted here is the DERIVATION reaching the label and the
// hrefs — no gesture, no mode, and the params the page's own rules produced arriving
// unchanged with two keys added.

// The driver renders CONTROLS rather than publishing setters into module scope: a
// reassignment during render is a side effect (and `react-hooks/globals` says so), and
// clicking is what the chart's own gestures do anyway.
function Driver() {
  const { setView, setCursor } = useIntradayInteraction();
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
      <button
        data-testid="drive-cursor"
        onClick={() => setCursor(19 * 60 + 10)}
      />
    </>
  );
}

const drive = (what: "zoom" | "zoom-empty" | "cursor") =>
  fireEvent.click(screen.getByTestId(`drive-${what}`));

const CHIPS = [
  {
    kind: "practice" as const,
    label: "Practice",
    params: { day: "2026-09-03", kind: "practice" as const },
  },
  {
    kind: "food" as const,
    label: "Food",
    params: { day: "2026-09-03", kind: "food" as const, class: undefined },
  },
];

const row = () => (
  <IntradayInteractionProvider>
    <Driver />
    <HistoryAddRow chips={CHIPS} timeFormat="24h" />
  </IntradayInteractionProvider>
);

const href = (kind: string) =>
  screen.getByTestId(`history-add-${kind}`).getAttribute("href")!;

afterEach(cleanup);

describe("the add row and the chart's window", () => {
  it("says only Add, and carries no window, when the chart shows nothing", () => {
    render(row());
    expect(screen.getByTestId("history-add-label").textContent).toBe("Add");
    expect(href("practice")).not.toContain("from=");
    expect(href("practice")).not.toContain("to=");
  });

  it("names the zoomed span and carries it on every chip", () => {
    render(row());
    drive("zoom");
    expect(screen.getByTestId("history-add-label").textContent).toBe(
      "Add at 19:10–20:40"
    );
    for (const kind of ["practice", "food"]) {
      expect(href(kind)).toContain("from=19%3A10");
      expect(href(kind)).toContain("to=20%3A40");
    }
  });

  it("names the crosshair as a start alone at full day, with no end", () => {
    render(row());
    drive("cursor");
    expect(screen.getByTestId("history-add-label").textContent).toBe(
      "Add at 19:10"
    );
    expect(href("practice")).toContain("from=19%3A10");
    expect(href("practice")).not.toContain("to=");
  });

  it("keeps the page's own params, and only ADDS the window to them", () => {
    // The kind-switching rules stay the server's; this file must not re-derive them.
    render(row());
    drive("zoom");
    expect(href("practice")).toContain("kind=practice");
    expect(href("practice")).toContain("day=2026-09-03");
    expect(href("food")).toContain("kind=food");
  });

  it("clears with the view, because the zoom reset is the only clearing path", () => {
    render(row());
    drive("zoom");
    expect(screen.getByTestId("history-add-label").textContent).not.toBe("Add");
    drive("zoom-empty");
    // A zero-width view is not a window; `windowFromView` refuses it rather than
    // repairing it, so the row falls back to saying nothing.
    expect(screen.getByTestId("history-add-label").textContent).toBe("Add");
  });

  it("prints the clocks in the login's own format", () => {
    render(
      <IntradayInteractionProvider>
        <Driver />
        <HistoryAddRow chips={CHIPS} timeFormat="12h" />
      </IntradayInteractionProvider>
    );
    drive("zoom");
    expect(screen.getByTestId("history-add-label").textContent).toBe(
      "Add at 7:10 PM–8:40 PM"
    );
  });
});
