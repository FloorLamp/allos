"use client";

import Link from "next/link";
import { IconPill } from "@tabler/icons-react";
import type { AppRoute } from "@/lib/hrefs";

// The ONE Today-panel row primitive shared by scheduled check-off rows AND PRN
// administration rows (issue #851 item 10). Both used to evolve different containers
// (some bare, some inset with borders); now rows in the same host share a variant and
// the medication kind is expressed by the CONTROL (a checkbox pill vs a Log button +
// window chip). Each row uses the inset variant by default: icon + name on the left, the kind's control
// on the right, with optional sublines (the PRN "N today · last …" / redose chip) and
// a full-width footer (the retro-offset options). The embedded variant is for rows
// already inside a grouped card, where another rounded box would create a card within
// a card. Carries `data-today-row` so browser tests can pin the shared structure.
export default function TodayMedRow({
  name,
  detail,
  href,
  control,
  status,
  sublines,
  footer,
  testId = "today-med-row",
  itemId,
  pastDue = false,
  variant = "inset",
}: {
  name: string;
  detail?: string | null;
  href?: AppRoute;
  control?: React.ReactNode;
  status?: React.ReactNode;
  sublines?: React.ReactNode;
  footer?: React.ReactNode;
  testId?: string;
  itemId?: number;
  pastDue?: boolean;
  variant?: "inset" | "embedded";
}) {
  return (
    <div
      data-testid={testId}
      data-today-row="1"
      data-item-id={itemId}
      data-past-due={pastDue ? "1" : undefined}
      className={
        variant === "embedded"
          ? "flex flex-col gap-2 border-b border-black/5 py-3 last:border-b-0 dark:border-white/5"
          : "flex flex-col gap-2 rounded-lg border border-black/5 p-3 dark:border-white/5"
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          <IconPill className="mt-0.5 h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400" />
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
              {href ? (
                <Link
                  href={href}
                  className="flex min-w-0 items-baseline gap-1 text-sm font-medium text-brand-600 hover:underline dark:text-brand-400"
                >
                  <span className="truncate">{name}</span>
                  {detail ? (
                    <span className="shrink-0 text-xs font-normal text-slate-500 dark:text-slate-400">
                      · {detail}
                    </span>
                  ) : null}
                </Link>
              ) : (
                <span className="flex min-w-0 items-baseline gap-1 text-sm font-medium text-slate-800 dark:text-slate-100">
                  <span className="truncate">{name}</span>
                  {detail ? (
                    <span className="shrink-0 text-xs font-normal text-slate-500 dark:text-slate-400">
                      · {detail}
                    </span>
                  ) : null}
                </span>
              )}
              {status}
            </div>
            {sublines}
          </div>
        </div>
        {control ? (
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            {control}
          </div>
        ) : null}
      </div>
      {footer}
    </div>
  );
}
