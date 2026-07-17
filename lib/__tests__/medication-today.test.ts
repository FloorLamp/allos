import { describe, it, expect } from "vitest";
import {
  buildTodayPanelModel,
  type TodayPanelMedInput,
} from "@/lib/medication-today";
import { doseSortKey, compareSortHint } from "@/lib/dose-order";

// A one-dose scheduled med input builder for the ordering fixtures.
function med(
  id: number,
  name: string,
  timeOfDay: string | null,
  resolved = false
): TodayPanelMedInput {
  return {
    id,
    name,
    priority: "low",
    stack: null,
    doses: [{ id: id * 10, timeOfDay, label: name, resolved }],
  };
}

describe("buildTodayPanelModel (#852 item 1)", () => {
  it("orders scheduled rows by the SHARED doseSortKey — same order Upcoming derives", () => {
    // Names chosen so alphabetical order (Alpha, Zeta) REVERSES bucket order: Zeta is a
    // morning dose, Alpha a bedtime dose. Bucket ordering must put Zeta (Morning) first.
    const meds = [
      med(1, "Alpha Bedtime", "bedtime"),
      med(2, "Zeta Morning", "morning"),
      med(3, "Mid Lunch", "lunch"),
    ];
    const model = buildTodayPanelModel(meds, "09:00");
    const panelOrder = model.meds.map((m) => m.name);

    // The Upcoming/attention surfaces carry doseSortKey as sortHint and sort by
    // compareSortHint — reproduce that here over the same doses and assert identical order.
    const upcomingOrder = meds
      .map((m) => ({
        name: m.name,
        hint: doseSortKey({
          timeOfDay: m.doses[0].timeOfDay,
          priority: m.priority,
          stack: m.stack,
          name: m.name,
        }),
      }))
      .sort((a, b) => compareSortHint(a.hint, b.hint))
      .map((x) => x.name);

    expect(panelOrder).toEqual(["Zeta Morning", "Mid Lunch", "Alpha Bedtime"]);
    expect(panelOrder).toEqual(upcomingOrder);
  });

  it("flags an unresolved dose in a PAST bucket, but not upcoming / Anytime / resolved ones", () => {
    // At 18:00 (Evening), a morning dose is past its bucket; a bedtime dose is still
    // upcoming; a timeless dose is never past; a resolved morning dose needs no flag.
    const model = buildTodayPanelModel(
      [
        med(1, "Morning Open", "morning"),
        med(2, "Bedtime Open", "bedtime"),
        med(3, "Anytime Open", null),
        med(4, "Morning Done", "morning", true),
      ],
      "18:00"
    );
    const pastDue = (name: string) =>
      model.meds.find((m) => m.name === name)!.doses[0].pastDue;

    expect(pastDue("Morning Open")).toBe(true);
    expect(pastDue("Bedtime Open")).toBe(false);
    expect(pastDue("Anytime Open")).toBe(false);
    expect(pastDue("Morning Done")).toBe(false);
  });

  it("reports allDone only when every due dose is resolved (and there is at least one)", () => {
    expect(buildTodayPanelModel([], "09:00").allDone).toBe(false);
    expect(
      buildTodayPanelModel([med(1, "A", "morning", true)], "09:00").allDone
    ).toBe(true);
    expect(
      buildTodayPanelModel(
        [med(1, "A", "morning", true), med(2, "B", "evening", false)],
        "09:00"
      ).allDone
    ).toBe(false);
  });

  it("orders a med by its EARLIEST dose across multiple buckets", () => {
    const model = buildTodayPanelModel(
      [
        {
          id: 1,
          name: "Two Doses",
          priority: "low",
          stack: null,
          doses: [
            { id: 11, timeOfDay: "evening", label: "pm", resolved: false },
            { id: 12, timeOfDay: "morning", label: "am", resolved: false },
          ],
        },
        med(2, "Midday Only", "lunch"),
      ],
      "09:00"
    );
    // "Two Doses" earliest bucket is Morning, so it leads the Midday-only med.
    expect(model.meds.map((m) => m.name)).toEqual(["Two Doses", "Midday Only"]);
  });
});
