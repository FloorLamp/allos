import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DataTableManager from "@/components/DataTableManager";
import { PENDING_COLUMNS } from "@/lib/export-manifest";

// PENDING COLUMNS ARE OFF THE SCREEN AND STILL IN THE EXPORT (#5273).
//
// `bundle_id` ships on four exported datasets; two of them have no writer yet, so
// the column is empty on every row. The archive keeps it — two archives diff
// cleanly across versions, and manifest.json names it as pending — but the Data →
// Manage tables have no manifest beside them, so a permanently blank column there
// reads as broken. Hence the guard, and hence BOTH DIRECTIONS below: a guard that
// hides too much passes an absence-only test.
//
// The over-reaching guards this is written to red on:
//   * matching the column NAME alone — `intake_log`/`food_log_events` carry a
//     WRITTEN `bundle_id`, and hiding it hides real values a person entered;
//   * dropping columns that are null on every row of the page — `notes` and
//     `skip_reason` below are exactly that and must still be shown, since an
//     empty page is not the same claim as an empty column;
//   * matching a prefix or a substring — the expected header list is EXACT.
//
// The datasets are the real ones (lib/export.ts), spelled out here rather than
// imported: `@/lib/export` opens the database at module load, and this tier is
// pure. The column lists are trimmed to what each claim needs. That PENDING_COLUMNS
// really names columns of those datasets is pinned in the DB tier
// (lib/__db_tests__/export.test.ts).

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {} }),
  usePathname: () => "/data",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/Toast", () => ({ useToast: () => () => {} }));
// Server actions: "use server" modules that reach the database on import.
vi.mock("@/app/(app)/data/manage-actions", () => ({
  deleteDatasetRows: async () => ({ ok: true, deleted: 0, undoIds: [] }),
  deleteAllDatasetRows: async () => ({ ok: true, deleted: 0, undoIds: [] }),
}));
vi.mock("@/app/(app)/undo-actions", () => ({
  undoDeletes: async () => ({ restored: 0 }),
}));

beforeEach(() => {
  // ScrollFade wraps the table and observes its own box.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

const CASES = [
  {
    key: "body_metrics",
    label: "Body metrics",
    // `bundle_id` has no writer here; `notes` has one and is simply empty today.
    columns: ["date", "weight_kg", "notes", "bundle_id"],
    row: { id: 1, date: "2026-09-01", weight_kg: 70.5, notes: null, bundle_id: null },
    pending: true,
    shown: ["date", "weight_kg", "notes"],
    cells: ["2026-09-01", "70.5", ""],
  },
  {
    key: "practice_logs",
    label: "Practice sessions",
    columns: ["practice", "date", "notes", "bundle_id"],
    row: { id: 2, practice: "Breathing", date: "2026-09-02", notes: null, bundle_id: null },
    pending: true,
    shown: ["practice", "date", "notes"],
    cells: ["Breathing", "2026-09-02", ""],
  },
  {
    key: "intake_log",
    label: "Supplement & medication log",
    // The SAME column name, written: one act's doses share a bundle id.
    columns: ["date", "item", "skip_reason", "bundle_id"],
    row: { id: 3, date: "2026-09-03", item: "Vitamin D", skip_reason: null, bundle_id: "bundle 12" },
    pending: false,
    shown: ["date", "item", "skip_reason", "bundle_id"],
    cells: ["2026-09-03", "Vitamin D", "", "bundle 12"],
  },
] as const;

function mount(c: (typeof CASES)[number]) {
  render(
    <DataTableManager
      dataset={{
        key: c.key,
        label: c.label,
        columns: [...c.columns],
        deletable: true,
      }}
      rows={[{ ...c.row }]}
      total={1}
      page={1}
      pageSize={25}
      pageParam={`p_${c.key}`}
    />
  );
  return screen.getByTestId(`dataset-${c.key}`);
}

describe("Data → Manage tables and the columns nothing writes yet", () => {
  // The fixture's premise, so neither direction can go quietly vacuous: an empty
  // PENDING_COLUMNS would make the absence assertions pass against a guard that
  // does nothing. When a writer lands and its entry is deleted, this reds first
  // and points at the case below that must move with it.
  it.each(CASES)("$key.bundle_id pending is $pending", ({ key, pending }) => {
    expect(
      PENDING_COLUMNS.some(
        (p) => p.dataset === key && p.column === "bundle_id"
      ),
      `${key}.bundle_id in PENDING_COLUMNS`
    ).toBe(pending);
  });

  it.each(CASES)("$key headers are exactly $shown", (c) => {
    const card = mount(c);
    expect(
      within(card)
        .getAllByRole("columnheader")
        .map((th) => th.textContent)
    ).toEqual([...c.shown]);
  });

  // The cells travel with the headers or the table shears: every row would carry
  // one value too many and each one would sit under the wrong name.
  it.each(CASES)("$key row cells line up with $shown", (c) => {
    const card = mount(c);
    expect(
      within(within(card).getAllByRole("row")[1]!)
        .getAllByRole("cell")
        .map((td) => td.textContent)
    ).toEqual([...c.cells]);
  });
});
