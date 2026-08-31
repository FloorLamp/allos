import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import { ToastProvider } from "@/components/Toast";
import CuratedSupplementSuggestions from "@/components/CuratedSupplementSuggestions";
import ScheduledDoseAction from "@/components/medications/ScheduledDoseAction";
import ImportFeed from "@/components/ImportFeed";
import TrainingLogRow from "@/app/(app)/training/TrainingLogRow";
import type { CuratedSupplementSuggestion } from "@/lib/supplement-suggest-curated";
import type { FeedEntry } from "@/lib/import-feed";
import type { TrainingLogCardData } from "@/lib/training-log-card";

// THE INFO-AFFORDANCE CENSUS, AT THE TIER THAT CAN COUNT MOUNTS (#3970).
//
// `InfoTooltipIcon` renders a 34px BUTTON (#3938/#3956), so an explainer mounted per
// row multiplies into a control panel. The rule this file guards has two halves and
// they need opposite assertions:
//
//   1. A CONSTANT explainer states itself ONCE, however many rows are on screen. The
//      fixture carries SEVERAL rows so the count reports the MULTIPLICATION rather
//      than merely its presence — measured, a one-card fixture does still fail this
//      (2 vs 1, the legend supplying the second), so several rows is about what the
//      failure TELLS you and about exercising the per-row path more than once, not
//      about the assertion being able to fail at all.
//   2. A RARE warning KEEPS its icon. That is the converse of half 1, and it is the
//      half a removal sweep can never prove — an absence assertion is green both when
//      the icon moved home and when it vanished from somewhere load-bearing. So the
//      surfaces that must stay loud are NAMED here, by hand and short, and asserted as
//      presence.
//
// Every count runs through `screen.getAllByRole("button", { name })` — the accessible
// name InfoTooltipIcon puts on its own button — and not through a testid, because two
// of the mounts below never carried one.

function curated(key: string, label: string): CuratedSupplementSuggestion {
  return {
    key,
    label,
    origin: "curated",
    side: "low",
    triggeredBy: [label],
    supplements: [
      { name: `${label} supplement`, foodTiming: "any", isAlternative: false },
    ],
    evidence: "Evidence line",
    source: "Source line",
    caveat: null,
    safetyNotes: [],
  } as unknown as CuratedSupplementSuggestion;
}

const CURATED_EXPLAINER =
  "From the curated, human-reviewed biomarker→supplement map — the same suggestion every time, with no AI involved.";

describe("a constant explainer states itself once (#3970 rule 1)", () => {
  it("gives a three-card curated list one origin button and three badges", () => {
    render(
      <CuratedSupplementSuggestions
        suggestions={[
          curated("vitamin-d", "Vitamin D"),
          curated("folate", "Folate"),
          curated("iron", "Ferritin"),
        ]}
      />
    );
    // Three cards, so the forbidden per-card path is reached three times and a
    // regression reports its size (4 = one legend + three cards) rather than just
    // its existence. One card also fails (2 vs 1) — checked, not assumed.
    expect(screen.getAllByTestId("suggestion-origin-badge")).toHaveLength(3);
    expect(
      screen.getAllByRole("button", { name: CURATED_EXPLAINER })
    ).toHaveLength(1);
  });

  it("drops the past-due gloss entirely — the visible label already says it", () => {
    render(
      <ScheduledDoseAction
        doseId={1}
        doseLabel="1 tablet · Morning"
        taken={false}
        skipped={false}
        pastDue
        readOnly
      />
    );
    expect(screen.getByText("Past due")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Past due/ })).toBeNull();
  });
});

// THE CONVERSE. Rule 3 keeps an icon exactly where the fact is RARE and has no other
// home, and these are the two the issue names. Asserted as presence against a fixture
// that carries the rare condition — a fixture without the fault or the mismatch would
// make both assertions unfailable.
describe("a rare warning keeps its icon (#3970 rule 3)", () => {
  it("keeps the training row's editor-fault dot", () => {
    const card = {
      activity: { id: 7, title: "Faulted session", type: "strength" },
      parts: [],
      metrics: [],
      contextMetrics: [],
      gear: null,
      provenance: { label: "Manual" },
      fault: "Back Squat has no equipment",
      timeText: null,
      durationText: null,
      distanceText: null,
      speedText: null,
      heartRateText: null,
      calorieText: null,
    } as unknown as TrainingLogCardData;
    render(
      <TrainingLogRow
        card={card}
        showSubjectChip={false}
        onFilterTag={() => {}}
      />
    );
    expect(
      screen.getByRole("button", {
        name: "Editor can’t re-save this as-is: Back Squat has no equipment",
      })
    ).toBeTruthy();
  });

  it("keeps the import feed's patient-name mismatch warning", () => {
    const feed: FeedEntry[] = [
      {
        stream: "document",
        at: "2026-08-30 10:00:00",
        sortId: 1,
        doc: {
          id: 3,
          filename: "panel.pdf",
          doc_type: "lab",
          source: null,
          patient_name: "Someone Else",
          extraction_status: "done",
          extraction_error: null,
          extracted_count: 4,
          live_count: 4,
        },
      } as unknown as FeedEntry,
    ];
    // The feed header mounts a write control, so the write providers are supplied —
    // the row under test renders for real either way.
    render(
      <ToastProvider>
        <ConfirmProvider>
          <ImportFeed feed={feed} knownNames={["Test Profile"]} />
        </ConfirmProvider>
      </ToastProvider>
    );
    expect(
      screen.getByRole("button", {
        name: "Document names “Someone Else”, which doesn’t match this profile.",
      })
    ).toBeTruthy();
  });
});
