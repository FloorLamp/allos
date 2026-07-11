import { describe, expect, it } from "vitest";
import {
  diffCompletions,
  shouldResetSeed,
  type PolledItem,
} from "@/lib/toaster-diff";

// Mirrors ExtractionToaster's terminal set (done/failed/skipped).
const isTerminal = (s: string) =>
  s === "done" || s === "failed" || s === "skipped";

type Doc = PolledItem & { name: string };
const doc = (id: number, status: string, name = `doc-${id}`): Doc => ({
  id,
  status,
  name,
});

describe("diffCompletions", () => {
  it("seeds silently on the first poll (prev null): no toasts, seeded=true", () => {
    const items = [doc(1, "done"), doc(2, "failed"), doc(3, "processing")];
    const r = diffCompletions(null, items, isTerminal);
    expect(r.seeded).toBe(true);
    expect(r.finished).toEqual([]);
    expect(r.changed).toBe(false);
    expect(r.next).toEqual(
      new Map([
        [1, "done"],
        [2, "failed"],
        [3, "processing"],
      ])
    );
  });

  it("does NOT re-toast documents already terminal at seed time (no-op poll)", () => {
    const items = [doc(1, "done"), doc(2, "failed")];
    const seed = new Map([
      [1, "done"],
      [2, "failed"],
    ]);
    const r = diffCompletions(seed, items, isTerminal);
    expect(r.finished).toEqual([]);
    expect(r.changed).toBe(false);
    expect(r.seeded).toBe(false);
  });

  it("toasts a processing -> done transition (the async extraction path)", () => {
    const seed = new Map([[1, "processing"]]);
    const r = diffCompletions(seed, [doc(1, "done")], isTerminal);
    expect(r.finished.map((d) => d.id)).toEqual([1]);
    expect(r.finished[0].status).toBe("done");
    expect(r.changed).toBe(true);
  });

  it("toasts a before===undefined terminal (sync import finished within one interval)", () => {
    // A doc that appeared AND landed terminal between polls: not in the seed.
    const seed = new Map([[1, "done"]]);
    const r = diffCompletions(
      seed,
      [doc(1, "done"), doc(2, "skipped")],
      isTerminal
    );
    expect(r.finished.map((d) => d.id)).toEqual([2]);
    expect(r.changed).toBe(true);
  });

  it("does NOT toast a brand-new item still processing (before undefined, not terminal)", () => {
    const seed = new Map([[1, "done"]]);
    const r = diffCompletions(
      seed,
      [doc(1, "done"), doc(2, "processing")],
      isTerminal
    );
    expect(r.finished).toEqual([]);
    expect(r.changed).toBe(true); // set grew, so route should refresh
  });

  it("preserves the full item shape on finished entries (not just id/status)", () => {
    const seed = new Map([[1, "processing"]]);
    const r = diffCompletions(seed, [doc(1, "done", "labs.pdf")], isTerminal);
    expect(r.finished[0].name).toBe("labs.pdf");
  });

  it("flags changed when the set shrinks even with no new terminals", () => {
    const seed = new Map([
      [1, "done"],
      [2, "done"],
    ]);
    const r = diffCompletions(seed, [doc(1, "done")], isTerminal);
    expect(r.finished).toEqual([]);
    expect(r.changed).toBe(true);
  });
});

describe("shouldResetSeed", () => {
  it("does not reset on a fresh mount (seededFor null)", () => {
    expect(shouldResetSeed(null, 1)).toBe(false);
  });

  it("does not reset when the profile is unchanged", () => {
    expect(shouldResetSeed(7, 7)).toBe(false);
  });

  it("resets when the active profile changed (the #296 case)", () => {
    expect(shouldResetSeed(1, 2)).toBe(true);
  });
});
