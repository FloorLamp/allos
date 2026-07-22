"use client";

export default function PaginationControls({
  page,
  pageCount,
  pageSize,
  total,
  visibleCount,
  onPageChange,
  testId,
}: {
  page: number;
  pageCount: number;
  pageSize: number;
  total: number;
  visibleCount: number;
  onPageChange: (page: number) => void;
  testId?: string;
}) {
  if (total === 0) return null;
  const start = (page - 1) * pageSize;

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-3 py-2 text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400"
      data-testid={testId}
    >
      <span>
        Showing {start + 1}–{start + visibleCount} of {total}
      </span>
      {pageCount > 1 && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn-ghost text-sm disabled:opacity-40"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            Prev
          </button>
          <span>
            Page {page} of {pageCount}
          </span>
          <button
            type="button"
            className="btn-ghost text-sm disabled:opacity-40"
            disabled={page >= pageCount}
            onClick={() => onPageChange(page + 1)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
