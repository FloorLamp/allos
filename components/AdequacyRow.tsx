import type { ReactNode } from "react";

// One nutrient's ROW in the "Today's nutrients" card (issues #767, #976, #980, #4485):
// a left status accent, the nutrient's name, its verdict word, and its gauge beneath.
// Protein and fiber spelled this row out twice with one word of copy between them.
//
// A PURE FORMATTER over a verdict the pure tier already reached. It maps a status to an
// accent and a word; it decides nothing, and a row whose status is absent simply renders
// without one rather than guessing a verdict from anything else on the page.

const STATUS_ACCENT: Record<string, string> = {
  below: "border-l-amber-300 dark:border-l-amber-700",
  within: "border-l-emerald-300 dark:border-l-emerald-700",
  above: "border-l-slate-300 dark:border-l-slate-600",
};

export default function AdequacyRow({
  testId,
  title,
  status,
  basis,
  statusLabel,
  children,
}: {
  testId: string;
  title: string;
  /** The verdict, or undefined when the model could not reach one. */
  status?: string;
  /** Which columns fed the figure — surfaced for assertions, never read for meaning. */
  basis: string;
  /** The verdict's word. Protein and fiber differ on one of the three. */
  statusLabel?: string;
  children?: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      data-status={status ?? ""}
      data-basis={basis}
      className={`border-l-4 pl-3 ${STATUS_ACCENT[status ?? ""] ?? STATUS_ACCENT.within}`}
    >
      <div className="mb-1 flex items-center justify-between gap-3">
        <h3 className="font-semibold text-slate-800 dark:text-slate-100">
          {title}
        </h3>
        {statusLabel && (
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
            {statusLabel}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}
