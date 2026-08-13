"use client";

import { useState } from "react";
import { useConfirm } from "@/components/ConfirmDialog";
import { EmptyState } from "@/components/ui";
import SubjectChip from "@/components/SubjectChip";
import OverflowMenu, {
  MENU_ITEM,
  MENU_ITEM_DANGER,
} from "@/components/OverflowMenu";
import { ResponsiveTable, Td } from "@/components/ResponsiveTable";
import ScrollFade from "@/components/ScrollFade";
import { SortHeaderLabel } from "@/components/SortableHeader";
import { subjectChipVisible, itemAffordanceVisible } from "@/lib/multi-view";
import type { AppRoute } from "@/lib/hrefs";
import type { SubjectInfo } from "@/lib/scope";

// A column of the shared records table. `cell` renders the row's value; the
// shared `.td` base styling is always applied, `cellClassName` (and
// `headerClassName`) add the per-column styling / responsive-hide breakpoints.
// Give a column `sort` to make its header clickable — `value` is the comparison
// key and `initialDir` the direction chosen when it first becomes the active
// sort.
//
// `empty` is the column's emptiness VERDICT for one row, and it is the half of the
// #1426 contract this table was missing (#2588). A cell authored for the desktop
// GRID renders a "—" so the columns stay aligned; on a card there is no grid to
// align, so that placeholder became a fully labeled line ("CHIEF COMPLAINT —")
// saying nothing — three of them on one encounter card. `Td` already knew how to
// drop such a cell (`empty`, from #531–#534: label by what DIFFERS); a column had
// no way to SAY it, so the prop was never threaded. Declare it wherever a cell has
// a placeholder branch: the desktop table is untouched (the cell still renders,
// still aligned), and the card simply omits the line.
//
// The first column is the card TITLE and is structural — `cardCellAttrs` keeps its
// slot regardless — so declaring `empty` there is a no-op, not a hazard.
export interface RecordColumn<T> {
  header: string;
  headerClassName?: string;
  cellClassName?: string;
  cell: (item: T) => React.ReactNode;
  empty?: (item: T) => boolean;
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

// The shared Records list surface: a table whose rows each swap in place for an
// inline edit form (a `colSpan` cell rendering the page's shared <XForm>), with
// record CRUD in the shared overflow menu and the shared EmptyState. Columns and
// the edit form are supplied by the caller so each page keeps its own field set;
// RecordTable owns the shell, the edit toggle, the (optional) header sorting,
// and the delete confirmation.
//
// The shell IS the house primitive set (#1491 item 1): `ResponsiveTable`/`Td`
// stack the rows as cards below `sm` from the SAME DOM (the first column is the
// card title, later columns flow into the labeled meta line — including columns
// the desktop grid hides responsively, which the phone gets back), `ScrollFade`
// carries any horizontal overflow at `sm` and up, headers wear the shared `.th`,
// and a sortable header renders the same `SortHeaderLabel` carets the URL-param
// `SortableHeader` draws. No second content tree, no private header styling.
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
    <div className="card overflow-hidden p-0">
      <ScrollFade>
        <ResponsiveTable className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-black/5 dark:border-white/5">
              {multiView && <th className="th">Profile</th>}
              {columns.map((col, i) =>
                col.sort ? (
                  <th
                    key={i}
                    className={`th ${col.headerClassName ?? ""}`}
                    aria-sort={
                      sortIndex === i
                        ? dir === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(i)}
                      className="inline-flex items-center gap-1 hover:text-brand-700 dark:hover:text-brand-400"
                    >
                      <SortHeaderLabel
                        label={col.header}
                        active={sortIndex === i}
                        dir={dir}
                      />
                    </button>
                  </th>
                ) : (
                  <th key={i} className={`th ${col.headerClassName ?? ""}`}>
                    {col.header}
                  </th>
                )
              )}
              <th className="th" />
            </tr>
          </thead>
          <tbody>
            {rows.map((item) =>
              editingId === item.id ? (
                <tr key={item.id}>
                  <Td slot="full" colSpan={colSpan} className="p-3">
                    {renderEditForm(item, () => setEditingId(null))}
                  </Td>
                </tr>
              ) : (
                <tr
                  key={item.id}
                  className="border-b border-black/5 transition last:border-b-0 hover:bg-slate-50 dark:border-white/5 dark:hover:bg-ink-850"
                >
                  {multiView &&
                    (() => {
                      const subject = multiView.subjectOf(item);
                      const isActing =
                        subject.profileId === multiView.actingProfileId;
                      const visible = subjectChipVisible({
                        multi: true,
                        isActing,
                      });
                      return (
                        <Td slot="meta" empty={!visible} className="align-top">
                          {visible ? <SubjectChip subject={subject} /> : null}
                        </Td>
                      );
                    })()}
                  {columns.map((col, i) => (
                    <Td
                      key={i}
                      slot={i === 0 ? "title" : "meta"}
                      label={i > 0 ? col.header : undefined}
                      empty={col.empty?.(item)}
                      className={col.cellClassName ?? ""}
                    >
                      {col.cell(item)}
                    </Td>
                  ))}
                  <Td slot="actions" className="text-right">
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
                  </Td>
                </tr>
              )
            )}
          </tbody>
        </ResponsiveTable>
      </ScrollFade>
    </div>
  );
}
