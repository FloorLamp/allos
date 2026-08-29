import Link from "next/link";
import type { ReactNode } from "react";
import type { AppRoute } from "@/lib/hrefs";

// THE ONE CARD SHELL FOR THE EVERYTHING LANE'S ACT ENTRIES (#3365).
//
// Cards act, lines report (#3077). Everything that reports now renders as a row
// through DashboardFactRow; what is left in a card is an offer to write, and every
// one of them draws its chrome here: one title scale, one placement for the trailing
// door, one control region. `children` is that region — the weight input, the symptom
// bar, the usual-routine offer, the vital button — and a hosted component that draws
// its own heading suppresses it in this mount, the way a dialog body does (#3361).
// A card with no title is not a shape this shell can make: an unlabelled card was one
// of the four chrome idioms this replaced.
export default function DashboardAtomCard({
  title,
  value,
  detail,
  href,
  actionLabel,
  testId = "dashboard-atom",
  children,
}: {
  title: string;
  value?: string | number | null;
  detail?: string | null;
  href?: AppRoute;
  actionLabel?: string;
  testId?: string;
  children?: ReactNode;
}) {
  return (
    <article className="card" data-testid={testId}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            {title}
          </h3>
          {value != null && (
            <p className="mt-1 text-xl font-semibold text-slate-900 dark:text-white">
              {value}
            </p>
          )}
          {detail && (
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {detail}
            </p>
          )}
        </div>
        {href && (
          <Link
            href={href}
            className={
              actionLabel
                ? "btn-ghost"
                : "text-sm font-medium text-brand-700 hover:underline dark:text-brand-400"
            }
          >
            {actionLabel ?? "View"}
          </Link>
        )}
      </div>
      {children != null && <div className="mt-3">{children}</div>}
    </article>
  );
}
