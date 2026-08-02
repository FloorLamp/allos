"use client";

import { useState } from "react";
import { IconCaretUpFilled, IconCaretDownFilled } from "@tabler/icons-react";
import { useConfirm } from "@/components/ConfirmDialog";
import { EmptyState } from "@/components/ui";
import SubjectChip from "@/components/SubjectChip";
import OverflowMenu, {
  MENU_ITEM,
  MENU_ITEM_DANGER,
} from "@/components/OverflowMenu";
import { subjectChipVisible, itemAffordanceVisible } from "@/lib/multi-view";
import type { AppRoute } from "@/lib/hrefs";
import type { SubjectInfo } from "@/lib/scope";

// A column of the shared records table. `cell` renders the row's value; the base
// `px-3 py-2` padding is always applied, `cellClassName` (and `headerClassName`)
// add the per-column styling / responsive-hide breakpoints. Give a column `sort`
// to make its header clickable — `value` is the comparison key and `initialDir`
// the direction chosen when it first becomes the active sort.
export interface RecordColumn<T> {
  header: string;
  headerClassName?: string;
  cellClassName?: string;
  cell: (item: T) => React.ReactNode;
  sort?: {
    value: (item: T) => string;
    initialDir?: "asc" | "desc";
  };
}

// Options for the delete confirmation dialog (danger-styled by RecordTable).
export interface DeleteConfirm {
  title: string;
  message: string;
  confirmLabel?: string;
}

// Multi-view (#1328): when the page reads several profiles into view, RecordTable
// prepends a "Profile" column carrying a subject chip on each NON-acting row and gates
// the per-row edit/delete affordances on the SUBJECT's write access (a read-only-
// granted member's rows show no write buttons — the #858 per-item access rule via
// itemAffordanceVisible). Absent (single-view, the default and the byte-identical
// regression bar) the extra column and the gate both vanish — the table renders
// exactly as before. `subjectOf` reads the row's stamped subject (stampSubjects).
export interface RecordTableMultiView<T> {
  actingProfileId: number;
  subjectOf: (item: T) => SubjectInfo;
}

