"use client";

import { useState } from "react";
import Link from "next/link";
import type { MedicalRecord } from "@/lib/types";
import { Tag, MedicalValue } from "./ui";
import SortableHeader from "./SortableHeader";
import RecordForm from "./RecordForm";
import OverflowMenu, { MENU_ITEM, MENU_ITEM_DANGER } from "./OverflowMenu";
import { useConfirm } from "./ConfirmDialog";
import { useUndoableDelete } from "./useUndoableDelete";
import { updateRecord, deleteRecord } from "@/app/(app)/medical/actions";
import { groupContiguous } from "@/lib/table-sort";
import {
  isBiomarkerStale,
  daysBetween,
  humanizeAge,
} from "@/lib/reference-range";
import { BIOMARKER_CATEGORIES } from "@/lib/medical-categories";

// The active-filter context threaded through to build the panel/category filter
// links (each preserves the current sort/range/etc., matching the server-built
// hrefs the table used before it became interactive).
interface FilterCtx {
  category?: string;
  panel?: string;
  range?: string;
  q?: string;
  sort: "name" | "panel" | "date";
  dir: "asc" | "desc";
  current: boolean;
}

// Build a /biomarkers URL from the active filters, dropping empty ones.
function qs(params: Record<string, string | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
  const s = sp.toString();
  return s ? `/biomarkers?${s}` : "/biomarkers";
}

// The grouping identity for a reading: its canonical name when present, else the
// raw name. Matches the server-side key used to sort/dedupe, so rows of the same
// biomarker land adjacent and can be grouped in the table.
function nameKey(r: { name: string; canonical_name: string | null }): string {
  return r.canonical_name?.trim() || r.name;
}

// A small amber badge flagging a biomarker whose latest reading has gone stale
// (over a year old — a yearly-retest heuristic).
function staleBadge() {
  return (
    <span
      className="ml-2 rounded-full bg-amber-50 px-1.5 py-0.5 align-middle text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:bg-amber-400/10 dark:text-amber-400"
      title="Latest reading over a year old — consider retesting"
    >
      Stale
    </span>
  );
}

// A small slate badge marking a read-time DERIVED index (issue #40) — computed
// from other readings, not measured. The formula (with the component values) is the
// hover title so the derivation is inspectable.
function derivedBadge(formula?: string) {
  return (
    <span
      data-testid="derived-badge"
      className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 align-middle text-[10px] font-medium uppercase tracking-wide text-slate-600 dark:bg-slate-700 dark:text-slate-300"
      title={formula ? `Derived: ${formula}` : "Computed from other readings"}
    >
      Derived
    </span>
  );
}

// Show the canonical name (the grouping identity) when present, linking to the
// biomarker detail page; fall back to the raw provided name otherwise. Flags the
// group with a Stale badge when its latest reading is overdue, and a Derived badge
// when the reading is a computed index.
function nameCell(r: {
  name: string;
  canonical_name: string | null;
  stale?: boolean;
  derived?: boolean;
  derived_formula?: string;
}) {
  const stale = r.stale ? staleBadge() : null;
  const derived = r.derived ? derivedBadge(r.derived_formula) : null;
  if (!r.canonical_name)
    return (
      <span>
        <span className="font-medium">{r.name}</span>
        {stale}
        {derived}
      </span>
    );
  return (
    <span>
      <Link
        href={`/biomarkers/view?name=${encodeURIComponent(r.canonical_name)}`}
        className="font-medium text-brand-700 hover:underline dark:text-brand-400"
        title={`View ${r.canonical_name} over time`}
      >
        {r.canonical_name}
      </Link>
      {stale}
      {derived}
    </span>
  );
}

