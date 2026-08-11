"use client";

import { useState } from "react";
import { ResponsiveTable, Td } from "./ResponsiveTable";
import OverflowMenu, { MENU_ITEM, MENU_ITEM_DANGER } from "./OverflowMenu";
import { useConfirm } from "./ConfirmDialog";
import { useUndoableDelete } from "./useUndoableDelete";
import { useToast } from "./Toast";
import { EmptyState, Tag } from "./ui";
import NotesText from "./NotesText";
import {
  deleteMetricReading,
  updateMetricReading,
} from "@/app/(app)/trends/reading-actions";

// The readings TABLE under a metric detail page's chart (issue #1488, absorbing
// #1397) — the chart's accessible, inspectable companion: date, value, source, flag.
//
// WHY IT EXISTS. A chart answers "what shape", never "which reading, and is it
// right?". Trends' quick-adds were upsert-only, so a mis-typed manual HRV, sleep or
// mood value was a dead end (#1397): the value stayed in the trend forever, quietly
// bending it. The table is where that gets fixed, one row from the chart it distorts —
// an edit or delete revalidates the chart above, and the pairing is the point.
//
// ROW ACTIONS LIVE IN THE ⋯ MENU. This is the standardized pattern going forward:
// row-level record actions go in the standard `OverflowMenu` + `MENU_ITEM`, never an
// inline button row (precedent: the Journal's ActivityCardMenu; the counter-example
// being fixed is #1446's duplicated inline ⋯). Below `sm` the table renders through
// the #1426 `ResponsiveTable` card pattern — ONE table in the DOM, re-laid as cards
// by CSS, so there is no `hidden md:*` twin to drift.
//
// EDIT IS IN PLACE. Value is the only editable field here — a detail page is about
// one metric on one date, and re-dating a reading is a record-level move that belongs
// on the record's own editor. The row swaps to a small number input; the surrounding
// row (date, source, flag) stays visible so the reader can see what they're changing.

export interface MetricReadingRow {
  id: number;
  date: string;
  /**
   * The physical row this line writes to, as `store:id:measure` (#2032). Posted with
   * every edit and delete so the action targets the ROW rather than re-deriving a store
   * from the page's slug — which is what makes the folded observations below editable.
   */
  target: string;
  /** Already formatted in the page's display unit — this component only renders. */
  display: string;
  /** The raw display-unit number the edit field opens with. */
  editValue: number;
  source: string | null;
  flag: string | null;
  edited: boolean;
  notes: string | null;
  /**
   * A folded same-identity OBSERVATION (#1996): the same measurement, recorded as
   * a clinical record rather than in this metric's own store. It is listed here
   * because it IS a reading of this quantity — leaving it out is the incompleteness
   * #1996 reports — and since #2032 it is EDITABLE here like any other reading: the
   * row carries its own target, so a correction lands on the clinical record it came
   * from. The marker stays, because where a reading was measured is worth saying.
   */
  observed?: boolean;
}

