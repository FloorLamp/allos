"use client";

import { useState } from "react";
import {
  IconPencil,
  IconTrash,
  IconCaretUpFilled,
  IconCaretDownFilled,
} from "@tabler/icons-react";
import { useConfirm } from "@/components/ConfirmDialog";
import { EmptyState } from "@/components/ui";

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

// The shared Records list surface (issue #180 pattern): a `card` table whose rows
// each swap in place for an inline edit form (a `colSpan` cell rendering the
// page's shared <XForm>), with a per-row pencil (edit) + trash (confirm → delete)
// action cell and the shared EmptyState. Columns and the edit form are supplied by
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
}: {
  items: T[];
  columns: RecordColumn<T>[];
  renderEditForm: (item: T, done: () => void) => React.ReactNode;
  onDelete: (item: T) => void | Promise<void>;
  confirmDelete: (item: T) => DeleteConfirm;
  emptyMessage: string;
  // Column index (into `columns`, must be sortable) + direction to sort by on
  // mount. Omit for an unsorted table that renders `items` in the given order.
  defaultSort?: { index: number; dir: "asc" | "desc" };
  // Stable tie-break applied after the active sort comparison (not direction-
  // flipped), so equal keys keep a predictable order.
  tieBreak?: (a: T, b: T) => number;
}) {
  const confirm = useConfirm();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [sortIndex, setSortIndex] = useState<number | null>(
    defaultSort?.index ?? null
  );
  const [dir, setDir] = useState<"asc" | "desc">(defaultSort?.dir ?? "asc");

  // Plain-button delete (not a form action) so confirm() can open a dialog the
  // user must answer before the destructive delete runs.
  async function handleDelete(item: T) {
    const opts = confirmDelete(item);
    const ok = await confirm({
      title: opts.title,
      message: opts.message,
      confirmLabel: opts.confirmLabel ?? "Delete",
      danger: true,
    });
    if (!ok) return;
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
    return <EmptyState message={emptyMessage} />;
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

  const colSpan = columns.length + 1;

  return (
    <div className="card overflow-x-auto p-0">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-black/5 dark:border-white/5">
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
        <tbody>
          {rows.map((item) =>
            editingId === item.id ? (
              <tr key={item.id}>
                <td colSpan={colSpan} className="p-3">
                  {renderEditForm(item, () => setEditingId(null))}
                </td>
              </tr>
            ) : (
              <tr
                key={item.id}
                className="border-b border-black/5 transition hover:bg-slate-50 dark:border-white/5 dark:hover:bg-ink-850"
              >
                {columns.map((col, i) => (
                  <td
                    key={i}
                    className={`px-3 py-2 ${col.cellClassName ?? ""}`}
                  >
                    {col.cell(item)}
                  </td>
                ))}
                <td className="px-3 py-2">
                  <div className="flex items-center justify-end gap-1">
                    <button
                      type="button"
                      onClick={() => setEditingId(item.id)}
                      aria-label="Edit"
                      className="tap-target flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-ink-800"
                    >
                      <IconPencil className="h-4 w-4" stroke={1.75} />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(item)}
                      aria-label="Delete"
                      className="tap-target flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition hover:bg-rose-50 hover:text-rose-600 dark:text-slate-400 dark:hover:bg-rose-950 dark:hover:text-rose-400"
                    >
                      <IconTrash className="h-4 w-4" stroke={1.75} />
                    </button>
                  </div>
                </td>
              </tr>
            )
          )}
        </tbody>
      </table>
    </div>
  );
}