// Date cell: the reading's date, linking to its source document when present. The
// latest reading of a biomarker also shows its age below ("8 months ago"), flagged
// amber once it's over a year old (a yearly-retest heuristic). Older readings in a
// group omit the age line — pass `showAge` false for those.
function dateCell(
  r: { date: string; category: string | null; document_id: number | null },
  now: string,
  showAge: boolean
) {
  const dateEl = (
    <span className="whitespace-nowrap">
      {r.document_id ? (
        <Link
          href={`/import/${r.document_id}`}
          className="text-brand-700 hover:underline dark:text-brand-400"
        >
          {r.date}
        </Link>
      ) : (
        r.date
      )}
    </span>
  );
  if (!showAge) return dateEl;
  const ageDays = daysBetween(r.date, now);
  const stale = isBiomarkerStale(r.date, r.category, now);
  const relative = ageDays <= 0 ? "today" : `${humanizeAge(ageDays)} ago`;
  return (
    <div className="flex flex-col">
      {dateEl}
      <span
        className={`text-xs ${
          stale
            ? "text-amber-600 dark:text-amber-400"
            : "text-slate-400 dark:text-slate-500"
        }`}
        title={stale ? "Over a year old — consider retesting" : undefined}
      >
        {stale && "⚠️ "}
        {relative}
      </span>
    </div>
  );
}

// One biomarker reading row. Display mode keeps the rich Biomarkers presentation
// (canonical-name grouping heading + Stale badge, panel/category filter links,
// relative-age date, responsive column hiding) and adds a kebab menu; edit swaps
// the row in place for the shared RecordForm. Edit + delete run through the same
// profile-scoped updateRecord/deleteRecord the document view uses — delete matches
// the document view (any row, manual or extracted, behind a danger confirm).
function BiomarkerRow({
  r,
  isStart,
  isEnd,
  stale,
  now,
  filters,
}: {
  r: MedicalRecord;
  isStart: boolean;
  isEnd: boolean;
  stale: boolean;
  now: string;
  filters: FilterCtx;
}) {
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const confirm = useConfirm();
  const undoable = useUndoableDelete();

  if (editing) {
    return (
      <tr className="border-b border-black/5 bg-slate-50/60 dark:border-white/10 dark:bg-ink-900/60">
        <td colSpan={8} className="px-3 py-3">
          <RecordForm
            mode="edit"
            record={r}
            action={updateRecord}
            onDone={() => setEditing(false)}
            categories={BIOMARKER_CATEGORIES}
          />
        </td>
      </tr>
    );
  }

  const { category, panel, range, q, sort, dir, current } = filters;
  // A derived index is a computed, read-only virtual row: no source document, no
  // panel/category filter links, and no edit/delete (there's no stored row to
  // mutate). Its formula shows in the Notes column so the derivation is visible.
  if (r.derived) {
    return (
      <tr
        className={isEnd ? "border-b border-black/5 dark:border-white/10" : ""}
      >
        <td className="td">{isStart ? nameCell({ ...r, stale }) : null}</td>
        <td className="td hidden md:table-cell">
          <span className="text-slate-300 dark:text-slate-600">—</span>
        </td>
        <td className="td">
          <MedicalValue value={r.value} unit={r.unit} flag={r.flag} />
        </td>
        <td className="td hidden text-slate-500 sm:table-cell dark:text-slate-400">
          —
        </td>
        <td className="td hidden text-slate-500 md:table-cell dark:text-slate-400">
          {r.derived_formula ?? ""}
        </td>
        <td className="td hidden md:table-cell">
          <Tag value={r.category} />
        </td>
        <td className="td">{dateCell(r, now, !!r.is_latest)}</td>
        <td className="td text-right text-xs text-slate-400 dark:text-slate-500">
          Computed
        </td>
      </tr>
    );
  }
  return (
    <tr className={isEnd ? "border-b border-black/5 dark:border-white/10" : ""}>
      <td className="td">{isStart ? nameCell({ ...r, stale }) : null}</td>
      <td className="td hidden md:table-cell">
        {r.panel ? (
          <Link
            href={qs({
              category,
              panel: r.panel,
              range,
              sort,
              dir,
              current: current ? "1" : undefined,
            })}
            className="text-xs text-slate-500 hover:text-brand-700 hover:underline dark:text-slate-400 dark:hover:text-brand-400"
          >
            {r.panel}
          </Link>
        ) : (
          <span className="text-slate-300 dark:text-slate-600">—</span>
        )}
      </td>
      <td className="td">
        <MedicalValue value={r.value} unit={r.unit} flag={r.flag} />
      </td>
      <td className="td hidden text-slate-500 sm:table-cell dark:text-slate-400">
        {r.reference_range ?? "—"}
      </td>
      <td className="td hidden text-slate-500 md:table-cell dark:text-slate-400">
        {r.notes ?? ""}
      </td>
      <td className="td hidden md:table-cell">
        <Link
          href={qs({
            category: r.category,
            panel,
            range,
            q,
            sort,
            dir,
            current: current ? "1" : undefined,
          })}
          title={`Filter by ${r.category}`}
          className="hover:opacity-80"
        >
          <Tag value={r.category} />
        </Link>
      </td>
      <td className="td">{dateCell(r, now, !!r.is_latest)}</td>
      <td className="td">
        <div className="flex items-center justify-end">
          <OverflowMenu
            label="Record actions"
            open={menuOpen}
            onOpenChange={setMenuOpen}
          >
            {({ close }) => (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setEditing(true);
                    close();
                  }}
                  className={MENU_ITEM}
                >
                  Edit
                </button>
                {/* Plain button (not a form action): confirm() opens a modal the
                    user must answer, which would deadlock inside a form-action
                    transition. */}
                <button
                  type="button"
                  role="menuitem"
                  className={MENU_ITEM_DANGER}
                  onClick={async () => {
                    const ok = await confirm({
                      title: "Delete record",
                      message: `Delete “${r.name}”? You can undo this.`,
                      confirmLabel: "Delete",
                      danger: true,
                    });
                    if (!ok) return;
                    close();
                    const fd = new FormData();
                    fd.set("id", String(r.id));
                    await undoable(deleteRecord, fd, {
                      deletedMessage: "Record deleted.",
                    });
                  }}
                >
                  Delete
                </button>
              </>
            )}
          </OverflowMenu>
        </div>
      </td>
    </tr>
  );
}

