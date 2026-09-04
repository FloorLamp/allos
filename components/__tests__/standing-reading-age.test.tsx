import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  StandingAge,
  staleMeasurementDoor,
  vitalsFamilySeat,
} from "@/components/dashboard/StandingAge";
import { DashboardFactRow } from "@/components/dashboard/DashboardStandingCluster";
import type { DashboardPlacement } from "@/lib/dashboard-relevance";
import { formatLongDate, DEFAULT_FORMAT_PREFS } from "@/lib/format-date";
import { shiftDateStr } from "@/lib/date";
import { glanceAgeToken } from "@/lib/glance-age";
import {
  TREND_METRIC_PRESENTATION_FLOORS,
  trendMetricPresentationFreshness,
} from "@/lib/trend-metric-freshness";

// A Standing reading past its family's floor takes the stale treatment and grows the
// measurement DOOR; a fresh one takes neither (#4757). The floor is the family's own
// declaration read by reference — weight's is the Trends card's six weeks — so this
// pins the row's behaviour at THAT boundary rather than restating a number.

const open = vi.fn();
vi.mock("@/components/QuickEntryProvider", () => ({
  useQuickEntry: () => ({ open }),
}));

const TODAY = "2026-09-02";
const WEIGHT_FLOOR = TREND_METRIC_PRESENTATION_FLOORS.weight.days;

const candidate: DashboardPlacement["candidate"] = {
  candidateId: "weight.latest:x",
  factKey: "fact:weight",
  groupKey: null,
  subject: { scope: "profile", profileId: 7 },
  applicable: true,
  relevance: {
    kind: "profile-data",
    presence: "current",
    engagement: "manual",
  },
  timing: { kind: "always" },
  rankReasons: {
    safety: false,
    owed: false,
    windowOpen: false,
    changed: false,
  },
  sourceOrder: 0,
  kind: "reading",
};

// Exactly what the page does for the weight row: the family floor, the shared
// decision, the shared cell, the door only when stale.
function weightRow(daysAgo: number, labelled = true) {
  const label = labelled ? "Latest" : undefined;
  const date = shiftDateStr(TODAY, -daysAgo);
  const age = glanceAgeToken({
    date,
    today: TODAY,
    freshness: trendMetricPresentationFreshness("weight", date, TODAY),
    form: "long",
    floorLabel: TREND_METRIC_PRESENTATION_FLOORS.weight.label,
    dateLabel: formatLongDate(date, DEFAULT_FORMAT_PREFS),
  });
  return render(
    <DashboardFactRow
      candidate={candidate}
      lane="standing"
      presentation={{
        label,
        value: "143.1 lb",
        detail: <StandingAge age={age} testId="weight-latest-age" />,
        href: "/trends#body",
        disclosure: age.title ?? undefined,
        control: staleMeasurementDoor(age, "body", "Log weight"),
        presence: "current",
      }}
    />
  );
}

describe("a Standing reading at its family's floor", () => {
  it.each([
    [WEIGHT_FLOOR, false],
    [WEIGHT_FLOOR + 1, true],
  ])("%s days old → stale %s", (daysAgo, stale) => {
    weightRow(daysAgo);
    const age = screen.getByTestId("weight-latest-age");
    expect(age.classList.contains("standing-age")).toBe(true);
    expect(age.getAttribute("data-stale")).toBe(stale ? "true" : null);
    expect(age.className.includes("amber")).toBe(stale);
    expect(screen.queryByRole("button", { name: "Log weight" }) != null).toBe(
      stale
    );
    // The destination survives either way: a fresh row IS the link; a stale row hands
    // the href to its label, since a button cannot sit inside an anchor.
    const link = screen.getByRole("link", stale ? { name: "Latest" } : {});
    expect(link.getAttribute("href")).toBe("/trends#body");
  });

  it("the door opens the measurements form at the group and carries no value", () => {
    weightRow(WEIGHT_FLOOR + 1);
    fireEvent.click(screen.getByRole("button", { name: "Log weight" }));
    // `toEqual` on the whole prefill is the assertion that no value rode along.
    expect(open).toHaveBeenCalledWith("measurements", {
      measurementGroup: "body",
    });
  });

  it("a label-less row hands the href to its value instead", () => {
    // A `single` family's one member is named by the family, not by a label (the two
    // vitals rows). Its history must not vanish the day it goes stale.
    weightRow(WEIGHT_FLOOR + 1, false);
    expect(
      screen.getByRole("link", { name: /143\.1 lb/ }).getAttribute("href")
    ).toBe("/trends#body");
    expect(screen.getByRole("button", { name: "Log weight" })).toBeTruthy();
  });
});

// THE VITALS FAMILY'S ONE SEAT (#4841 item 4). Blood pressure and resting heart rate
// are two separate rows; the owner ruled ONE "Log a vital" door for the pair. This is
// the whole decision of which row carries it, pinned as a table so a future edit that
// starts returning two seats — or none while a member is live — goes red here first,
// before any page ever renders a second door.
describe("the vitals family's door seat", () => {
  it.each([
    [true, true, "blood-pressure"],
    [true, false, "blood-pressure"],
    [false, true, "resting-heart-rate"],
    [false, false, null],
  ] as const)(
    "bp live=%s, resting HR live=%s → %s",
    (bpLive, restingHrLive, seat) => {
      expect(vitalsFamilySeat(bpLive, restingHrLive)).toBe(seat);
    }
  );
});
