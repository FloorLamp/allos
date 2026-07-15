"use client";

import { useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { IconDownload, IconPencil, IconTrash } from "@tabler/icons-react";
import { useToast } from "@/components/Toast";
import ScrollFade from "@/components/ScrollFade";
import {
  deleteDatasetRows,
  deleteAllDatasetRows,
} from "@/app/(app)/data/manage-actions";
import { undoDeletes } from "@/app/(app)/undo/actions";
import { currentPathHref } from "@/lib/hrefs";

// How long the bulk-delete "Undo" toast stays up (ms) — the holding rows live
// ~24h, but the toast is the only affordance, so it lingers past a normal toast.
const UNDO_TOAST_MS = 15000;

interface Dataset {
  key: string;
  label: string;
  columns: string[];
  // Browse/export-only datasets (child dose/log tables, hr_minutes) hide the
  // edit/delete affordances — they still count, browse, and download as CSV.
  deletable?: boolean;
}

// One managed dataset table on the Data → Manage tab: a paginated view with a
// CSV download, plus an edit mode that reveals per-row checkboxes for deleting
// the selected rows, or every row in the table.
//
// Issue #113: `rows` is now ONLY the current page (already LIMIT/OFFSET'd on the
// server), `total` is the full COUNT, and paging is a URL navigation (the server
// re-reads the next page) instead of slicing a full in-memory array — so the page
// no longer ships every row. Selection is kept by id in client state, which
// survives the soft navigation between pages, so you can still select rows across
// pages and delete them in one action.
export default function DataTableManager({
  dataset,
  rows,
  total,
  page,
  pageSize,
  pageParam,
}: {
  dataset: Dataset;
  // The current page's rows only (each carries a hidden `id`).
  rows: Record<string, unknown>[];
  // Total row count across all pages (drives the pager + the header count).
  total: number;
  // Current page, 1-based (already clamped server-side).
  page: number;
  pageSize: number;
  // The URL query param that drives this table's page position (`p_<key>`).
  pageParam: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [pending, setPending] = useState<null | "selected" | "all">(null);
  const [confirm, setConfirm] = useState<null | "selected" | "all">(null);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(Math.max(page, 1), pageCount);
  const start = (currentPage - 1) * pageSize;
  const pageRows = rows;

  // Navigate to another page by updating this table's URL param; the server reads
  // the new page. `replace` (not push) avoids stacking history on every click and
  // keeps scroll position; other tables' page params are preserved.
  function goToPage(p: number) {
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    params.set(pageParam, String(p));
    router.replace(currentPathHref(`${pathname}?${params.toString()}`), {
      scroll: false,
    });
  }

  const visibleIds = useMemo(
    () => pageRows.map((r) => Number(r.id)).filter((n) => Number.isInteger(n)),
    [pageRows]
  );
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));

  function reset() {
    setSelected(new Set());
    setConfirm(null);
  }

  function toggleEdit() {
    setEditing((v) => !v);
    reset();
  }

  function toggleRow(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setConfirm(null);
  }

  // Select-all toggles just the current page's rows, preserving any selection
  // made on other pages.
  function toggleAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (visibleIds.every((id) => next.has(id)))
        visibleIds.forEach((id) => next.delete(id));
      else visibleIds.forEach((id) => next.add(id));
      return next;
    });
    setConfirm(null);
  }

  async function doDelete(which: "selected" | "all") {
    setPending(which);
    try {
      const res =
        which === "all"
          ? await deleteAllDatasetRows(dataset.key)
          : await deleteDatasetRows(dataset.key, [...selected]);
      if (!res.ok) {
        toast(res.error, { tone: "error", duration: null });
        return;
      }
      const msg = `Deleted ${res.deleted} row${res.deleted === 1 ? "" : "s"} from ${dataset.label}.`;
      // Undoable datasets return one holding-token per captured row; offer a
      // single toast that restores the whole batch (issue #29).
      if (res.undoIds.length > 0) {
        const undoIds = res.undoIds;
        toast(msg, {
          duration: UNDO_TOAST_MS,
          action: {
            label: "Undo",
            onClick: () => {
              void (async () => {
                const { restored } = await undoDeletes(undoIds);
                if (restored > 0) {
                  toast(
                    `Restored ${restored} row${restored === 1 ? "" : "s"}.`
                  );
                  router.refresh();
                } else {
                  toast("Couldn’t undo — it may have expired.", {
                    tone: "error",
                  });
                }
              })();
            },
          },
        });
      } else {
        toast(msg);
      }
      reset();
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  const selectedCount = selected.size;
  const busy = pending !== null;
  const canDelete = dataset.deletable !== false;

  return (
    <div className="card" data-testid={`dataset-${dataset.key}`}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          {dataset.label}{" "}
          <span className="text-sm font-normal text-slate-500 dark:text-slate-400">
            ({total})
          </span>
        </h2>
        {total > 0 && (
          <div className="flex items-center gap-1">
            <a
              href={`/api/export/${dataset.key}`}
              download
              className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-ink-800"
            >
              <IconDownload className="h-4 w-4" /> CSV
            </a>
            {canDelete && (
              <button
                type="button"
                onClick={toggleEdit}
                className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-sm font-medium ${
                  editing
                    ? "bg-brand-500 text-white hover:bg-brand-600"
                    : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-ink-800"
                }`}
              >
                <IconPencil className="h-4 w-4" /> {editing ? "Done" : "Edit"}
              </button>
            )}
          </div>
        )}
      </div>

      {editing && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 p-2 text-sm dark:bg-ink-800/60">
          <span className="text-slate-500 dark:text-slate-400">
            {selectedCount} selected
          </span>
          <div className="ml-auto flex items-center gap-2">
            {confirm === "selected" ? (
              <ConfirmInline
                label={`Delete ${selectedCount} row${selectedCount === 1 ? "" : "s"}?`}
                busy={busy}
                onConfirm={() => doDelete("selected")}
                onCancel={() => setConfirm(null)}
              />
            ) : (
              <button
                type="button"
                disabled={selectedCount === 0 || busy}
                onClick={() => setConfirm("selected")}
                className="inline-flex items-center gap-1 rounded-lg border border-rose-200 px-2.5 py-1 font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-40 dark:border-rose-900 dark:text-rose-400 dark:hover:bg-rose-950/40"
              >
                <IconTrash className="h-4 w-4" /> Delete selected
              </button>
            )}
            {confirm === "all" ? (
              <ConfirmInline
                label={`Delete all ${total} rows? This can't be undone.`}
                confirmLabel="Delete all"
                busy={busy}
                onConfirm={() => doDelete("all")}
                onCancel={() => setConfirm(null)}
              />
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirm("all")}
                className="inline-flex items-center gap-1 rounded-lg bg-rose-600 px-2.5 py-1 font-medium text-white hover:bg-rose-700 disabled:opacity-40"
              >
                <IconTrash className="h-4 w-4" /> Delete all
              </button>
            )}
          </div>
        </div>
      )}

      {total === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          No data yet.
        </p>
      ) : (
        <>
          <ScrollFade>
            <table className="w-full text-left text-sm">
              <thead className="section-label">
                <tr>
                  {editing && (
                    <th className="w-8 py-1 pr-3">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-brand-600"
                        checked={allVisibleSelected}
                        onChange={toggleAllVisible}
                        aria-label="Select all rows shown"
                      />
                    </th>
                  )}
                  {dataset.columns.map((c) => (
                    <th key={c} className="whitespace-nowrap py-1 pr-3">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="text-slate-600 dark:text-slate-300">
                {pageRows.map((r, i) => {
                  const id = Number(r.id);
                  const isSel = selected.has(id);
                  return (
                    <tr
                      key={id || i}
                      className={`border-t border-black/5 dark:border-white/10 ${
                        isSel ? "bg-brand-50 dark:bg-brand-950/30" : ""
                      }`}
                    >
                      {editing && (
                        <td className="w-8 py-1 pr-3">
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-brand-600"
                            checked={isSel}
                            onChange={() => toggleRow(id)}
                            aria-label={`Select row ${i + 1}`}
                          />
                        </td>
                      )}
                      {dataset.columns.map((c) => (
                        <td
                          key={c}
                          className="whitespace-nowrap py-1 pr-3 tabular-nums"
                        >
                          {r[c] == null ? "" : String(r[c])}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollFade>
          <div className="mt-3 flex items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400">
            <span>
              Showing {start + 1}–{start + pageRows.length} of {total}
            </span>
            {pageCount > 1 && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => goToPage(currentPage - 1)}
                  disabled={currentPage <= 1}
                  className="btn-ghost text-sm disabled:opacity-40"
                >
                  Prev
                </button>
                <span className="text-slate-500 dark:text-slate-400">
                  Page {currentPage} of {pageCount}
                </span>
                <button
                  type="button"
                  onClick={() => goToPage(currentPage + 1)}
                  disabled={currentPage >= pageCount}
                  className="btn-ghost text-sm disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ConfirmInline({
  label,
  confirmLabel = "Delete",
  busy,
  onConfirm,
  onCancel,
}: {
  label: string;
  confirmLabel?: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="text-slate-600 dark:text-slate-300">{label}</span>
      <button
        type="button"
        disabled={busy}
        onClick={onConfirm}
        className="rounded-lg bg-rose-600 px-2.5 py-1 font-medium text-white hover:bg-rose-700 disabled:opacity-50"
      >
        {busy ? "Deleting…" : confirmLabel}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={onCancel}
        className="btn-ghost"
      >
        Cancel
      </button>
    </span>
  );
}