// The Biomarkers results table. Client-side so each row can swap in place for an
// inline editor and offer delete — but the display, grouping, sorting, staleness,
// and filter links are unchanged from the prior server-rendered table.
export default function BiomarkersTable({
  records,
  now,
  filters,
}: {
  records: MedicalRecord[];
  now: string;
  filters: FilterCtx;
}) {
  return (
    <div className="card mb-6 overflow-hidden p-0">
      <div className="max-h-[70vh] overflow-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-black/5 dark:border-white/10">
              <SortableHeader column="name" label="Name" defaultSort="name" />
              {/* Panel, Notes and Category hide below `md` so the table fits a
              phone without side-scrolling; panel/category stay reachable through
              the filters above and the biomarker detail page. */}
              <SortableHeader
                column="panel"
                label="Panel"
                defaultSort="name"
                className="hidden md:table-cell"
              />
              <th className="th sticky top-0 z-10 bg-white dark:bg-ink-900">
                Value
              </th>
              {/* Reference hides below `sm`: the value cell already flags
              out-of-range readings, and full ranges live on the detail page. */}
              <th className="th sticky top-0 z-10 hidden bg-white sm:table-cell dark:bg-ink-900">
                Reference
              </th>
              <th className="th sticky top-0 z-10 hidden bg-white md:table-cell dark:bg-ink-900">
                Notes
              </th>
              <th className="th sticky top-0 z-10 hidden bg-white md:table-cell dark:bg-ink-900">
                Category
              </th>
              <SortableHeader
                column="date"
                label="Date"
                defaultSort="name"
                defaultDir="desc"
              />
              <th className="th sticky top-0 z-10 bg-white text-right dark:bg-ink-900">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {/* Group adjacent readings of the same biomarker via the shared
            contiguous-group helper: the name shows once per group (on the start
            row) and a bottom border falls only at group ends. */}
            {groupContiguous(records, nameKey).map(
              ({ row: r, isGroupStart, isGroupEnd }) => {
                // Flag the group as stale off its latest reading — the row carrying
                // is_latest holds the newest date, so its staleness is the
                // biomarker's.
                const stale =
                  !!r.is_latest && isBiomarkerStale(r.date, r.category, now);
                return (
                  <BiomarkerRow
                    key={r.id}
                    r={r}
                    isStart={isGroupStart}
                    isEnd={isGroupEnd}
                    stale={stale}
                    now={now}
                    filters={filters}
                  />
                );
              }
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
