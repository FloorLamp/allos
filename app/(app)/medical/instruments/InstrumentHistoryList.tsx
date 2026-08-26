"use client";

import { useState } from "react";
import Link from "next/link";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import OverflowMenu, {
  MENU_ITEM,
  MENU_ITEM_DANGER,
} from "@/components/OverflowMenu";
import { EmptyState } from "@/components/ui";
import { useConfirm } from "@/components/ConfirmDialog";
import { useUndoableDelete } from "@/components/useUndoableDelete";
import SourceDocumentLink from "@/components/SourceDocumentLink";
import type { AppRoute } from "@/lib/hrefs";
import type { FormResult } from "@/lib/types";

// The screening-instrument History list, with per-row CORRECT and REMOVE (#1396).
//
// Both instrument surfaces render this ONE component — Records › Mental health and
// Records › Specialty › Substance use — because the rows are the same kind of row
// (a `medical_records` score) and the correction affordance must not diverge between
// a PHQ-9 and an AUDIT-C. The surfaces differ only in which Server Actions they pass
// (the substance pair carries that surface's life-stage gate) and in the testid
// prefix their existing specs already use.
//
// Why this exists at all: a score used to be create-only, so a mis-typed outside
// total permanently distorted the trend and could permanently trip the
// non-dismissible crisis line. Removal goes through the shared undoable-delete toast
// (#30) — a destructive action on a sensitive record should be recoverable — and the
// edit answers from the action's TYPED outcome, so an in-app administered reading
// (whose total is derived from its item answers) refuses a total change out loud
// instead of silently accepting one.
//
// ── THE TWO AFFORDANCES FOLD (#3408, item F) ────────────────────────────────
//
// They used to stand: a ghost "Correct" AND a red "Remove" rendered on EVERY row,
// which made a permanently-drawn destructive button the loudest thing on a pane
// that is otherwise one row and an empty screen. Every comparable row in this app
// — a food serving, a dose, an appointment — folds those same two verbs behind
// the ⋯ `OverflowMenu`; `FoodLogBar`'s menu even uses the identical words. This
// row was the outlier, so it adopts the grammar rather than the grammar bending.
//
// WHAT THE ⋯ BRINGS THAT TWO BUTTONS DID NOT: below `md` it is not a menu at all
// but a bottom ACTION SHEET (#3374, through components/overlay/AnchoredPanel.tsx),
// with tap-floor rows, a focus trap and focus restored to the trigger. Nothing
// here had to know that — the decision lives in the host.
//
// THE INLINE CORRECTION FORM IS UNCHANGED. Only the standing affordances fold;
// picking "Correct" still expands the same edit-in-place form under the same row,
// with the same testids the existing specs use. And Remove still confirms before
// it deletes — the fold moved the button, not the guard.

export interface InstrumentHistoryRow {
  id: number;
  instrument: string;
  date: string;
  total: number;
  bandLabel: string;
  // The instrument's maximum possible total, for the correction field's bounds.
  maxTotal: number;
  // Deep link to this instrument's trend, resolved on the server.
  href: AppRoute;
  documentId?: number | null;
}

