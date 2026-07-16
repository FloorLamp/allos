"use client";

import Link from "next/link";
import { IconPill } from "@tabler/icons-react";
import type { AppRoute } from "@/lib/hrefs";

// The ONE Today-panel row primitive shared by scheduled check-off rows AND PRN
// administration rows (issue #851 item 10). Both used to evolve different containers
// (some bare, some inset with borders); now the kind is expressed by the CONTROL
// (a checkbox pill vs a Log button + window chip), never by container styling. Every
// row is an inset bordered box: icon + name on the left, the kind's control on the
// right, with optional sublines (the PRN "N today · last …" / redose chip) and a
// full-width footer (the retro-offset options). Carries `data-today-row` so a browser
// test can pin that both kinds share the shape.
export default function TodayMedRow({
  name,
  href,
  control,
  sublines,
  footer,
  testId = "today-med-row",
  itemId,
}: {
  name: string;
  href?: AppRoute;
  control: React.ReactNode;
  sublines?: React.ReactNode;
  footer?: React.ReactNode;
  testId?: string;
  itemId?: number;
}) {
  return (
    <div
      data-testid={testId}
      data-today-row="1"
      data-item-id={itemId}
      className="flex flex-col gap-2 rounded-lg border border-black/5 p-3 dark:border-white/5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <IconPill className="h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400" />
          {href ? (
            <Link
              href={href}
              className="min-w-0 truncate font-medium text-slate-800 hover:underline dark:text-slate-100"
            >
              {name}
            </Link>
          ) : (
            <span className="min-w-0 truncate font-medium text-slate-800 dark:text-slate-100">
              {name}
            </span>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {control}
        </div>
      </div>
      {sublines}
      {footer}
    </div>
  );
}
