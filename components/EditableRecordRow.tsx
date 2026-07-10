"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { MedicalRecord } from "@/lib/types";
import { Tag, MedicalValue } from "./ui";
import RecordForm from "./RecordForm";
import OverflowMenu, { MENU_ITEM, MENU_ITEM_DANGER } from "./OverflowMenu";
import { useConfirm } from "./ConfirmDialog";
import { useUndoableDelete } from "./useUndoableDelete";
import { updateRecord, deleteRecord } from "@/app/(app)/medical/actions";

export default function EditableRecordRow({
  record,
  grouped,
  filterCategory = false,
}: {
  record: MedicalRecord;
  // When the table is name-sorted it groups contiguous same-name rows (like the
  // biomarkers table): the name shows once on the group's start row, and the
  // group-closing border falls only on its end row. Omit for ungrouped tables,
  // where every row shows its name and draws a border.
  grouped?: { isGroupStart: boolean; isGroupEnd: boolean };
  // When true, the category chip becomes a filter link that sets `?category=` on
  // the current path (preserving other params) — matching the biomarkers table.
  // Opt-in so a host without a category filter renders a static chip.
  filterCategory?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const confirm = useConfirm();
  const undoable = useUndoableDelete();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const r = record;

  // Href that filters this table to the row's category while preserving sort/dir/
  // range/q (mirrors the biomarkers category link). Null when not filterable.
  const categoryHref = (() => {
    if (!filterCategory) return null;
    const sp = new URLSearchParams(searchParams.toString());
    sp.set("category", r.category);
    const s = sp.toString();
    return s ? `${pathname}?${s}` : pathname;
  })();

  if (!editing) {
    const showName = grouped ? grouped.isGroupStart : true;
    const rowBorder =
      !grouped || grouped.isGroupEnd
        ? "border-b border-black/5 dark:border-white/10"
        : "";
    return (
      <tr className={rowBorder}>
        <td className="td font-medium">
          {!showName ? null : r.canonical_name ? (
            <Link
              href={`/biomarkers/view?name=${encodeURIComponent(r.canonical_name)}`}
              className="text-brand-700 hover:underline dark:text-brand-400"
              title={`View ${r.canonical_name} over time`}
            >
              {r.name}
            </Link>
          ) : (
            r.name
          )}
          {/* Performing provider, as a muted sub-line. */}
          {r.provider_name ? (
            <div className="text-xs font-normal text-slate-400 dark:text-slate-500">
              {r.provider_name}
            </div>
          ) : null}
        </td>
        <td className="td text-slate-500 dark:text-slate-400">
          {r.panel ?? "—"}
        </td>
        <td className="td">
          <MedicalValue value={r.value} unit={r.unit} flag={r.flag} />
        </td>
        <td className="td text-slate-500 dark:text-slate-400">
          {r.reference_range ?? "—"}
        </td>
        <td className="td text-slate-500 dark:text-slate-400">
          {r.notes ?? ""}
        </td>
        <td className="td">
          {categoryHref ? (
            <Link
              href={categoryHref}
              title={`Filter by ${r.category}`}
              className="hover:opacity-80"
            >
              <Tag value={r.category} />
            </Link>
          ) : (
            <Tag value={r.category} />
          )}
        </td>
        <td className="td whitespace-nowrap">{r.date}</td>
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
                  {/* Plain button (not a form action): confirm() opens a modal
                      the user must answer, which deadlocks inside a form-action
                      transition. onClick is a normal handler, so it shows. */}
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

  // Edit mode: the shared RecordForm (same fields + write path the add slot uses)
  // swaps in place of the row; updateRecord is profile-scoped and reconciles flags.
  return (
    <tr className="border-b border-black/5 bg-slate-50/60 dark:border-white/10 dark:bg-ink-900/60">
      <td colSpan={8} className="px-3 py-3">
        <RecordForm
          mode="edit"
          record={r}
          action={updateRecord}
          onDone={() => setEditing(false)}
        />
      </td>
    </tr>
  );
}
