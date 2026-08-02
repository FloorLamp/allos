import { describe, it, expect } from "vitest";
import {
  EMPTY_DIRTY_FORM_STATE,
  fieldHoldsUnsavedInput,
  formHasUnsavedInput,
  isAnyFormDirty,
  reduceDirtyForms,
  refreshIsOwed,
  type DirtyFormEvent,
  type DirtyFormState,
  type TrackedField,
} from "@/lib/dirty-forms";

// The dirty-form registry's state machine (issue #1878). The React binding is a
// thin DOM layer over exactly these decisions, so everything the fix promises is
// pinned here: chrome refreshes defer while a form holds unsaved input, an owed
// refresh SURVIVES until the last form releases (never dropped), several owed
// refreshes coalesce into ONE repaint, and a field is only ever dirty because the
// user genuinely edited it — never because it mounted or was focused.

function field(over: Partial<TrackedField> = {}): TrackedField {
  return {
    touched: false,
    current: "",
    baseline: "",
    serverValue: "",
    ...over,
  };
}

function run(
  events: readonly DirtyFormEvent[],
  from: DirtyFormState = EMPTY_DIRTY_FORM_STATE
): { state: DirtyFormState; refreshes: number } {
  let state = from;
  let refreshes = 0;
  for (const event of events) {
    const next = reduceDirtyForms(state, event);
    state = next.state;
    if (next.refreshNow) refreshes += 1;
  }
  return { state, refreshes };
}

describe("fieldHoldsUnsavedInput", () => {
  it("ignores a field the user never edited, however it was rendered", () => {
    // A mounted form full of server-rendered values is NOT dirty — the failure
    // mode that would turn this registry into a global refresh suppressor.
    expect(
      fieldHoldsUnsavedInput(
        field({ current: "2026-08-02", serverValue: "2026-08-02" })
      )
    ).toBe(false);
    // Nor is a CONTROLLED field, whose DOM defaultValue is empty while it renders
    // a real value — untouched is untouched.
    expect(
      fieldHoldsUnsavedInput(
        field({ current: "2026-08-02", baseline: "2026-08-02" })
      )
    ).toBe(false);
  });

  it("is dirty once the user edits away from what the field held", () => {
    expect(
      fieldHoldsUnsavedInput(
        field({ touched: true, current: "Annual physical" })
      )
    ).toBe(true);
  });

  it("releases when the edit is undone — the blur-with-empty case", () => {
    // Typed "Annual physical" into an empty field, then deleted it again.
    expect(
      fieldHoldsUnsavedInput(
        field({ touched: true, current: "", baseline: "" })
      )
    ).toBe(false);
    // Same rule for a field that started with a server value and was restored.
    expect(
      fieldHoldsUnsavedInput(
        field({
          touched: true,
          current: "Dr. Smith",
          baseline: "Dr. Smith",
          serverValue: "Dr. Smith",
        })
      )
    ).toBe(false);
  });

  it("releases when the value the user typed is the value the server now renders", () => {
    // An autosave-on-blur form: the write landed and revalidated, so React
    // updated the field's defaultValue. It is saved, not pending.
    expect(
      fieldHoldsUnsavedInput(
        field({
          touched: true,
          current: "Europe/Paris",
          baseline: "UTC",
          serverValue: "Europe/Paris",
        })
      )
    ).toBe(false);
  });

  it("makes a form dirty when any one of its fields is", () => {
    expect(formHasUnsavedInput([])).toBe(false);
    expect(
      formHasUnsavedInput([
        field({ current: "2026-08-02", serverValue: "2026-08-02" }),
        field({ touched: true, current: "Annual physical" }),
      ])
    ).toBe(true);
    expect(
      formHasUnsavedInput([
        field({ current: "2026-08-02", serverValue: "2026-08-02" }),
        field({ touched: true, current: "", baseline: "" }),
      ])
    ).toBe(false);
  });
});

