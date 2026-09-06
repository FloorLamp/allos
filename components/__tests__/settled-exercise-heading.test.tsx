import { fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExerciseHistoryMap } from "@/lib/queries";
import type { PlateauFormHint } from "@/lib/rule-findings";
import { part, renderList } from "./activity-parts-fixture";

// A SETTLED EXERCISE IS A HEADING (#5370), at the tier that can ask about it.
//
// The defect this file exists for is a picked exercise that still reads as an open
// search: a magnifier, a muscle chip and the field's own Clear inside the box, then a
// SECOND X at the row's end that deletes the exercise and its sets. Two X targets on
// one line doing different things is the thing to hold shut, so the assertions here
// are about what the settled row does and does NOT offer, and about the picker still
// being one tap behind the name.
const dismissTrainingObservation = vi.fn();
vi.mock("@/app/(app)/training/activity-actions", () => ({
  setRpeTrackingAction: vi.fn(async () => ({ tracking: null })),
}));
vi.mock("@/app/(app)/training/actions", () => ({
  dismissTrainingObservation: (fd: FormData) => dismissTrainingObservation(fd),
}));
vi.mock("@/components/ActivityEditorProvider", () => ({
  useActivityEditor: () => ({ leaveFor: vi.fn() }),
}));

beforeEach(() => {
  dismissTrainingObservation.mockClear();
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

const set = (n: number, kg: number, reps: number) => ({
  set_number: n,
  weight_kg: kg,
  reps,
  weight_kg_right: null,
  reps_right: null,
  duration_sec: null,
  duration_sec_right: null,
  target_reps: null,
  to_failure: null,
  warmup: null,
  rpe: null,
});

// Three prior sessions of the one lift — `recentSessionsForForm`'s whole window, so the
// fold has both older rows behind it.
const session = (activityId: number, date: string, kg: number) => ({
  date,
  exercise: "Barbell Bench Press",
  activityId,
  equipment: null,
  equipmentId: null,
  baseKg: 0,
  status: "met" as const,
  sets: [set(1, kg, 8), set(2, kg, 8)],
});
const HISTORY: ExerciseHistoryMap = {
  "bench press": {
    bodyweight: false,
    sessions: [
      session(31, "2026-09-01", 60),
      session(22, "2026-08-25", 57.5),
      session(13, "2026-08-18", 55),
    ],
  },
};
const PLATEAU: PlateauFormHint[] = [
  {
    exerciseKey: "bench press",
    equipmentId: null,
    dedupeKey: "plateau-bench-42",
    supersedes: "plateau-bench-41",
    hintText: "Flat for about 6 weeks.",
  },
];

// Two parts, so the row carries the "Remove activity" action the issue is about (it
// renders only when a session has more than one exercise).
const twoParts = (over: Record<string, unknown> = {}) =>
  renderList([part(), part({ name: "Barbell Row" })], over);

describe("the settled exercise (#5370)", () => {
  it("states its name as a heading and offers ONE removal, not two", () => {
    twoParts();
    const row = screen.getAllByTestId("activity-part")[0];

    expect(within(row).getByTestId("part-name-heading").textContent).toContain(
      "Barbell Bench Press"
    );
    // The muscle chip rides the heading, as it rode the field.
    expect(within(row).getByText("Chest", { exact: true })).toBeTruthy();
    // No mounted search: no combobox, and above all no second X. `Clear` surviving
    // into the settled state IS the reported defect.
    expect(within(row).queryByRole("combobox")).toBeNull();
    expect(within(row).queryByRole("button", { name: "Clear" })).toBeNull();
    expect(
      within(row).getAllByRole("button", { name: "Remove activity" })
    ).toHaveLength(1);
  });

  it("reopens the SAME picker from the heading, sets and name intact", () => {
    const onTypePartName = vi.fn();
    twoParts({ onTypePartName });
    const row = () => screen.getAllByTestId("activity-part")[0];

    fireEvent.click(within(row()).getByTestId("part-name-heading"));

    const field = within(row()).getByRole("combobox") as HTMLInputElement;
    // Same field, same value, and the search's own clear is back with it.
    expect(field.getAttribute("aria-label")).toBe("Activity");
    expect(field.value).toBe("Barbell Bench Press");
    expect(field).toBe(document.activeElement);
    expect(within(row()).getByRole("button", { name: "Clear" })).toBeTruthy();
    // The heading is gone while its picker is open — one name control, never two.
    expect(within(row()).queryByTestId("part-name-heading")).toBeNull();
    // Reopening states nothing; only typing does.
    expect(onTypePartName).not.toHaveBeenCalled();
  });

  it("returns to the heading on Escape, with the name and the focus", () => {
    twoParts();
    const row = () => screen.getAllByTestId("activity-part")[0];
    fireEvent.click(within(row()).getByTestId("part-name-heading"));

    fireEvent.keyDown(within(row()).getByRole("combobox"), { key: "Escape" });

    const heading = within(row()).getByTestId("part-name-heading");
    expect(heading.textContent).toContain("Barbell Bench Press");
    // Settling unmounts the field the caret was in; without this the next Tab
    // restarts at the top of the document.
    expect(heading).toBe(document.activeElement);
  });

  it("settles the OTHER part's picker when this one opens", () => {
    twoParts();
    const rows = () => screen.getAllByTestId("activity-part");
    fireEvent.click(within(rows()[0]).getByTestId("part-name-heading"));
    fireEvent.click(within(rows()[1]).getByTestId("part-name-heading"));

    expect(screen.getAllByRole("combobox")).toHaveLength(1);
    expect(within(rows()[0]).getByTestId("part-name-heading")).toBeTruthy();
  });

  // A part with no name has nothing to state, so it is the picker — that is the
  // form's first exercise on every fresh log, and it must not open as an empty
  // heading nobody can type into.
  it("keeps the picker mounted while a part has no name", () => {
    renderList([part({ name: "" })]);
    expect(screen.getByRole("combobox")).toBeTruthy();
    expect(screen.queryByTestId("part-name-heading")).toBeNull();
  });

  // TYPING IS SEARCHING, and this is the case a name-derived `settled` gets wrong: a
  // half-typed name is a name, so the heading would arrive on the first keystroke and
  // take the field out from under the caret.
  it("keeps the picker mounted through the first keystroke", () => {
    const typed = part({ name: "" });
    const onTypePartName = vi.fn();
    const { rerenderParts } = renderList([typed], { onTypePartName });

    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "Ben" },
    });
    rerenderParts([part({ name: "Ben" })]);

    expect(onTypePartName).toHaveBeenCalledWith(0, "Ben");
    expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe(
      "Ben"
    );
    expect(screen.queryByTestId("part-name-heading")).toBeNull();
  });
});

