"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
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
  /** Already formatted in the page's display unit — this component only renders. */
  display: string;
  /** The raw display-unit number the edit field opens with. */
  editValue: number;
  source: string | null;
  flag: string | null;
  edited: boolean;
  notes: string | null;
}

export default function MetricReadingsTable({
  kind,
  rows,
  unit,
  readOnlyReason,
  truncated = false,
}: {
  /** The metric slug — posted with every write so the action targets one store. */
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
      <div className="card" data-testid="metric-readings">
        <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
          Readings
        </h2>
        <EmptyState message={readOnlyReason} />
      </div>
    );
  }

  return (
    <div className="card" data-testid="metric-readings">
      <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
        Readings
      </h2>
      {rows.length === 0 ? (
        <EmptyState message="No readings recorded yet." />
      ) : (
        <>
          <div className="overflow-x-auto">
            <ResponsiveTable
              className="w-full"
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
                  <ReadingRow key={row.id} kind={kind} row={row} unit={unit} />
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
  const router = useRouter();

  async function save() {
    const fd = new FormData();
    fd.set("kind", kind);
    fd.set("id", String(row.id));
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
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr className="border-b border-black/5 dark:border-white/10">
      <Td slot="title" className="whitespace-nowrap">
        {row.date}
      </Td>
      <Td slot="value" label="Value">
        {editing ? (
          <span className="flex items-center gap-1">
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
            <button
              type="button"
              className="btn-primary px-2 py-1 text-xs"
              disabled={busy}
              onClick={() => void save()}
            >
              Save
            </button>
            <button
              type="button"
              className="btn px-2 py-1 text-xs"
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
      <Td slot="meta" label="Source" empty={!row.source}>
        {row.source ?? "—"}
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
                    const ok = await confirm({
                      title: "Delete reading",
                      message: `Delete the ${row.date} reading (${row.display}${unit})?`,
                      confirmLabel: "Delete",
                      danger: true,
                    });
                    if (!ok) return;
                    close();
                    const fd = new FormData();
                    fd.set("kind", kind);
                    fd.set("id", String(row.id));
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
      </Td>
    </tr>
  );
}
