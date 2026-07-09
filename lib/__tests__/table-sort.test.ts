import { describe, it, expect } from "vitest";
import {
  parseSortColumn,
  parseSortDir,
  nextSortState,
  sortRows,
  groupContiguous,
} from "../table-sort";

const COLUMNS = ["name", "date", "status"] as const;

describe("parseSortColumn", () => {
  it("returns a recognized column", () => {
    expect(parseSortColumn("date", COLUMNS, "name")).toBe("date");
  });

  it("falls back for an unknown column", () => {
    expect(parseSortColumn("bogus", COLUMNS, "name")).toBe("name");
  });

  it("falls back for a missing param", () => {
    expect(parseSortColumn(undefined, COLUMNS, "status")).toBe("status");
  });
});

describe("parseSortDir", () => {
  it("reads desc", () => {
    expect(parseSortDir("desc")).toBe("desc");
  });

  it("reads asc", () => {
    expect(parseSortDir("asc")).toBe("asc");
  });

  it("defaults unknown values to the fallback", () => {
    expect(parseSortDir(undefined)).toBe("asc");
    expect(parseSortDir("nonsense", "desc")).toBe("desc");
  });
});

describe("nextSortState", () => {
  it("flips direction when clicking the active column", () => {
    expect(nextSortState("date", "asc", "date")).toEqual({
      column: "date",
      dir: "desc",
    });
    expect(nextSortState("date", "desc", "date")).toEqual({
      column: "date",
      dir: "asc",
    });
  });

  it("switches column starting at its default direction", () => {
    expect(nextSortState("name", "desc", "date", "desc")).toEqual({
      column: "date",
      dir: "desc",
    });
    expect(nextSortState("name", "asc", "date")).toEqual({
      column: "date",
      dir: "asc",
    });
  });
});

describe("sortRows", () => {
  const rows = [
    { name: "Charlie", n: 3, d: "2024-03-01" },
    { name: "alpha", n: 1, d: "2024-01-01" },
    { name: "Bravo", n: 2, d: null as string | null },
  ];

  it("sorts strings case-insensitively-ish via localeCompare ascending", () => {
    expect(sortRows(rows, (r) => r.name, "asc").map((r) => r.name)).toEqual([
      "alpha",
      "Bravo",
      "Charlie",
    ]);
  });

  it("reverses on descending", () => {
    expect(sortRows(rows, (r) => r.name, "desc").map((r) => r.name)).toEqual([
      "Charlie",
      "Bravo",
      "alpha",
    ]);
  });

  it("sorts numbers numerically, not lexically", () => {
    const nums = [{ n: 10 }, { n: 2 }, { n: 1 }];
    expect(sortRows(nums, (r) => r.n, "asc").map((r) => r.n)).toEqual([
      1, 2, 10,
    ]);
  });

  it("pins null keys last in both directions", () => {
    expect(sortRows(rows, (r) => r.d, "asc").map((r) => r.name)).toEqual([
      "alpha",
      "Charlie",
      "Bravo",
    ]);
    expect(sortRows(rows, (r) => r.d, "desc").map((r) => r.name)).toEqual([
      "Charlie",
      "alpha",
      "Bravo",
    ]);
  });

  it("treats empty string as an ordinary value (first ascending, not pinned)", () => {
    const withEmpty = [{ v: "b" }, { v: "" }, { v: "a" }];
    expect(sortRows(withEmpty, (r) => r.v, "asc").map((r) => r.v)).toEqual([
      "",
      "a",
      "b",
    ]);
    expect(sortRows(withEmpty, (r) => r.v, "desc").map((r) => r.v)).toEqual([
      "b",
      "a",
      "",
    ]);
  });

  it("applies the tie-break ascending regardless of primary direction", () => {
    const tied = [
      { g: 1, name: "y" },
      { g: 1, name: "x" },
      { g: 2, name: "a" },
    ];
    expect(
      sortRows(
        tied,
        (r) => r.g,
        "desc",
        (r) => r.name
      ).map((r) => r.name)
    ).toEqual(["a", "x", "y"]);
  });

  it("does not mutate the input array", () => {
    const input = [{ n: 3 }, { n: 1 }];
    const copy = [...input];
    sortRows(input, (r) => r.n, "asc");
    expect(input).toEqual(copy);
  });
});

describe("groupContiguous", () => {
  it("marks the start and end of each contiguous run", () => {
    const rows = [
      { id: 1, name: "A" },
      { id: 2, name: "A" },
      { id: 3, name: "B" },
    ];
    const g = groupContiguous(rows, (r) => r.name);
    expect(g.map((x) => [x.isGroupStart, x.isGroupEnd])).toEqual([
      [true, false],
      [false, true],
      [true, true],
    ]);
    expect(g.map((x) => x.key)).toEqual(["A", "A", "B"]);
  });

  it("treats a single row as its own complete group", () => {
    const g = groupContiguous([{ name: "solo" }], (r) => r.name);
    expect(g[0].isGroupStart).toBe(true);
    expect(g[0].isGroupEnd).toBe(true);
  });

  it("opens a fresh group each time a non-adjacent key repeats", () => {
    const rows = [{ k: "A" }, { k: "B" }, { k: "A" }];
    const g = groupContiguous(rows, (r) => r.k);
    // Every row is an isolated group because equal keys aren't adjacent.
    expect(g.every((x) => x.isGroupStart && x.isGroupEnd)).toBe(true);
  });

  it("returns an empty array for no rows", () => {
    expect(groupContiguous([], (r: { k: string }) => r.k)).toEqual([]);
  });
});
