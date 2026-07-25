// Shared, DB-free machinery for the sortable/filterable/groupable tables that
// biomarkers, immunizations and medical documents all re-implement.
// Only the genuinely-shared pure bits live here — column definitions and row
// rendering stay per-table because they differ. The three reusable pieces are:
//
//   1. sort-param (de)serialization — whitelist a `?sort=`/`?dir=` pair against a
//      table's known columns, matching the biomarkers URL pattern so sorting stays
//      server-renderable;
//   2. the SortableHeader toggle rule — which column/direction a header click
//      navigates to (cycles asc↔desc on the active column, else the column's
//      default direction);
//   3. a small comparator kit + a contiguous group-by-key pass — the reusable
//      part biomarkers does server-side to make same-name rows land adjacent under
//      one group header.

export type SortDir = "asc" | "desc";

// --- sort-param (de)serialization ---------------------------------------------

// Resolve a raw `?sort=` value to one of a table's known columns, falling back to
// `fallback` when the param is absent or not a recognized column. Keeps the union
// type so callers switch over it exhaustively.
export function parseSortColumn<C extends string>(
  raw: string | undefined,
  columns: readonly C[],
  fallback: C
): C {
  return (columns as readonly string[]).includes(raw ?? "")
    ? (raw as C)
    : fallback;
}

// Resolve a raw `?dir=` value to a direction, defaulting to `fallback` (asc) for
// anything unrecognized.
export function parseSortDir(
  raw: string | undefined,
  fallback: SortDir = "asc"
): SortDir {
  return raw === "desc" ? "desc" : raw === "asc" ? "asc" : fallback;
}

// --- SortableHeader toggle rule -----------------------------------------------

// The sort/dir a click on `column`'s header should navigate to, given what's
// currently active. Clicking the already-active column flips its direction;
// clicking a different column switches to it starting at its `defaultDir` (so
// date-like columns can open newest-first). Pure so it's unit-tested once and the
// client SortableHeader just serializes the result into the URL.
export function nextSortState(
  activeColumn: string,
  activeDir: SortDir,
  column: string,
  defaultDir: SortDir = "asc"
): { column: string; dir: SortDir } {
  const active = activeColumn === column;
  const dir = active ? (activeDir === "asc" ? "desc" : "asc") : defaultDir;
  return { column, dir };
}

// --- compact sort control (card mode) ------------------------------------------

// A sortable column as the compact control knows it: the same `column` id the
// SortableHeader writes into `?sort=`, its human label, and the direction its
// first click applies (date-like columns open newest-first).
export interface SortChoice {
  column: string;
  label: string;
  defaultDir?: SortDir;
}

// Serialize/parse the `column:dir` pair a single `<select>` carries. Below `sm` the
// responsive tables hide `thead` (the row becomes a card), so header-click sorting
// is unreachable and one select stands in for the whole header strip — it has to
// encode BOTH axes in one value (issue #1426).
export function sortChoiceValue(column: string, dir: SortDir): string {
  return `${column}:${dir}`;
}

// Resolve a raw `column:dir` value against the known choices, falling back to the
// given column/dir for anything unrecognized — the same whitelist discipline
// parseSortColumn applies to the URL params, so a hand-edited value can't inject
// an arbitrary sort key.
export function parseSortChoiceValue(
  raw: string,
  choices: readonly SortChoice[],
  fallback: { column: string; dir: SortDir }
): { column: string; dir: SortDir } {
  const [column, dir] = raw.split(":");
  if (!choices.some((c) => c.column === column)) return fallback;
  if (dir !== "asc" && dir !== "desc") return fallback;
  return { column, dir };
}

// Expand the sortable columns into the select's option list: each column in both
// directions, the column's own default direction FIRST so the common intent
// (newest dates, A–Z names) is the nearer option. Directions are spelled out
// rather than drawn as arrow glyphs so a screen reader announces the option
// meaningfully.
export function sortChoiceOptions(
  choices: readonly SortChoice[]
): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  for (const c of choices) {
    const first: SortDir = c.defaultDir ?? "asc";
    const second: SortDir = first === "asc" ? "desc" : "asc";
    for (const dir of [first, second]) {
      out.push({
        value: sortChoiceValue(c.column, dir),
        label: `${c.label} (${dir === "asc" ? "ascending" : "descending"})`,
      });
    }
  }
  return out;
}

// --- comparator kit -----------------------------------------------------------

// A sortable cell value: a string or number to order by, or null/undefined for
// "no value". `null`/`undefined` always sort last (in both directions) — the
// predictable convention for rows missing the sort key. Note this is distinct
// from an empty string, which is an ordinary string that sorts first ascending;
// callers wanting empty-first ordering (as the immunizations table does for
// dose-less vaccines) should map their absent value to "" rather than null.
export type SortValue = string | number | null | undefined;

// Order two non-null values: numbers numerically, everything else by localeCompare
// on their string form. Used under the direction/null handling in `sortRows`.
function compareNonNull(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

// Stable sort of `rows` by `key` in `dir`, with null/undefined keys pinned last
// regardless of direction. An optional `tieBreak` (always applied ascending)
// gives equal-key rows a predictable order. Returns a new array; the input is not
// mutated.
export function sortRows<T>(
  rows: readonly T[],
  key: (row: T) => SortValue,
  dir: SortDir,
  tieBreak?: (row: T) => string | number
): T[] {
  const mul = dir === "asc" ? 1 : -1;
  return [...rows].sort((x, y) => {
    const kx = key(x);
    const ky = key(y);
    // Nulls last in both directions: decide them before applying `mul`.
    const xn = kx == null;
    const yn = ky == null;
    if (!xn || !yn) {
      if (xn) return 1;
      if (yn) return -1;
      const c = compareNonNull(kx, ky) * mul;
      if (c !== 0) return c;
    }
    return tieBreak ? compareNonNull(tieBreak(x), tieBreak(y)) : 0;
  });
}

// --- contiguous group-by-key --------------------------------------------------

// One row paired with its group key and whether it opens/closes a run of same-key
// rows. Consumed by name-sorted tables to show the group name once (on the start
// row) and draw a group-closing border only on the end row.
export interface GroupedRow<T> {
  row: T;
  key: string;
  isGroupStart: boolean;
  isGroupEnd: boolean;
}

// Walk already-sorted `rows`, marking each as the start/end of a contiguous run
// of the same `key`. This is the reusable grouping biomarkers does inline: rows
// must already be ordered so equal keys are adjacent (i.e. sorted by the same
// key), otherwise a key can open more than one group.
export function groupContiguous<T>(
  rows: readonly T[],
  key: (row: T) => string
): GroupedRow<T>[] {
  return rows.map((row, i) => {
    const k = key(row);
    return {
      row,
      key: k,
      isGroupStart: i === 0 || key(rows[i - 1]) !== k,
      isGroupEnd: i === rows.length - 1 || key(rows[i + 1]) !== k,
    };
  });
}
