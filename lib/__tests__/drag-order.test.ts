import { describe, expect, it } from "vitest";
import { reorderIds } from "../drag-order";

// The one list computation behind every drag-reorder (#1485 C) — the dashboard's
// widget grid and the Trends Overview tiles both move ids through this.

const LIST = ["a", "b", "c", "d"];

describe("reorderIds", () => {
  it("moves the dragged id into the drop target's slot", () => {
    expect(reorderIds(LIST, "a", "c")).toEqual(["b", "c", "a", "d"]);
    expect(reorderIds(LIST, "d", "b")).toEqual(["a", "d", "b", "c"]);
  });

  it("moves to either end", () => {
    expect(reorderIds(LIST, "c", "a")).toEqual(["c", "a", "b", "d"]);
    expect(reorderIds(LIST, "a", "d")).toEqual(["b", "c", "d", "a"]);
  });

  it("is a no-op for a drop on itself", () => {
    expect(reorderIds(LIST, "b", "b")).toEqual(LIST);
  });

  it("is a no-op for a drop outside any sortable", () => {
    // dnd-kit reports `over: null` when the pointer is released over nothing.
    expect(reorderIds(LIST, "b", null)).toEqual(LIST);
  });

  it("is a no-op when either id is unknown", () => {
    // A revalidation landing mid-drag can leave the client holding an id the list
    // no longer has; nothing must move rather than something wrong.
    expect(reorderIds(LIST, "zz", "b")).toEqual(LIST);
    expect(reorderIds(LIST, "b", "zz")).toEqual(LIST);
  });

  it("never mutates its input", () => {
    const input = [...LIST];
    reorderIds(input, "a", "d");
    expect(input).toEqual(LIST);
  });
});
