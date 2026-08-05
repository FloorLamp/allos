"use client";

import { useState, type ReactNode } from "react";
import { useConfirm } from "@/components/ConfirmDialog";
import { useUndoableDelete } from "@/components/useUndoableDelete";
import OverflowMenu, {
  MENU_ITEM,
  MENU_ITEM_DANGER,
} from "@/components/OverflowMenu";
import { ResponsiveTable, Td } from "@/components/ResponsiveTable";

// One column of an entry-history table. `slot` is the cell's card placement
// below `sm` (see components/ResponsiveTable.tsx); `label` is the card-mode
// label for value/meta cells; `empty` is the caller's per-row emptiness verdict
// so a card never shows a "—" line that distinguishes nothing.
export interface EntryHistoryColumn<T> {
  header: string;
  headerClassName?: string;
  slot: "title" | "value" | "meta";
  label?: string;
  cellClassName?: string;
  empty?: (item: T) => boolean;
  cell: (item: T) => ReactNode;
}

// The shared entry-history table (#1491, consolidation-survey addendum).
//
// "A dated log entry with inline edit, ⋯ edit/delete, undoable delete, and a
// collapsed-N expand toggle" had become a four-way structural clone — practice
// sessions, substance consumption (the newest copy, +657 lines in #2026),
// screening instruments, and dose history — each independently maintaining the
// same collapsed-count constant, the same editingId/menuOpenId state trio, the
// same full-width inline edit row, and the same primitive set. This component
// owns that shape once:
//
//   - the ResponsiveTable/`.th` shell and the slotted card presentation,
//   - the collapsed-5 window with the expand/collapse toggle,
//   - the edit-in-place swap (a `Td slot="full"` row rendering the caller's
//     form — the form itself stays with the caller, because each domain's
//     typed mutation outcomes and refusal copy are its own),
//   - the ⋯ menu with Edit/Delete, and
//   - the delete path: shared confirm dialog, then `useUndoableDelete` — every
//     "remove one logged event" is undoable by owner ruling (2026-08-05;
//     practice sessions and substance rows both return `{undoId}` since #2038).
//
// Per-surface test ids are parameters, so existing specs keep their hooks.
export default function EntryHistoryTable<T extends { id: number }>({
  items,
  columns,
  tableClassName = "w-full text-left text-sm",
  actionsHeaderClassName = "w-16",
  collapsedCount = 5,
  expandToggle,
  menuLabel,
  rowTestId,
  editTestId,
  deleteTestId,
  renderEditForm,
  confirmDelete,
  deleteFormData,
  deleteAction,
  deletedMessage,
  onDeleteError,
}: {
  items: T[];
  columns: EntryHistoryColumn<T>[];
  tableClassName?: string;
  actionsHeaderClassName?: string;
  collapsedCount?: number;
  // Labels for the below-table window toggle; omit to always show every row.
  expandToggle?: {
    collapsedLabel: string;
    expandedLabel: string;
    testId?: string;
  };
  menuLabel: string | ((item: T) => string);
  rowTestId?: (item: T) => string;
  editTestId?: (item: T) => string;
  deleteTestId?: (item: T) => string;
  // The caller's inline edit form (fields, submit handling, typed-outcome
  // refusal copy). `done` closes the edit row.
  renderEditForm: (item: T, done: () => void) => ReactNode;
  confirmDelete: (item: T) => {
    title: string;
    message: string;
    confirmLabel?: string;
  };
  // The delete request body (ids, discriminators) for `deleteAction`, which
  // must return `{ undoId }` — the shared undoable-delete contract.
  deleteFormData: (item: T) => FormData;
  deleteAction: (
    fd: FormData
  ) => Promise<
    | { undoId: number | null; error?: string }
    | { undoIds: number[]; error?: string }
  >;
  deletedMessage: string;
  // Called when the delete throws (the caller's error toast); omit to let the
  // error propagate.
  onDeleteError?: () => void;
}) {
  const confirm = useConfirm();
  const undoable = useUndoableDelete();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);

  async function remove(item: T) {
    const opts = confirmDelete(item);
    const ok = await confirm({
      title: opts.title,
      message: opts.message,
      confirmLabel: opts.confirmLabel ?? "Delete",
      danger: true,
    });
    if (!ok) return;
    setDeletingId(item.id);
    if (editingId === item.id) setEditingId(null);
    try {
      await undoable(deleteAction, deleteFormData(item), {
        deletedMessage,
      });
    } catch (err) {
      if (onDeleteError) onDeleteError();
      else throw err;
    } finally {
      setDeletingId(null);
    }
  }

  const visible =
    expanded || !expandToggle ? items : items.slice(0, collapsedCount);
  const colSpan = columns.length + 1;

  return (
    <>
      <ResponsiveTable className={tableClassName}>
        <thead>
          <tr className="border-b border-black/10 text-xs text-slate-500 dark:border-white/10 dark:text-slate-400">
            {columns.map((col) => (
              <th
                key={col.header}
                className={`th ${col.headerClassName ?? ""}`}
              >
                {col.header}
              </th>
            ))}
            <th className={`th text-right ${actionsHeaderClassName}`}>
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {visible.map((item) => (
            <tr
              key={item.id}
              data-testid={rowTestId?.(item)}
              className="border-b border-black/5 align-top last:border-0 dark:border-white/5"
            >
              {editingId === item.id ? (
                <Td slot="full" colSpan={colSpan} className="px-2 py-2">
                  {renderEditForm(item, () => setEditingId(null))}
                </Td>
              ) : (
                <>
                  {columns.map((col) => (
                    <Td
                      key={col.header}
                      slot={col.slot}
                      label={col.label}
                      empty={col.empty?.(item)}
                      className={`px-2 py-2 ${col.cellClassName ?? ""}`}
                    >
                      {col.cell(item)}
                    </Td>
                  ))}
                  <Td slot="actions" className="px-2 py-2">
                    <div className="flex justify-end">
                      <OverflowMenu
                        label={
                          typeof menuLabel === "string"
                            ? menuLabel
                            : menuLabel(item)
                        }
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
                              data-testid={editTestId?.(item)}
                              onClick={() => {
                                close();
                                setEditingId(item.id);
                              }}
                              className={MENU_ITEM}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              data-testid={deleteTestId?.(item)}
                              disabled={deletingId === item.id}
                              onClick={() => {
                                close();
                                void remove(item);
                              }}
                              className={MENU_ITEM_DANGER}
                            >
                              Delete
                            </button>
                          </>
                        )}
                      </OverflowMenu>
                    </div>
                  </Td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </ResponsiveTable>
      {expandToggle && items.length > collapsedCount ? (
        <button
          type="button"
          className="mt-2 text-sm font-medium text-brand-700 hover:underline dark:text-brand-300"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          data-testid={expandToggle.testId}
        >
          {expanded ? expandToggle.expandedLabel : expandToggle.collapsedLabel}
        </button>
      ) : null}
    </>
  );
}
