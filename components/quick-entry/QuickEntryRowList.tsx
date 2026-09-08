"use client";

import { createContext, useContext, type ReactNode } from "react";

const RowContext = createContext(false);

export function useQuickEntryRow(): boolean {
  return useContext(RowContext);
}

export function QuickEntryRowList({
  testId,
  children,
}: {
  testId: string;
  children: ReactNode;
}) {
  return (
    <ul
      data-testid={testId}
      className="divide-y divide-(--border) overflow-hidden rounded-lg border border-(--border) bg-surface"
    >
      {children}
    </ul>
  );
}

export function QuickEntryRow({
  testId,
  identity,
  facts,
  actions,
}: {
  testId: string;
  identity: ReactNode;
  facts?: ReactNode;
  actions: ReactNode;
}) {
  return (
    <li
      data-testid={testId}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2"
    >
      <div className="flex-auto">
        <div className="font-medium text-slate-800 dark:text-slate-100">
          {identity}
        </div>
        {facts}
      </div>
      <RowContext.Provider value>{actions}</RowContext.Provider>
    </li>
  );
}
