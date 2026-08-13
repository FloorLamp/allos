import { describe, it, expect } from "vitest";
import { UNDO_TOAST_MS, undoRefusalText, undoToastPlan } from "../undo-offer";
import {
  DOSE_UNDONE_MESSAGE,
  doseConfirmUndoable,
  doseResolved,
  doseUndoOutcome,
} from "../dose-outcome-text";
import type { DoseTakenOutcome, DoseUndoOutcome } from "../types";

// The pure half of the act→undo contract (#2642). Every expectation below is a PINNED
// LITERAL: recomputing "does this outcome allow an undo" from the function under test
// would pass with the whole rule deleted.

describe("undoToastPlan", () => {
  it("offers the Undo on a success and holds the toast for the shared window", () => {
    expect(undoToastPlan({ message: "Dose logged", hasUndo: true })).toEqual({
      message: "Dose logged",
      tone: "success",
      duration: 15000,
      offerUndo: true,
    });
    // The window is the ONE number, not a per-surface choice.
    expect(UNDO_TOAST_MS).toBe(15000);
  });

  it("NEVER offers an Undo beside a refusal — a write that did not happen has no inverse", () => {
    expect(
      undoToastPlan({
        message: "Not logged — this item is paused",
        tone: "error",
        hasUndo: true,
      })
    ).toEqual({
      message: "Not logged — this item is paused",
      tone: "error",
      duration: undefined,
      offerUndo: false,
    });
  });

  it("leaves an ordinary success alone when the caller holds no inverse", () => {
    expect(undoToastPlan({ message: "Saved.", hasUndo: false })).toEqual({
      message: "Saved.",
      tone: "success",
      duration: undefined,
      offerUndo: false,
    });
  });
});

describe("undoRefusalText", () => {
  it("keeps the wording every refused undo has shown since #30", () => {
    // Pinned verbatim: browser tests assert this string, and the delete toast has
    // shown it since the registry shipped.
    expect(undoRefusalText("expired")).toBe(
      "Couldn’t undo — it may have expired."
    );
  });

  it("distinguishes a moved world from a failed request", () => {
    expect(undoRefusalText("changed")).toBe(
      "Couldn’t undo — this has changed since."
    );
    expect(undoRefusalText("failed")).toBe("Couldn’t undo — try again.");
  });
});

describe("doseConfirmUndoable", () => {
  // The whole union, spelled out, so a new member is a compile error AND an
  // unreviewed row here.
  const EXPECTED: ReadonlyArray<[DoseTakenOutcome, boolean]> = [
    ["logged", true],
    ["logged-off-day", true],
    ["already-taken", false],
    ["already-skipped", false],
    ["skipped", false],
    ["inactive", false],
    ["stale-dose", false],
  ];

  for (const [outcome, undoable] of EXPECTED) {
    it(`${outcome} → ${undoable ? "undoable" : "not undoable"}`, () => {
      expect(doseConfirmUndoable(outcome)).toBe(undoable);
    });
  }

  it("is NARROWER than doseResolved: an already-taken tap wrote nothing to take back", () => {
    // The two questions differ on exactly this member, and that difference is the
    // rule: `already-taken` drops the row off the due list (resolved) but the taken
    // log was somebody's EARLIER confirm, so offering Undo would hand this tap the
    // power to erase a write it did not make.
    expect(doseResolved("already-taken")).toBe(true);
    expect(doseConfirmUndoable("already-taken")).toBe(false);
  });
});

describe("doseUndoOutcome", () => {
  it("reports success only for a confirm that was actually taken back", () => {
    expect(doseUndoOutcome("undone")).toEqual({ ok: true });
  });

  const REFUSALS: readonly DoseUndoOutcome[] = [
    "not-taken",
    "changed",
    "stale-dose",
  ];
  for (const outcome of REFUSALS) {
    it(`${outcome} refuses as "changed"`, () => {
      expect(doseUndoOutcome(outcome)).toEqual({
        ok: false,
        reason: "changed",
      });
    });
  }

  it("names the consequence when the undo lands", () => {
    expect(DOSE_UNDONE_MESSAGE).toBe("Dose confirm undone — it’s due again.");
  });
});
