"use client";

import { useRef, useState } from "react";
import ModalShell from "@/components/ModalShell";
import OverflowMenu, {
  MENU_ITEM,
  MENU_ITEM_DANGER,
} from "@/components/OverflowMenu";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { useUndoableDelete } from "@/components/useUndoableDelete";
import type { BodyMetricMeasure } from "@/lib/body-metric-measures";
import { deleteBodyMetric } from "./body-actions";
import { updateMetricReading } from "./reading-actions";

// Row actions for the Trends → Body history table (issue #2556).
//
// The table used to offer delete and nothing else, so a mistyped weight could only be
// removed and retyped — losing the row, its notes, and the day's body fat and resting
// HR along with it. The gap was never a missing write path: `updateReadingAt` has owned
// per-measure correction of this exact table since #2032, `updateMetricReading` is its
// gated Server Action, and the metric detail page has been driving both. What was
// missing was the AFFORDANCE, on the surface that lists the rows.
//
// So this is the standard ⋯ menu (the #1491 row-action convention) over the existing
// contract — no second core, no second unit boundary. Each item names ONE measure of
// the row, because `body_metrics` is wide: a row holds up to three readings, and
// "Edit" with no measure named would be a guess. Delete stays a whole-row delete
// through the unchanged `deleteBodyMetric`, and its label says "entry" for that
// reason.
//
// RENDERED FROM STATE: `measures` already excludes the row's empty cells
// (bodyMetricMeasures), so the menu can only ever offer to correct a reading that is
// actually there.
export default function BodyMetricRowMenu({
  id,
  label,
  measures,
}: {
  id: number;
  /** The row's own date, already formatted — names the row in every prompt. */
  label: string;
  measures: BodyMetricMeasure[];
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const undoable = useUndoableDelete();
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState<BodyMetricMeasure | null>(null);
  const [busy, setBusy] = useState(false);

  async function onDelete() {
    const ok = await confirm({
      title: "Delete entry",
      message: `Delete the body-metrics entry from ${label}? You can undo this.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    const fd = new FormData();
    fd.set("id", String(id));
    setBusy(true);
    try {
      await undoable(deleteBodyMetric, fd, {
        deletedMessage: "Body-metrics entry deleted.",
      });
    } finally {
      setBusy(false);
    }
  }

  // The row's own date is in hand, so the accessible name says WHICH entry (#2530):
  // a table of N controls all named "Row actions" tells a screen-reader user nothing
  // about which record they are about to change.
  const name = `Actions for entry from ${label}`;

  return (
    <div className="flex items-center justify-end">
      <OverflowMenu
        label={name}
        open={menuOpen}
        onOpenChange={(open) => setMenuOpen(busy ? false : open)}
      >
        {({ close }) => (
          <>
            {measures.map((measure) => (
              <button
                key={measure.column}
                type="button"
                role="menuitem"
                className={MENU_ITEM}
                data-testid={`body-history-edit-${measure.column}`}
                onClick={() => {
                  setEditing(measure);
                  close();
                }}
              >
                Edit {measure.label.toLowerCase()}
              </button>
            ))}
            {/* Plain button, not a form action: confirm() opens a modal the user must
                answer, which deadlocks inside a form-action transition. Close the menu
                FIRST so a cancelled confirm cannot leave the click-away backdrop
                shielding the table. */}
            <button
              type="button"
              role="menuitem"
              className={MENU_ITEM_DANGER}
              data-testid="body-history-delete"
              onClick={() => {
                close();
                void onDelete();
              }}
            >
              Delete entry
            </button>
          </>
        )}
      </OverflowMenu>
      {editing && (
        <EditMeasureDialog
          key={editing.target}
          measure={editing}
          dateLabel={label}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null);
            toast(message);
          }}
        />
      )}
    </div>
  );
}

// One measure's correction dialog. The value posts in the login's DISPLAY unit and
// `updateMetricReading` converts at the boundary (weight through `toKg`), so nothing
// here knows what a kilogram is.
function EditMeasureDialog({
  measure,
  dateLabel,
  onClose,
  onSaved,
}: {
  measure: BodyMetricMeasure;
  dateLabel: string;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(String(measure.value));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("kind", measure.slug);
      fd.set("target", measure.target);
      fd.set("value", value);
      const result = await updateMetricReading(fd);
      if (!result.ok) {
        setError(result.error ?? "Couldn’t save that reading.");
        return;
      }
      onSaved(`${measure.label} updated.`);
    } catch {
      setError("Couldn’t save that reading. Try again.");
    } finally {
      setPending(false);
    }
  }

  const step = measure.decimals > 0 ? 10 ** -measure.decimals : 1;

  return (
    <ModalShell
      title={`Edit ${measure.label.toLowerCase()} — ${dateLabel}`}
      onClose={onClose}
      initialFocusRef={inputRef}
      className="w-full max-w-sm rounded-xl bg-white p-4 shadow-xl outline-hidden sm:p-5 dark:bg-ink-900"
    >
      <div className="mt-4 space-y-4" data-testid="body-metric-edit-dialog">
        <label className="label block">
          {measure.label}
          {measure.unit ? ` (${measure.unit.trim()})` : ""}
          <input
            ref={inputRef}
            type="number"
            step={step}
            inputMode="decimal"
            className="input mt-1"
            value={value}
            disabled={pending}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void save();
            }}
            data-testid="body-metric-edit-value"
          />
        </label>
        {error && (
          <p
            className="text-sm text-rose-600 dark:text-rose-400"
            data-testid="body-metric-edit-error"
          >
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn"
            disabled={pending || value.trim() === ""}
            onClick={() => void save()}
            data-testid="body-metric-edit-save"
          >
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