export default function MetricReadingsTable({
  kind,
  rows,
  unit,
  readOnlyReason,
  truncated = false,
}: {
  /** The metric slug — the PAGE, posted so the action knows what to revalidate and
   * which display unit to convert back from. The ROW is named by `row.target`. */
  kind: string;
  rows: MetricReadingRow[];
  unit: string;
  /**
   * Set for a DERIVED metric (BMI, daily-average HR, sun minutes): there is no row to
   * edit, and saying so is better than an empty table implying the data is missing.
   */
  readOnlyReason?: string | null;
  /** Whether `rows` was capped, so the footnote can say so honestly. */
  truncated?: boolean;
}) {
  if (readOnlyReason) {
    return (
      <div className="card overflow-hidden p-0!" data-testid="metric-readings">
        <ReadingsHeader />
        <div
          className="px-2 pb-2 sm:px-5 sm:pb-5"
          data-testid="metric-readings-body"
        >
          <EmptyState message={readOnlyReason} />
        </div>
      </div>
    );
  }

  return (
    <div className="card overflow-hidden p-0!" data-testid="metric-readings">
      <ReadingsHeader />
      <div
        className="px-2 pb-2 sm:px-5 sm:pb-5"
        data-testid="metric-readings-body"
      >
        {rows.length === 0 ? (
          <EmptyState message="No readings recorded yet." />
        ) : (
          <>
            <div className="overflow-x-auto">
              <ResponsiveTable
                className="metric-readings-list w-full"
                data-testid="metric-readings-table"
              >
                <thead>
                  <tr className="border-b border-black/5 dark:border-white/10">
                    <th className="th">Date</th>
                    <th className="th">Value</th>
                    <th className="th">Source</th>
                    <th className="th">Notes</th>
                    <th className="th" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    // Ids are per-STORE, so a folded observation can share one
                    // with this metric's own row — the target names both.
                    <ReadingRow
                      key={row.target}
                      kind={kind}
                      row={row}
                      unit={unit}
                    />
                  ))}
                </tbody>
              </ResponsiveTable>
            </div>
            {truncated && (
              <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                Showing the most recent readings. The full set (and bulk delete)
                lives on Data → Manage.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ReadingsHeader() {
  return (
    <div
      className="px-4 pt-2.5 pb-1 sm:px-5 sm:pt-4 sm:pb-3"
      data-testid="metric-readings-header"
    >
      <h2 className="font-semibold text-slate-800 dark:text-slate-100">
        Readings
      </h2>
    </div>
  );
}

function ReadingRow({
  kind,
  row,
  unit,
}: {
  kind: string;
  row: MetricReadingRow;
  unit: string;
}) {
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [value, setValue] = useState(String(row.editValue));
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  const undoable = useUndoableDelete();
  const toast = useToast();

  async function save() {
    const fd = new FormData();
    fd.set("kind", kind);
    fd.set("target", row.target);
    fd.set("value", value);
    setBusy(true);
    try {
      const res = await updateMetricReading(fd);
      if (!res.ok) {
        toast(res.error ?? "Couldn't save that reading.", { tone: "error" });
        return;
      }
      setEditing(false);
      toast("Reading updated.");
      // The chart above this table is server-rendered from the same rows, so it has
      // to redraw with the correction (revalidatePath marked it stale).
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr className="border-b border-black/5 dark:border-white/10">
      <Td slot="title" className="whitespace-nowrap">
        {row.date}
      </Td>
      <Td slot="value">
        {editing ? (
          <input
            className="input w-24 py-1 text-sm"
            type="number"
            step="any"
            inputMode="decimal"
            aria-label="Reading value"
            value={value}
            autoFocus
            disabled={busy}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
              if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          <span className="tabular-nums">
            {row.display}
            {unit}
            {row.flag && (
              <span className="ml-2">
                <Tag value={row.flag} />
              </span>
            )}
          </span>
        )}
      </Td>
      <Td
        slot="meta"
        label="Source"
        empty={!row.source && !row.observed}
        className="metric-reading-source"
      >
        {row.source ?? "—"}
        {/* Where this reading was actually taken, said out loud: a clinic-measured
            value is not a wearable one. It is corrected in place all the same — the
            row carries its own target (#2032). */}
        {row.observed && (
          <span
            className="ml-1 text-xs text-slate-500 dark:text-slate-400"
            data-testid="metric-reading-observed"
          >
            · clinical record
          </span>
        )}
        {/* The #133 lock, made visible: this row was hand-corrected, so the next
            re-push of its source's rolling window will leave it alone. */}
        {row.edited && (
          <span className="ml-1 text-xs text-slate-400">· edited</span>
        )}
      </Td>
      <Td slot="meta" label="Notes" empty={!row.notes}>
        {row.notes ? <NotesText notes={row.notes} /> : "—"}
      </Td>
      <Td slot="actions">
        {editing ? (
          <span className="flex items-center justify-end gap-1">
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => void save()}
            >
              Save
            </button>
            <button
              type="button"
              className="btn-ghost btn-sm"
              disabled={busy}
              onClick={() => {
                setValue(String(row.editValue));
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </span>
        ) : (
          <div className="flex items-center justify-end">
            <OverflowMenu
              label="Reading actions"
              open={menuOpen}
              onOpenChange={setMenuOpen}
            >
              {({ close }) => (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    className={MENU_ITEM}
                    onClick={() => {
                      setEditing(true);
                      close();
                    }}
                  >
                    Edit
                  </button>
                  {/* Plain button (not a form action): confirm() opens a modal the
                      user must answer, which deadlocks inside a form-action
                      transition. */}
                  <button
                    type="button"
                    role="menuitem"
                    className={MENU_ITEM_DANGER}
                    onClick={async () => {
                      // The menu and confirm are two modal layers. Close the menu
                      // before presenting the decision so Cancel cannot reveal a
                      // stale click-away backdrop over the readings table.
                      close();
                      const ok = await confirm({
                        title: "Delete reading",
                        message: `Delete the ${row.date} reading (${row.display}${unit})?`,
                        confirmLabel: "Delete",
                        danger: true,
                      });
                      if (!ok) return;
                      const fd = new FormData();
                      fd.set("kind", kind);
                      fd.set("target", row.target);
                      await undoable(deleteMetricReading, fd, {
                        deletedMessage: "Reading deleted.",
                      });
                    }}
                  >
                    Delete
                  </button>
                </>
              )}
            </OverflowMenu>
          </div>
        )}
      </Td>
    </tr>
  );
}