describe("reduceDirtyForms", () => {
  it("runs a chrome refresh immediately when nothing is dirty", () => {
    const { state, refreshes } = run([{ type: "chrome-refresh" }]);
    expect(refreshes).toBe(1);
    expect(refreshIsOwed(state)).toBe(false);
  });

  it("defers a chrome refresh while a form holds unsaved input, then drains it", () => {
    const { state, refreshes } = run([
      { type: "dirty", formId: "visit-add" },
      { type: "chrome-refresh" },
    ]);
    expect(refreshes).toBe(0);
    expect(isAnyFormDirty(state)).toBe(true);
    expect(refreshIsOwed(state)).toBe(true);

    const after = run([{ type: "clean", formId: "visit-add" }], state);
    expect(after.refreshes).toBe(1);
    expect(isAnyFormDirty(after.state)).toBe(false);
    expect(refreshIsOwed(after.state)).toBe(false);
  });

  it("keeps an owed refresh across arbitrarily many events until release", () => {
    // "Filled half a form and walked away": the page keeps ticking and nothing
    // drops the debt.
    const { state } = run([
      { type: "dirty", formId: "visit-add" },
      { type: "chrome-refresh" },
      { type: "dirty", formId: "visit-add" },
      { type: "clean", formId: "provider-add" },
      { type: "dirty", formId: "visit-add" },
    ]);
    expect(refreshIsOwed(state)).toBe(true);

    const after = run([{ type: "clean", formId: "visit-add" }], state);
    expect(after.refreshes).toBe(1);
  });

  it("coalesces several owed refreshes into exactly one repaint", () => {
    const { state } = run([
      { type: "dirty", formId: "visit-add" },
      { type: "chrome-refresh" },
      { type: "chrome-refresh" },
      { type: "chrome-refresh" },
    ]);
    expect(state.owed).toBe(3);

    const after = run([{ type: "clean", formId: "visit-add" }], state);
    // Three owed, ONE refresh — a repaint is idempotent and running it three
    // times is the doubled-fetch the sibling rule exists to prevent.
    expect(after.refreshes).toBe(1);
    expect(after.state.owed).toBe(0);
  });

  it("waits for the LAST of several dirty forms before draining", () => {
    const { state } = run([
      { type: "dirty", formId: "visit-add" },
      { type: "dirty", formId: "provider-add" },
      { type: "chrome-refresh" },
    ]);

    const first = run([{ type: "clean", formId: "visit-add" }], state);
    expect(first.refreshes).toBe(0);
    expect(refreshIsOwed(first.state)).toBe(true);

    const last = run([{ type: "clean", formId: "provider-add" }], first.state);
    expect(last.refreshes).toBe(1);
    expect(isAnyFormDirty(last.state)).toBe(false);
  });

  it("does not invent a refresh when a form releases with nothing owed", () => {
    const { refreshes } = run([
      { type: "dirty", formId: "visit-add" },
      { type: "clean", formId: "visit-add" },
    ]);
    expect(refreshes).toBe(0);
  });

  it("is idempotent for repeated dirty and repeated clean", () => {
    const { state } = run([
      { type: "dirty", formId: "visit-add" },
      { type: "dirty", formId: "visit-add" },
    ]);
    expect(state.dirty).toEqual(["visit-add"]);

    const after = run(
      [
        { type: "clean", formId: "visit-add" },
        { type: "clean", formId: "visit-add" },
      ],
      state
    );
    expect(after.state.dirty).toEqual([]);
    // The second release must not fire a second refresh off the same debt.
    expect(after.refreshes).toBe(0);
  });

  it("keeps deferring after a drain when a form goes dirty again", () => {
    const cycle1 = run([
      { type: "dirty", formId: "visit-add" },
      { type: "chrome-refresh" },
      { type: "clean", formId: "visit-add" },
    ]);
    expect(cycle1.refreshes).toBe(1);

    const cycle2 = run(
      [{ type: "dirty", formId: "visit-add" }, { type: "chrome-refresh" }],
      cycle1.state
    );
    expect(cycle2.refreshes).toBe(0);
    expect(refreshIsOwed(cycle2.state)).toBe(true);
  });

  it("never mutates the state it is given", () => {
    const start: DirtyFormState = { dirty: ["visit-add"], owed: 1 };
    const snapshot = JSON.stringify(start);
    reduceDirtyForms(start, { type: "clean", formId: "visit-add" });
    reduceDirtyForms(start, { type: "chrome-refresh" });
    expect(JSON.stringify(start)).toBe(snapshot);
  });
});
