import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PracticeSessionForm from "@/components/practices/PracticeSessionForm";
import { ToastProvider } from "@/components/Toast";
import { FormatPrefsProvider } from "@/components/FormatPrefsProvider";

// A window the chart stated becomes the form's DEFAULT, never its write (#4950).
//
// The door hands each kind's form the window as a prefill; the person confirms or
// changes it before submitting. Two properties matter and neither is obvious from the
// prop names: a seeded row's own clocks beat the window (a correction is about the
// session that exists, not about what the chart is showing behind the dialog), and a
// start with no end leaves End empty for the `+{n}m` shortcut rather than inventing one.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

const PRACTICES = ["Sauna"];

const form = (props: Record<string, unknown>) => (
  <FormatPrefsProvider prefs={{ dateFormat: "iso", timeFormat: "24h" }}>
    <ToastProvider>
      <PracticeSessionForm
        practices={PRACTICES}
        today="2026-09-03"
        date="2026-09-03"
        maxDate="2026-09-03"
        {...props}
      />
    </ToastProvider>
  </FormatPrefsProvider>
);

const startInput = () =>
  document.querySelector<HTMLInputElement>('input[id$="-start-time"]')!;
const endInput = () =>
  document.querySelector<HTMLInputElement>('input[id$="-end-time"]')!;

afterEach(cleanup);

describe("a chart window prefills the practice form", () => {
  it("starts both clocks empty when no window was stated", () => {
    render(form({}));
    expect(startInput().value).toBe("");
    expect(endInput().value).toBe("");
  });

  it("offers the window's two clocks", () => {
    render(form({ defaultStartTime: "19:10", defaultEndTime: "20:40" }));
    expect(startInput().value).toBe("19:10");
    expect(endInput().value).toBe("20:40");
  });

  it("offers a start alone and leaves End for the shortcut", () => {
    // A tap on the plot marks when something began. Inventing an end here would take
    // the `+{n}m` shortcut's job and state a length nobody gave.
    render(form({ defaultStartTime: "19:10", defaultEndTime: null }));
    expect(startInput().value).toBe("19:10");
    expect(endInput().value).toBe("");
  });

  it("lets a seeded row's own clocks win", () => {
    // Correcting a session that exists is not about what the chart shows behind it.
    render(
      form({
        defaultStartTime: "19:10",
        defaultEndTime: "20:40",
        row: {
          id: 7,
          date: "2026-09-03",
          startTime: "06:00",
          endTime: "06:45",
          durationMin: 45,
          notes: null,
        },
      })
    );
    expect(startInput().value).toBe("06:00");
    expect(endInput().value).toBe("06:45");
  });

  it("opens on the practice the window looks like, when one was found", () => {
    // Habit, decided server-side: the form is handed a name, never a rhythm, so
    // nothing here can turn a heart rate into a claim about which practice this was.
    render(
      form({
        practices: ["Rowing", "Sauna"],
        defaultStartTime: "19:10",
        defaultEndTime: "20:40",
        defaultPractice: "Sauna",
      })
    );
    expect(document.querySelector<HTMLSelectElement>("select")!.value).toBe(
      "Sauna"
    );
  });

  it("opens on the first practice when no fit was found", () => {
    render(
      form({
        practices: ["Rowing", "Sauna"],
        defaultStartTime: "19:10",
        defaultEndTime: "20:40",
      })
    );
    expect(document.querySelector<HTMLSelectElement>("select")!.value).toBe(
      "Rowing"
    );
  });
});
