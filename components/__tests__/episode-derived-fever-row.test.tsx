import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import EpisodeSummary from "@/components/illness/EpisodeSummary";
import { deriveFeverSeries } from "@/lib/illness-episode-format";
import type { AssembledEpisode } from "@/lib/illness-episode-format";

// THE DERIVED FEVER ROW TAKES ITS RULED PLACE (#4712, owner ruling 2026-09-04 11:20
// UTC part 1): FIRST in the episode summary's symptom list, on the card that already
// prints the peak temperature, drawn as a READING — no severity control.
//
// "No severity control" is a claim about what a person can TAP, not only about what
// draws, so these assert the row's interactive content rather than its text: the one
// tappable thing inside it goes to the reading's day, and the severity dots that make
// a stated pill a severity statement are absent from it while STILL PRESENT on the
// stated pills beside it. An absence asserted alone would pass just as happily on a
// card that had lost its dots entirely.
//
// The timeline below the header is stubbed: it renders the episode's own ledger and
// pulls in the episode server actions, and the model-tier proof that the derived arm
// contributes NO editable symptom event to it lives beside `illnessTimelineEvents`
// in lib/__tests__/illness-episode-format.test.ts.
vi.mock("@/components/illness/EpisodeTimeline", () => ({
  default: () => null,
}));

const PEAK_DAY = "2026-06-02";

const derivedFever = deriveFeverSeries([
  { id: 11, date: "2026-06-01", time: "09:00", degF: 100.6, flag: "high" },
  { id: 12, date: PEAK_DAY, time: "19:10", degF: 103.4, flag: "high" },
])!;

const cough = {
  source: "logged" as const,
  symptom: "cough",
  label: "Cough",
  points: [{ date: "2026-06-01", severity: 3, note: null }],
  maxSeverity: 3,
};

function episode(symptoms: AssembledEpisode["symptoms"]): AssembledEpisode {
  return {
    id: 7,
    situation: "Illness",
    start: "2026-06-01",
    end: null,
    ongoing: true,
    firstDay: "2026-06-01",
    lastActiveDay: PEAK_DAY,
    asOf: PEAK_DAY,
    dayCount: 2,
    symptoms,
    distinctSymptomCount: symptoms.length,
    temperatures: [],
    maxTempF: 103.4,
    latestTemp: null,
    medications: [],
    totalAdministrations: 0,
    conditions: [],
    notes: [],
  };
}

function row(): HTMLElement {
  return screen.getByTestId("episode-derived-fever");
}

describe("the derived fever row's ruled place (#4712 ruling 2026-09-04 part 1)", () => {
  it("leads the symptom list and states the episode's peak reading", () => {
    render(
      <EpisodeSummary episode={episode([cough, derivedFever])} linkReadingDay />
    );
    const list = within(screen.getByTestId("episode-symptoms")).getByRole(
      "list"
    );
    // FIRST, structurally — not merely present somewhere in the list.
    expect(list.children[0]).toBe(row());
    expect(row().textContent).toContain("Fever");
    // The EPISODE's peak, the same figure the card prints above, with its clock.
    expect(row().textContent).toContain("103.4");
    expect(row().textContent).not.toContain("100.6");
  });

  it("is a reading, not a severity statement — while the stated pill beside it still is", () => {
    render(
      <EpisodeSummary episode={episode([cough, derivedFever])} linkReadingDay />
    );
    // THE ABSENCE: no severity dots and no severity word inside the derived row.
    expect(within(row()).queryByTestId("episode-severity-dots")).toBeNull();
    expect(row().textContent).not.toContain("Severe");
    // THE CONVERSE, in the same render: the stated pill DOES carry them, so the
    // absence above is about this row rather than about a card that lost its dots.
    expect(screen.getAllByTestId("episode-severity-dots")).toHaveLength(1);

    // THE TAP: exactly one interactive element in the row, and it goes to the
    // reading's own day — never to an editor.
    const taps = within(row()).getAllByRole("link");
    expect(taps).toHaveLength(1);
    expect(taps[0].getAttribute("href")).toBe(`/history?day=${PEAK_DAY}`);
    expect(within(row()).queryAllByRole("button")).toHaveLength(0);
    expect(within(row()).queryAllByRole("slider")).toHaveLength(0);
  });

  it("renders as plain text where the day view cannot be reached (the share render)", () => {
    render(<EpisodeSummary episode={episode([cough, derivedFever])} />);
    expect(row().textContent).toContain("103.4");
    expect(within(row()).queryAllByRole("link")).toHaveLength(0);
  });

  // The block used to be gated on the LOGGED list being non-empty, so a fever-only
  // episode — the one this issue is named for — would have drawn no symptom list at
  // all and the ruled row with it.
  it("draws the list for a fever-only episode, with nothing stated at all", () => {
    render(<EpisodeSummary episode={episode([derivedFever])} linkReadingDay />);
    const list = within(screen.getByTestId("episode-symptoms")).getByRole(
      "list"
    );
    expect(list.children).toHaveLength(1);
    expect(list.children[0]).toBe(row());
  });
});
