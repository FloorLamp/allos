import Link from "next/link";
import { IconArrowRight, type TablerIcon } from "@tabler/icons-react";

// The data-aware onboarding empty state (issue #171). When a data-aware widget's
// domain has no data yet, the page renders this compact CTA instead of a blank
// card — the dashboard doubles as the onboarding checklist, each empty widget
// pointing at the pipeline that fills it (connect Health Connect, import labs, add
// medications). Kept small so an empty widget is a quiet nudge, not clutter.
export default function WidgetEmpty({
  title,
  icon: Icon,
  message,
  ctaLabel,
  ctaHref,
}: {
  title: string;
  icon: TablerIcon;
  message: string;
  ctaLabel: string;
  ctaHref: string;
}) {
  return (
    <div className="card h-full" data-testid="widget-empty">
      <div className="mb-3 flex items-center gap-2">
        <Icon
          className="h-5 w-5 text-slate-400 dark:text-slate-500"
          stroke={1.75}
          aria-hidden="true"
        />
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          {title}
        </h2>
      </div>
      <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
        {message}
      </p>
      <Link
        href={ctaHref}
        className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-brand-700"
      >
        {ctaLabel}
        <IconArrowRight className="h-4 w-4" stroke={1.75} />
      </Link>
    </div>
  );
}