export default function InstrumentHistoryList({
  rows,
  updateAction,
  deleteAction,
  testidPrefix,
  emptyMessage,
}: {
  rows: InstrumentHistoryRow[];
  updateAction: (fd: FormData) => Promise<FormResult>;
  deleteAction: (fd: FormData) => Promise<{ undoId: number | null }>;
  // "instrument" (mental health) or "substance" — keeps each surface's existing
  // per-row test ids stable.
  testidPrefix: string;
  emptyMessage: string;
}) {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();
  const undoable = useUndoableDelete();

  if (rows.length === 0) return <EmptyState message={emptyMessage} />;

  async function handleSave(row: InstrumentHistoryRow, formData: FormData) {
    setError(null);
    formData.set("id", String(row.id));
    let result: FormResult;
    try {
      result = await updateAction(formData);
    } catch {
      setError("Couldn't save that correction. Try again.");
      return;
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setEditingId(null);
  }

  async function handleDelete(row: InstrumentHistoryRow) {
    const ok = await confirm({
      title: "Remove score",
      message: `Remove the ${row.instrument} score of ${row.total} from ${row.date}?`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    const fd = new FormData();
    fd.set("id", String(row.id));
    await undoable(deleteAction, fd, { deletedMessage: "Score removed." });
  }

  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li
          key={r.id}
          data-testid={`${testidPrefix}-reading-${r.id}`}
          className="rounded-lg border border-black/5 px-3 py-2 text-sm dark:border-white/5"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span>
              <Link href={r.href} className="text-link">
                {r.instrument}
              </Link>{" "}
              <span className="text-slate-500 dark:text-slate-400">
                {r.date}
              </span>
              {r.documentId != null ? (
                <>
                  {" · "}
                  <SourceDocumentLink documentId={r.documentId}>
                    Source document
                  </SourceDocumentLink>
                </>
              ) : null}
            </span>
            <span className="flex items-center gap-3">
              <span>
                <span className="font-semibold">{r.total}</span> ·{" "}
                <span data-testid={`${testidPrefix}-reading-band-${r.id}`}>
                  {r.bandLabel}
                </span>
              </span>
              {/* CANCEL STAYS A STANDING BUTTON WHILE THE FORM IS OPEN, and that
                  is not an exception to the fold — it is what the fold means. A
                  menu item toggles a disclosure ON; the way back out of an open
                  editor belongs beside the editor, where the house grammar puts
                  every other form's Cancel. Burying "Cancel" two taps deep inside
                  a ⋯ would be worse than the standing pair this replaces. */}
              {editingId === r.id ? (
                <button
                  type="button"
                  className="btn-ghost px-2 py-1 text-xs"
                  data-testid={`${testidPrefix}-reading-edit-${r.id}`}
                  onClick={() => {
                    setError(null);
                    setEditingId(null);
                  }}
                >
                  Cancel
                </button>
              ) : (
                <OverflowMenu
                  kind="Reading"
                  itemName={r.date}
                  open={menuOpenId === r.id}
                  onOpenChange={(open) => setMenuOpenId(open ? r.id : null)}
                >
                  {({ close }) => (
                    <>
                      <button
                        type="button"
                        role="menuitem"
                        data-testid={`${testidPrefix}-reading-edit-${r.id}`}
                        className={MENU_ITEM}
                        onClick={() => {
                          setError(null);
                          setEditingId(r.id);
                          close();
                        }}
                      >
                        Correct
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        data-testid={`${testidPrefix}-reading-delete-${r.id}`}
                        className={MENU_ITEM_DANGER}
                        onClick={() => {
                          // Close FIRST, then confirm: the menu is stale the
                          // moment a decision opens over it (#2599), and
                          // OverflowMenu closes itself on `useConfirmOpen`
                          // anyway — doing it here keeps the CANCEL branch from
                          // leaving the menu behind too.
                          close();
                          void handleDelete(r);
                        }}
                      >
                        Remove
                      </button>
                    </>
                  )}
                </OverflowMenu>
              )}
            </span>
          </div>

          {editingId === r.id && (
            <form
              action={(fd) => handleSave(r, fd)}
              className="mt-3 flex flex-wrap items-end gap-3"
              data-testid={`${testidPrefix}-reading-edit-form-${r.id}`}
            >
              <div>
                <label className="label" htmlFor={`score-date-${r.id}`}>
                  Date
                </label>
                <DateField
                  id={`score-date-${r.id}`}
                  data-testid={`${testidPrefix}-reading-date-${r.id}`}
                  name="date"
                  defaultValue={r.date}
                  required
                />
              </div>
              <div>
                <label className="label" htmlFor={`score-total-${r.id}`}>
                  Total (0–{r.maxTotal})
                </label>
                <input
                  id={`score-total-${r.id}`}
                  data-testid={`${testidPrefix}-reading-total-${r.id}`}
                  name="total"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={r.maxTotal}
                  step={1}
                  className="input w-28"
                  defaultValue={r.total}
                  required
                />
              </div>
              <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
            </form>
          )}

          {editingId === r.id && error && (
            <p
              role="alert"
              className="mt-2 text-sm text-rose-600 dark:text-rose-400"
              data-testid={`${testidPrefix}-reading-error-${r.id}`}
            >
              {error}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
