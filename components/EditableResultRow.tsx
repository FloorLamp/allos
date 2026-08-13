"use client";

import { useState } from "react";
import Link from "next/link";
import type { ClinicalObservation } from "@/lib/types";
import { observationNameLink } from "@/lib/import-browser";
import type { ConfidenceFlag } from "@/lib/extraction-confidence";
import { Tag, MedicalValue } from "./ui";
import { Td } from "./ResponsiveTable";
import { ConfidenceRowNote } from "./ConfidenceBadge";
import { TRIAGE_FOCUS_ROW } from "./TriageFocus";
import NotesText from "./NotesText";
import ResultForm from "./ResultForm";
import OverflowMenu, { MENU_ITEM, MENU_ITEM_DANGER } from "./OverflowMenu";
import { useConfirm } from "./ConfirmDialog";
import { useUndoableDelete } from "./useUndoableDelete";
import {
  updateResult,
  deleteResult,
} from "@/app/(app)/results/reading-actions";

export default function EditableResultRow({
  observation,
  grouped,
  rowId,
  focused = false,
  flag,
}: {
  observation: ClinicalObservation;
  // When the table is name-sorted it groups contiguous same-name rows (like the
  // biomarkers table): the name shows once on the group's start row, and the
  // group-closing border falls only on its end row. Omit for ungrouped tables,
  // where every row shows its name and draws a border.
  grouped?: { isGroupStart: boolean; isGroupEnd: boolean };
  // The row's anchor id on its tab, so a "Check these first" link can land on it
  // (#2339). Present on the import-detail browser; omitted elsewhere.
  rowId?: string;
  // This row is the one a `?focus=` label resolved to — tint it.
  focused?: boolean;
  // What the extractor hedged about THIS row, when a flag resolved to it alone.
  flag?: ConfidenceFlag;
}) {
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const confirm = useConfirm();
  const undoable = useUndoableDelete();
  const r = observation;

  // Category-correct name link (#271): series categories link to the biomarker
  // series view, prescriptions to /medications, scans/notes get NO link rather than
  // a wrong one. Pure decision in lib/import-browser.
  const nameLink = observationNameLink(r.category, r.canonical_name);

  if (!editing) {
    const showName = grouped ? grouped.isGroupStart : true;
    const rowBorder =
      !grouped || grouped.isGroupEnd
        ? "border-b border-black/5 dark:border-white/10"
        : "";
    return (
      <tr
        id={rowId}
        data-focused={focused ? "true" : undefined}
        className={`${rowBorder} ${focused ? TRIAGE_FOCUS_ROW : ""}`}
      >
        {/* Card placement below `sm` (#2614 adopting #1426): the analyte's name is
            the card's identity, the reading its headline, and the reference band —
            the column the phone used to cut to "3.5-5.|" — a labelled meta line.
            Panel and Category claim no card line, the same call #2316 made on the
            biomarkers table: they are facets worth a narrow desktop column, not a
            phone line each. */}
        <Td slot="title" className="font-medium">
          {!showName ? null : nameLink ? (
            <Link
              href={nameLink.href}
              className="text-brand-700 hover:underline dark:text-brand-400"
              title={nameLink.title}
            >
              {r.name}
            </Link>
          ) : (
            r.name
          )}
          {/* What the extractor hedged about this row, and why (#2339) — the
              reason used to live only in the import page's triage card. */}
          {flag && <ConfidenceRowNote flag={flag} />}
          {/* Performing provider, as a muted sub-line (links to the registry). */}
          {r.provider_name ? (
            <div className="text-xs font-normal text-slate-500 dark:text-slate-400">
              {r.provider_id ? (
                <Link
                  href={`/providers/${r.provider_id}`}
                  className="hover:text-brand-700 hover:underline dark:hover:text-brand-300"
                >
                  {r.provider_name}
                </Link>
              ) : (
                r.provider_name
              )}
            </div>
          ) : null}
        </Td>
        <td className="td text-slate-500 dark:text-slate-400">
          {r.panel ?? "—"}
        </td>
        <Td slot="value">
          <MedicalValue value={r.value} unit={r.unit} flag={r.flag} />
        </Td>
        <Td
          slot="meta"
          label="Reference"
          empty={!r.reference_range}
          className="text-slate-500 dark:text-slate-400"
        >
          {r.reference_range ?? "—"}
        </Td>
        <Td
          slot="meta"
          label="Notes"
          empty={!r.notes?.trim()}
          className="text-slate-500 dark:text-slate-400"
        >
          <NotesText notes={r.notes} />
        </Td>
        <td className="td">
          <Tag value={r.category} />
        </td>
        <Td slot="meta" label="Date" className="whitespace-nowrap">
          {r.date}
        </Td>
        <Td slot="actions">
          <div className="flex items-center justify-end">
            <OverflowMenu
              label="Result actions"
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
                  {/* Plain button (not a form action): confirm() opens a modal
                      the user must answer, which deadlocks inside a form-action
                      transition. onClick is a normal handler, so it shows. */}
                  <button
                    type="button"
                    role="menuitem"
                    className={MENU_ITEM_DANGER}
                    onClick={async () => {
                      const ok = await confirm({
                        title: "Delete result",
                        message: `Delete “${r.name}”? You can undo this.`,
                        confirmLabel: "Delete",
                        danger: true,
                      });
                      if (!ok) return;
                      close();
                      const fd = new FormData();
                      fd.set("id", String(r.id));
                      await undoable(deleteResult, fd, {
                        deletedMessage: "Result deleted.",
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

  // Edit mode: the shared ResultForm (same fields + write path the add slot uses)
  // swaps in place of the row; updateResult is profile-scoped and reconciles flags.
  return (
    <tr
      id={rowId}
      className="border-b border-black/5 bg-slate-50/60 dark:border-white/10 dark:bg-ink-900/60"
    >
      {/* `full` — the inline editor replaces the card body below `sm`, exactly as
          it replaces the row above it. */}
      <Td slot="full" colSpan={8} className="py-3">
        <ResultForm
          mode="edit"
          observation={r}
          action={updateResult}
          onDone={() => setEditing(false)}
        />
      </Td>
    </tr>
  );
}
