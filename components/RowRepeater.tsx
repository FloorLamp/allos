"use client";

import type { Dispatch, ReactNode, SetStateAction } from "react";
import { useMemo } from "react";
import { IconPlus, IconX } from "@tabler/icons-react";

// THE REPEATING-EDITOR PRIMITIVE (#4672).
//
// Five editors in the intake form each re-spelled the same three lines — patch row i,
// drop row i, append a row — and then each re-spelled the remove control around them.
// Two of the removes had already converged on #4505's control box by hand and a third
// had not, which is what a re-spelled control does: it converges late, one copy at a
// time, and the copies drift again between fixes.
//
// The list operations and the controls live here together on purpose. A repeater is a
// list plus the affordances that edit it, and splitting them would leave the next
// editor free to take the hook and hand-roll the buttons again.

export interface RowList<T> {
  // Merge `next` into row `i`. Rows are addressed by POSITION, not identity: these
  // lists are short, ordered, and rendered straight from the array, so the index is
  // the address the person is pointing at.
  patch: (i: number, next: Partial<T>) => void;
  remove: (i: number) => void;
  add: (row: T) => void;
}

// Every operation goes through the functional updater rather than a captured snapshot,
// so two edits in one batch compose instead of the second overwriting the first.
export function useRowList<T>(
  setRows: Dispatch<SetStateAction<T[]>>
): RowList<T> {
  return useMemo(
    () => ({
      patch: (i, next) =>
        setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...next } : r))),
      remove: (i) => setRows((rs) => rs.filter((_, j) => j !== i)),
      add: (row) => setRows((rs) => [...rs, row]),
    }),
    [setRows]
  );
}

// The remove control for one row. Sized by `--control-box` with the tap-target reach
// #4505 converged the icon-button family on — the one place that box is now spelled
// for a repeater row.
export function RowRemoveButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="tap-target flex h-(--control-box) w-(--control-box) items-center justify-center justify-self-end rounded-lg text-slate-500 transition hover:bg-rose-50 hover:text-rose-600 dark:text-slate-400 dark:hover:bg-rose-950 dark:hover:text-rose-400"
      aria-label={label}
    >
      <IconX className="h-4 w-4" />
    </button>
  );
}

// One add affordance per list, in one file. `empty` is the FIRST-ROW invitation for a
// list that starts with nothing — "List what's in this" rather than "Add ingredient" —
// and it replaces the whole block, heading included, because a heading over an empty
// list is a section about nothing. Without it an empty list simply shows its heading
// and its add button.
export default function RowRepeater({
  rows,
  header,
  children,
  add,
  empty,
  testId,
  className = "sm:col-span-2",
}: {
  rows: readonly unknown[];
  // Heading, help text and any seed note — whatever stands above the rows.
  header?: ReactNode;
  children: ReactNode;
  add: { label: string; onClick: () => void; testId?: string };
  empty?: { label: string; onClick: () => void; testId?: string };
  testId?: string;
  className?: string;
}) {
  if (rows.length === 0 && empty)
    return (
      <div className={className}>
        <button
          type="button"
          data-testid={empty.testId}
          onClick={empty.onClick}
          className="btn-ghost btn-sm"
        >
          {empty.label}
        </button>
      </div>
    );
  return (
    <div className={className} data-testid={testId}>
      {header}
      <div className="space-y-2">{children}</div>
      <button
        type="button"
        data-testid={add.testId}
        onClick={add.onClick}
        className="btn-ghost btn-sm mt-2"
      >
        <IconPlus className="h-4 w-4" stroke={2} aria-hidden="true" />
        {add.label}
      </button>
    </div>
  );
}
