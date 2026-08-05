import type { ReactNode } from "react";
import ScrollFade from "@/components/ScrollFade";
import { EmptyState } from "@/components/ui";

// One column header of an admin log table.
export interface LogColumn {
  label: string;
  className?: string;
}

// The shared admin-log table shell (#1491 item 4, audit drift D1 — owner-decided
// full consolidation, 2026-07-25).
//
// The settings log quartet — Audit, AI logs (LogsStream), token usage
// (UsageRollup) and Errors — is structurally ONE table: a `card p-0` shell, a
// horizontal ScrollFade, `.th` headers on a hairline rule, `.td` rows, and a
// dashed empty panel. Each surface used to carry its own copy (audit alone on a
// bare `overflow-x-auto`, three hand-rolled empty boxes). The shell now lives
// here once; callers keep their own row rendering, filters, pagination,
// streaming and clear buttons — those are per-surface behavior, not shell.
//
// No hooks and no "use client": server components (the audit page) and client
// components (LogsStream) both render it.
export default function LogTable({
  columns,
  isEmpty,
  emptyMessage,
  emptyTestId,
  tableTestId,
  children,
}: {
  columns: LogColumn[];
  // The caller's emptiness verdict — it owns its row model (filtered, streamed,
  // sliced), so it says when the shared empty panel replaces the table.
  isEmpty: boolean;
  emptyMessage: string;
  emptyTestId?: string;
  tableTestId?: string;
  // The `<tbody>` rows.
  children?: ReactNode;
}) {
  if (isEmpty) {
    return <EmptyState message={emptyMessage} testId={emptyTestId} />;
  }
  return (
    <div className="card overflow-hidden p-0">
      <ScrollFade>
        <table className="w-full text-sm" data-testid={tableTestId}>
          <thead>
            <tr className="border-b border-black/5 dark:border-white/10">
              {columns.map((c, i) => (
                <th key={i} className={`th ${c.className ?? ""}`}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </ScrollFade>
    </div>
  );
}
