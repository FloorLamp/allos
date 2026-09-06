import { fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExerciseHistoryMap } from "@/lib/queries";
import type { PlateauFormHint } from "@/lib/rule-findings";
import { blankSet } from "@/lib/activity-form-model";
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
    dedupeKey: "bench plateau 1",
    supersedes: "bench plateau 0",
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
      "bench plateau 1"
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

// ── THE TYPE AND COLOUR LADDER (#5376) ───────────────────────────────────────
//
// #5370 took rung 2 for the exercise name and deliberately left the rest. These
// cases are the rest, and each asks about a RELATIONSHIP rather than about a class
// on its own — two rungs are distinct, a row's date and its numbers sit at one
// brightness, a colour is present only under the condition it means. A class name
// asserted alone would go green on a tree where the ladder had been rewritten
// underneath it.

/**
 * The tone an element actually renders at: its own `text-slate-*` when it states
 * one, else the nearest ancestor's. That is what tells "this row is muted" apart
 * from "this child overrides its row", which is the whole reference question.
 */
const toneOf = (el: Element): string | undefined => {
  for (let n: Element | null = el; n; n = n.parentElement) {
    const hit = [...n.classList].find((c) => /^text-slate-\d+$/.test(c));
    if (hit) return hit;
  }
  return undefined;
};

describe("the type and colour ladder (#5376)", () => {
  // Two sets so the row carries a set remover, and not identical so the part stays a
  // grid rather than collapsing into the compact sentence (#3336).
  const worked = [
    { ...blankSet(), weight: "60", reps: "8", plan: null },
    { ...blankSet(), weight: "60", reps: "7", plan: null },
  ];
  const ladder = () =>
    renderList([part({ sets: worked }), part({ name: "Barbell Row" })], {
      history: HISTORY,
      plateauHints: PLATEAU,
    });

  // RUNG 3 IS ONE UTILITY. `label` and `section-label` are told apart only by weight
  // 500 against 600, and this form wore both — so what is pinned is that exactly one
  // of the pair survives in the rendered editor, whichever one that is.
  it("wears exactly one of the two uppercase label utilities", () => {
    ladder();
    expect(
      ["label", "section-label"].filter((c) => document.querySelector(`.${c}`))
    ).toEqual(["label"]);
  });

  // RUNG 2 IS NOT RUNG 3. The heading that names the block and the uppercase labels
  // inside it resolving to one look is the defect; `.section-heading` is the node the
  // exercise name and the Session heading (ActivityForm) now share, so they cannot
  // drift apart the way two hand-rolled spellings would.
  it("states the block's name a rung above the labels inside it", () => {
    ladder();
    const heading = screen.getAllByTestId("part-name-heading")[0];
    expect(heading.querySelector(".section-heading")).toBeTruthy();
    expect(heading.querySelector(".label")).toBeNull();
  });

  /** The stated recent line — the fill BUTTON while the part is pristine, the
      read-only row once anything is typed. Both carry the row's tone. */
  const statedLine = () =>
    within(screen.getAllByTestId("recent-sessions")[0])
      .getAllByRole("listitem")[0]
      .firstElementChild!.firstElementChild!;

  // RUNG 4. Only the DATE of a recent row was muted; the numbers beside it inherited
  // body colour, so a reference line read as loud as the sets being typed under it.
  // Both shapes of the row are asked, because the fill path and the read-only path
  // are two renderings of the same reference.
  it.each([
    ["a pristine part, where the line is a fill", () => renderList([part()], { history: HISTORY, plateauHints: PLATEAU })],
    ["a worked part, where it is read-only", ladder],
  ])("reads a recent session at one muted brightness — %s", (_what, mount) => {
    mount();
    const [date, values] = Array.from(statedLine().children);
    expect(toneOf(date)).toBe(toneOf(values));
    expect(toneOf(date)).toBe("text-slate-500");
  });

  // The plateau/deload note supports the load being chosen, so it belongs to the same
  // rung as the history it sits behind rather than to the record's brightness.
  it("keeps the plateau note at the reference rung", () => {
    ladder();
    fireEvent.click(screen.getAllByTestId("recent-more-toggle")[0]);
    expect(
      toneOf(within(screen.getByTestId("plateau-hint")).getByText(/Flat for/))
    ).toBe(toneOf(statedLine()));
  });

  // ROSE IS DESTRUCTIVE INTENT, NOT A RESTING STATE. A two-exercise workout showed a
  // destructive glyph per set while nothing was being deleted. The property is "no
  // UNCONDITIONAL rose", and its converse rides in the same case: taking the colour
  // away entirely must not satisfy it either.
  it("paints no remover rose at rest, and paints one on hover and on focus", () => {
    ladder();
    const row = screen.getAllByTestId("activity-part")[0];
    for (const el of [
      within(row).getByRole("button", { name: "Remove activity" }),
      within(row).getByTestId("set-remove-2"),
    ]) {
      const rose = [...el.classList].filter((c) => c.includes("rose"));
      // At rest: nothing. A variant class carries its condition in its prefix.
      expect(rose.filter((c) => !c.includes(":"))).toEqual([]);
      // And the keyboard gets exactly what the pointer gets, in both themes: every
      // hover paint has a focus-visible twin and back. `some(hover) && some(focus)`
      // was the first spelling here and a DARK-ONLY twin satisfied it — measured,
      // so the pairing is asserted instead of the presence.
      const swap = (c: string) =>
        c.includes("focus-visible:")
          ? c.replace("focus-visible:", "hover:")
          : c.replace("hover:", "focus-visible:");
      expect(new Set(rose.map(swap))).toEqual(new Set(rose));
      // …and it is not the empty set: taking the colour away entirely is the other
      // way to make every line above pass.
      expect(rose.length).toBeGreaterThan(0);
    }
  });

  // Brand marks the primary action and the add link on this form. A chip that only
  // NAMES the muscle a lift trains is not an action, so it stops borrowing that paint.
  it("keeps brand off the muscle chip", () => {
    ladder();
    const chip = within(screen.getAllByTestId("activity-part")[0]).getByText(
      "Chest",
      { exact: true }
    );
    expect([...chip.classList].filter((c) => c.includes("brand"))).toEqual([]);
  });
});