// The shared Records list surface: a `card` table whose rows
// each swap in place for an inline edit form (a `colSpan` cell rendering the
// page's shared <XForm>), with record CRUD in the shared overflow menu and the
// shared EmptyState. Columns and the edit form are supplied by
// the caller so each page keeps its own field set; RecordTable owns the shell, the
// edit toggle, the (optional) header sorting, and the delete confirmation.
export default function RecordTable<T extends { id: number }>({
  items,
  columns,
  renderEditForm,
  onDelete,
  confirmDelete,
  emptyMessage,
  defaultSort,
  tieBreak,
  multiView,
  emptyActions,
}: {
  items: T[];
  columns: RecordColumn<T>[];
  renderEditForm: (item: T, done: () => void) => React.ReactNode;
  onDelete: (item: T) => void | Promise<void>;
  confirmDelete: (item: T) => DeleteConfirm;
  emptyMessage: string;
  emptyActions?: ReadonlyArray<{ href: AppRoute; label: string }>;
  // Column index (into `columns`, must be sortable) + direction to sort by on
  // mount. Omit for an unsorted table that renders `items` in the given order.
  defaultSort?: { index: number; dir: "asc" | "desc" };
  // Stable tie-break applied after the active sort comparison (not direction-
  // flipped), so equal keys keep a predictable order.
  tieBreak?: (a: T, b: T) => number;
  // Present ONLY in multi-profile view (#1328) — the leading subject column + the
  // per-item write-affordance gate. Omitted in single view → byte-identical.
  multiView?: RecordTableMultiView<T>;
}) {
  const confirm = useConfirm();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<number | null>(null);
  const [sortIndex, setSortIndex] = useState<number | null>(
    defaultSort?.index ?? null
  );
  const [dir, setDir] = useState<"asc" | "desc">(defaultSort?.dir ?? "asc");

  // Plain-button delete (not a form action) so confirm() can open a dialog the
  // user must answer before the destructive delete runs.
  async function handleDelete(item: T, close: () => void) {
    const opts = confirmDelete(item);
    const ok = await confirm({
      title: opts.title,
      message: opts.message,
      confirmLabel: opts.confirmLabel ?? "Delete",
      danger: true,
    });
    if (!ok) return;
    close();
    await onDelete(item);
  }

  function toggleSort(index: number) {
    const col = columns[index];
    if (!col.sort) return;
    if (index === sortIndex) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortIndex(index);
      setDir(col.sort.initialDir ?? "asc");
    }
  }

  if (items.length === 0) {
    return <EmptyState message={emptyMessage} actions={emptyActions} />;
  }

  const sortCol = sortIndex != null ? columns[sortIndex] : null;
  const rows =
    sortCol?.sort != null
      ? [...items].sort((a, b) => {
          const c = sortCol
            .sort!.value(a)
            .localeCompare(sortCol.sort!.value(b));
          return (dir === "asc" ? c : -c) || (tieBreak ? tieBreak(a, b) : 0);
        })
      : items;

  const colSpan = columns.length + 1 + (multiView ? 1 : 0);

  return (
    <div className="card overflow-visible p-0 sm:overflow-x-auto">
      <table className="block w-full border-collapse text-sm sm:table">
        <thead className="hidden sm:table-header-group">
          <tr className="border-b border-black/5 dark:border-white/5">
            {multiView && (
              <th className="px-3 py-2 text-left font-semibold text-slate-600 dark:text-slate-300">
                Profile
              </th>
            )}
            {columns.map((col, i) =>
              col.sort ? (
                <th
                  key={i}
                  className={`cursor-pointer select-none px-3 py-2 text-left font-semibold text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100 ${
                    col.headerClassName ?? ""
                  }`}
                  onClick={() => toggleSort(i)}
                  aria-sort={
                    sortIndex === i
                      ? dir === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                >
                  <span className="inline-flex items-center gap-1">
                    {col.header}
                    {sortIndex === i &&
                      (dir === "asc" ? (
                        <IconCaretUpFilled className="h-3 w-3" />
                      ) : (
                        <IconCaretDownFilled className="h-3 w-3" />
                      ))}
                  </span>
                </th>
              ) : (
                <th
                  key={i}
                  className={`px-3 py-2 text-left font-semibold text-slate-600 dark:text-slate-300 ${
                    col.headerClassName ?? ""
                  }`}
                >
                  {col.header}
                </th>
              )
            )}
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody className="block sm:table-row-group">
          {rows.map((item) =>
            editingId === item.id ? (
              <tr key={item.id} className="block sm:table-row">
                <td colSpan={colSpan} className="block p-3 sm:table-cell">
                  {renderEditForm(item, () => setEditingId(null))}
                </td>
              </tr>
            ) : (
              <tr
                key={item.id}
                className="relative grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 border-b border-black/5 px-3 py-3 transition last:border-b-0 hover:bg-slate-50 sm:table-row sm:p-0 dark:border-white/5 dark:hover:bg-ink-850"
              >
                {multiView &&
                  (() => {
                    const subject = multiView.subjectOf(item);
                    const isActing =
                      subject.profileId === multiView.actingProfileId;
                    return (
                      <td className="col-span-2 row-start-1 mb-1 block p-0 align-top sm:table-cell sm:px-3 sm:py-2">
                        {subjectChipVisible({ multi: true, isActing }) ? (
                          <SubjectChip subject={subject} />
                        ) : null}
                      </td>
                    );
                  })()}
                {columns.map((col, i) => (
                  <td
                    key={i}
                    className={`min-w-0 ${
                      i === 0
                        ? `col-start-1 ${
                            multiView ? "row-start-2" : "row-start-1"
                          } block pr-2 sm:table-cell sm:px-3 sm:py-2`
                        : `col-span-2 mt-1 flex items-start gap-2 p-0 text-sm sm:px-3 sm:py-2 ${
                            // A caller that declares `hidden` also owns the
                            // breakpoint that reveals this column (often md).
                            // Adding sm:table-cell here would override it early.
                            col.cellClassName?.split(/\s+/).includes("hidden")
                              ? ""
                              : "sm:table-cell"
                          }`
                    } ${col.cellClassName ?? ""}`}
                  >
                    {i > 0 ? (
                      <span className="w-24 shrink-0 text-xs font-medium text-slate-400 sm:hidden">
                        {col.header}
                      </span>
                    ) : null}
                    {col.cell(item)}
                  </td>
                ))}
                <td
                  className={`col-start-2 ${
                    multiView ? "row-start-2" : "row-start-1"
                  } block p-0 sm:table-cell sm:px-3 sm:py-2`}
                >
                  {(() => {
                    // Per-item write gate (#858/#1328): in multi-view a row whose
                    // SUBJECT is read-only-granted shows no edit/delete; single-view
                    // rows are the acting profile and always show them.
                    const canWrite = multiView
                      ? itemAffordanceVisible("item", {
                          isActing:
                            multiView.subjectOf(item).profileId ===
                            multiView.actingProfileId,
                          subjectCanWrite:
                            multiView.subjectOf(item).access === "write",
                        })
                      : true;
                    if (!canWrite) return null;
                    return (
                      <div className="flex items-center justify-end">
                        <OverflowMenu
                          label="Record actions"
                          open={menuOpenId === item.id}
                          onOpenChange={(open) =>
                            setMenuOpenId(open ? item.id : null)
                          }
                        >
                          {({ close }) => (
                            <>
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setEditingId(item.id);
                                  close();
                                }}
                                className={MENU_ITEM}
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => handleDelete(item, close)}
                                className={MENU_ITEM_DANGER}
                              >
                                Delete
                              </button>
                            </>
                          )}
                        </OverflowMenu>
                      </div>
                    );
                  })()}
                </td>
              </tr>
            )
          )}
        </tbody>
      </table>
    </div>
  );
}
