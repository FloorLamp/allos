"use client";

import { useState, type ReactNode } from "react";
import { IconChevronDown } from "@tabler/icons-react";
import { useConfirm } from "@/components/ConfirmDialog";
import { useUndoableDelete } from "@/components/useUndoableDelete";
import OverflowMenu, {
  MENU_ITEM,
  MENU_ITEM_DANGER,
} from "@/components/OverflowMenu";
import { ResponsiveTable, Td } from "@/components/ResponsiveTable";
import LoggedEventRow from "@/components/LoggedEventRow";
import { CARD_MODE_ONLY } from "@/lib/card-row";

// One column of an entry-history table. `slot` is the cell's card placement
// below `sm` (see components/ResponsiveTable.tsx); `label` is the card-mode
// label for value/meta cells; `empty` is the caller's per-row emptiness verdict
// so a card never shows a "—" line that distinguishes nothing.
export interface EntryHistoryColumn<T> {
  header: string;
  headerClassName?: string;
  // `title` is the row's identity, `trailing` the one attribute beside it on the
  // phone's head line, and `value`/`meta` the labelled detail the compact row
  // discloses on tap (#3671). The vocabulary is lib/card-row.ts's.
  //
  // THE HEAD LINE CARRIES THE ROW'S IDENTITY AND ONE ATTRIBUTE, and the collapse may
  // take neither. Slotting identity as detail is the consumer's to get right (#3937:
  // a stack day read as six identical dates); collapsing a row that has no attribute
  // to keep is the table's, enforced at `collapses` below (#3904).
  slot: "title" | "trailing" | "value" | "meta";
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
//
// The fourth clone — dose history — was still a bespoke `<ul>` when this comment
// was written; #2417 migrated it, so BOTH dose-history scopes (the per-item panel
// and the cross-item ledger) now render here. That migration is what added
// `readOnly`: the dose panel is the first caller with a genuinely read-only
// viewer.
export default function EntryHistoryTable<T extends { id: number }>({
  items,
  columns,
  tableClassName = "w-full text-left text-sm",
  actionsHeaderClassName = "w-16",
  collapsedCount = 5,
  expandToggle,
  readOnly = false,
  menuKind,
  menuItemName,
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
  // A viewer with no write reach on this record (#2417: a caregiver holding a
  // read-only grant on the profile whose dose history this is). The whole Actions
  // column goes away rather than rendering a menu whose every item would refuse —
  // the rows themselves are still the record and stay readable.
  readOnly?: boolean;
  // The row's ⋯ identity (#3501). `menuKind` is the row's noun ("Dose",
  // "Session"); `menuItemName` is the row itself, in whatever form the table
  // already shows it — a time, a date, a name. The finished sentence is
  // lib/overflow-menu-label.ts's, not this table's and not its callers'.
  menuKind?: string;
  menuItemName: (item: T) => string;
  rowTestId?: (item: T) => string;
  editTestId?: (item: T) => string;
  deleteTestId?: (item: T) => string;
  // The caller's inline edit form (fields, submit handling, typed-outcome
  // refusal copy). `done` closes the edit row. OMIT IT and the ⋯ offers Delete
  // alone: a table whose rows are a ROLLUP over events corrects those events
  // somewhere else (#5026 item 1), and an Edit that opened a day-count form there
  // would restate the rollup onto every event under it.
  renderEditForm?: (item: T, done: () => void) => ReactNode;
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
  // THE DISCLOSURE IS ONE ROW'S AND IT IS LOCAL (#3671): nothing is fetched, nothing
  // routes, and the row keeps its ⋯ throughout so an edit never costs an extra tap.
  const [detailId, setDetailId] = useState<number | null>(null);

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

  // Whether this row has anything BEHIND the compact line. A row whose only
  // detail cells are empty (`cardCellAttrs` drops those from the card) discloses
  // nothing, so it gets no toggle rather than a control that opens onto silence.
  function hasDetail(item: T): boolean {
    return columns.some(
      (col) =>
        (col.slot === "value" || col.slot === "meta") && !col.empty?.(item)
    );
  }

  // WHAT LICENSES THE COLLAPSE (#3904). The compact row trades its labelled detail
  // for a head line that still carries a fact, and `trailing` IS that fact. A row
  // with none has nothing to trade: it spends its only content to buy back a line it
  // already occupied. So such a row renders as one already open, which is what
  // `data-expanded` means to `logged-event-rows`, and gets no toggle.
  //
  // PER ROW, NOT PER COLUMN SET. `trailing` is droppable per row — three consumers
  // declare `empty:` on theirs, and `cardCellAttrs` takes an empty one off the card
  // — so a column-set check would call those rows collapsible and be wrong exactly
  // where the defect is. Declaring no `trailing` at all is a legitimate shape (the
  // practice history's second column is the person's own prose); it reaches the
  // verdict through the same question.
  function collapses(item: T): boolean {
    return columns.some((col) => col.slot === "trailing" && !col.empty?.(item));
  }

  const visible =
    expanded || !expandToggle ? items : items.slice(0, collapsedCount);
  const colSpan = columns.length + (readOnly ? 0 : 1);

  return (
    <>
      {/* `logged-event-rows` is EVERY consumer's, never a caller's choice: this
          component IS the seam #3671 scoped its change to, and a class a caller
          could omit would be a second shape of the same row within a week. */}
      <ResponsiveTable className={`logged-event-rows ${tableClassName}`}>
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
            {readOnly ? null : (
              <th className={`th text-right ${actionsHeaderClassName}`}>
                Actions
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {visible.map((item) => (
            <tr
              key={item.id}
              data-testid={rowTestId?.(item)}
              data-expanded={
                !collapses(item) || detailId === item.id ? "" : undefined
              }
              className="border-b border-black/5 align-top last:border-0 dark:border-white/5"
            >
              {renderEditForm && editingId === item.id ? (
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
                      {col.slot === "title" ? (
                        <LoggedEventRow>{col.cell(item)}</LoggedEventRow>
                      ) : (
                        col.cell(item)
                      )}
                    </Td>
                  ))}
                  {collapses(item) && hasDetail(item) ? (
                    <Td slot="toggle" className={`px-2 py-2 ${CARD_MODE_ONLY}`}>
                      <button
                        type="button"
                        className="tap-target flex h-(--control-box) w-(--control-box) items-center justify-center rounded-full text-slate-500 dark:text-slate-400"
                        aria-expanded={detailId === item.id}
                        aria-label={
                          detailId === item.id ? "Hide details" : "Show details"
                        }
                        data-testid={
                          rowTestId ? `${rowTestId(item)}-toggle` : undefined
                        }
                        onClick={() =>
                          setDetailId((current) =>
                            current === item.id ? null : item.id
                          )
                        }
                      >
                        <IconChevronDown
                          aria-hidden
                          className={`h-4 w-4 transition-transform ${
                            detailId === item.id ? "rotate-180" : ""
                          }`}
                        />
                      </button>
                    </Td>
                  ) : null}
                  {readOnly ? null : (
                    <Td slot="actions" className="px-2 py-2">
                      <div className="flex justify-end">
                        <OverflowMenu
                          kind={menuKind}
                          itemName={menuItemName(item)}
                          open={menuOpenId === item.id}
                          onOpenChange={(open) =>
                            setMenuOpenId(open ? item.id : null)
                          }
                        >
                          {({ close }) => (
                            <>
                              {renderEditForm ? (
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
                              ) : null}
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
                  )}
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