describe("history is one line, the rest one tap behind (#5370)", () => {
  const withHistory = (over: Record<string, unknown> = {}) =>
    renderList([part()], {
      history: HISTORY,
      plateauHints: PLATEAU,
      ...over,
    });
  const fold = () => screen.getByTestId("recent-more").firstElementChild!;

  it("states the last session and folds the older ones and the note", () => {
    withHistory();
    const panel = screen.getByTestId("recent-sessions");

    // ONE line outside the fold, and it is the newest session.
    const stated = within(panel).getAllByRole("listitem")[0];
    expect(stated.textContent).toContain("60 kg");
    expect(
      within(panel)
        .getAllByTestId("recent-session-fill")
        .filter((el) => !fold().contains(el))
    ).toHaveLength(1);

    // The other two sessions and the plateau note are inside the closed fold, which
    // is out of the accessibility tree and the tab order until it opens.
    expect(fold().getAttribute("aria-hidden")).toBe("true");
    expect(
      within(fold() as HTMLElement).getAllByRole("listitem", {
        hidden: true,
      })
    ).toHaveLength(2);
    expect(fold().contains(screen.getByTestId("plateau-hint"))).toBe(true);
    expect(
      screen.getByTestId("recent-more-toggle").getAttribute("aria-expanded")
    ).toBe("false");
  });

  it("opens the fold on the chevron", () => {
    withHistory();
    fireEvent.click(screen.getByTestId("recent-more-toggle"));

    expect(fold().getAttribute("aria-hidden")).toBeNull();
    expect(
      screen.getByTestId("recent-more-toggle").getAttribute("aria-expanded")
    ).toBe("true");
    // Every recent session is still a fill tap — the fold cost none of the gesture.
    expect(screen.getAllByTestId("recent-session-fill")).toHaveLength(3);
  });

  it("fills from the stated line with the NEWEST session's sets", () => {
    const onFill = vi.fn();
    withHistory({ onFill });

    fireEvent.click(screen.getAllByTestId("recent-session-fill")[0]);

    expect(onFill).toHaveBeenCalledWith(0, {
      source: "session",
      sets: HISTORY["bench press"].sessions[0].sets,
    });
  });

  // The note keeps its dismiss behind the fold; a fold that swallowed the write would
  // silence nothing on the surfaces sharing this dedupe key (#923/#435).
  it("keeps the note's dismiss wired behind the fold", () => {
    withHistory();
    fireEvent.click(screen.getByTestId("recent-more-toggle"));
    fireEvent.click(screen.getByTestId("plateau-hint-dismiss"));

    expect(dismissTrainingObservation).toHaveBeenCalledTimes(1);
    expect(dismissTrainingObservation.mock.calls[0][0].get("dedupe_key")).toBe(
      "plateau-bench-42"
    );
    expect(screen.queryByTestId("plateau-hint")).toBeNull();
  });

  // A lift with a note and NO history has no fold for the note to go behind, so it
  // stays where it always was rather than vanishing.
  it("keeps the note in place when there is no history to fold it into", () => {
    renderList([part()], { history: {}, plateauHints: PLATEAU });
    expect(screen.queryByTestId("recent-sessions")).toBeNull();
    expect(screen.getByTestId("plateau-hint")).toBeTruthy();
  });
});
