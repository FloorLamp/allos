import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import IntensityPicker from "@/components/activity-form/IntensityPicker";
import SessionRecapView from "@/components/SessionRecapView";
import { INTENSITIES } from "@/lib/activity-form-model";
import { recapSessionFromPayload, sessionRecap } from "@/lib/session-recap";
import type { ExerciseHistoryMap } from "@/lib/queries";
import { part, renderList } from "./activity-parts-fixture";

// THE ACTIVITY FORM SPEAKS THE FORM GRAMMAR (#5726, under #5300 rule 4).
//
// Three defects the owner's screenshot review found, and all three are about copy that
// the DOM either states twice or spells two ways — so every assertion below reads what
// RENDERED. A call-site assertion ("the string is passed to X") passes straight through
// the failure this file exists for: a string that stops reaching the document still
// typechecks, still lints, and still reads correctly in the source.
vi.mock("@/app/(app)/training/activity-actions", () => ({
  setRpeTrackingAction: vi.fn(async () => ({ tracking: null })),
}));
vi.mock("@/app/(app)/training/actions", () => ({
  dismissTrainingObservation: vi.fn(),
}));
vi.mock("@/components/ActivityEditorProvider", () => ({
  useActivityEditor: () => ({ leaveFor: vi.fn() }),
}));

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

const WARMUP_NOTE = "Warmup sets do not count toward volume or target markers.";

describe("the warmup note (#5726 item 1)", () => {
  // TWO EXERCISES IS THE TEST. The reported defect is a two-exercise workout carrying
  // the sentence twice, so a single-part mount cannot observe it at all.
  it("states itself once, however many exercises show a set grid", () => {
    renderList([part(), part({ name: "Barbell Row" })]);

    expect(screen.getAllByTestId("activity-part")).toHaveLength(2);
    expect(screen.getAllByTestId("set-column-headings")).toHaveLength(2);
    // One affordance in the whole form, and it is the info glyph, not prose.
    expect(screen.getAllByLabelText(WARMUP_NOTE)).toHaveLength(1);
    expect(screen.queryByText(WARMUP_NOTE)).toBeNull();
  });

  it("rides the set-column headings row that owns the W control", () => {
    renderList([part(), part({ name: "Barbell Row" })]);

    const headings = screen.getAllByTestId("set-column-headings");
    expect(
      within(headings[0]).getByTestId("warmup-note").getAttribute("aria-label")
    ).toBe(WARMUP_NOTE);
    expect(within(headings[1]).queryByTestId("warmup-note")).toBeNull();
  });
});

describe("the intensity picker (#5726 item 2)", () => {
  it("carries its meaning in one glyph, inline inside the legend", () => {
    const { container } = render(
      <IntensityPicker intensity="" onChange={vi.fn()} />
    );

    const legend = container.querySelector("legend");
    expect(legend?.textContent).toContain("Intensity");
    // INLINE BESIDE THE LABEL, not stranded on its own line under it: the glyph is
    // inside the legend element, so it cannot be laid out as a separate block.
    const glyph = within(legend as HTMLElement).getByTestId("intensity-help");
    const help = glyph.getAttribute("aria-label") ?? "";
    for (const option of INTENSITIES)
      expect(help).toContain(`${option.label}: ${option.hint}`);
    expect(help).toContain("Affects the calorie estimate");
  });

  it("states it ONCE — no standing paragraph, selected or not", () => {
    const { container, rerender } = render(
      <IntensityPicker intensity="" onChange={vi.fn()} />
    );
    expect(container.querySelector("fieldset p")).toBeNull();
    expect(screen.queryByText(/Sets effort level/)).toBeNull();

    rerender(<IntensityPicker intensity="hard" onChange={vi.fn()} />);
    expect(container.querySelector("fieldset p")).toBeNull();
    expect(screen.queryByText(/affects the calorie estimate/i)).toBeNull();
  });
});

describe("a missed target (#5726 item 3)", () => {
  // The form's live status line and the recent-session rows render on ONE screen, which
  // is what made two spellings visible at once.
  const missedSet = {
    set_number: 1,
    weight_kg: 60,
    reps: 6,
    weight_kg_right: null,
    reps_right: null,
    duration_sec: null,
    duration_sec_right: null,
    target_reps: 8,
    to_failure: null,
    warmup: null,
    rpe: null,
  };
  const history: ExerciseHistoryMap = {
    "bench press": {
      bodyweight: false,
      sessions: [
        {
          date: "2026-09-01",
          exercise: "Barbell Bench Press",
          activityId: 31,
          equipment: null,
          equipmentId: null,
          baseKg: 0,
          status: "missed" as const,
          sets: [missedSet],
        },
      ],
    },
  };
  const missedPart = part({
    targetReps: "8",
    sets: [
      {
        weight: "60",
        reps: "6",
        weightRight: "",
        repsRight: "",
        duration: "",
        durationRight: "",
        warmup: false,
        rpe: null,
        plan: null,
      },
    ],
  });

  it("is spelled the same way in the form and in the recent-session rows", () => {
    renderList([missedPart], { history });

    expect(screen.getByTestId("activity-target-status").textContent).toBe(
      "Missed target"
    );
    expect(screen.getAllByText("Missed target").length).toBeGreaterThan(1);
    expect(screen.queryByText("Below target")).toBeNull();
  });

  it("is spelled that way in the recap the finish step renders", () => {
    const recap = sessionRecap(
      recapSessionFromPayload(
        [
          {
            exercise: "Barbell Bench Press",
            weight: 60,
            reps: 6,
            weightRight: null,
            repsRight: null,
            durationSec: null,
            durationSecRight: null,
            equipmentId: null,
            targetReps: 8,
            toFailure: false,
            warmup: false,
            rpe: null,
          },
        ],
        { title: "", durationMin: null, intensity: null, bodyweightKg: 0 },
        "kg",
        {}
      ),
      {}
    );
    render(<SessionRecapView recap={recap} unit="kg" />);

    expect(screen.getByText("Missed target")).toBeTruthy();
    expect(screen.queryByText("Below target")).toBeNull();
  });
});
