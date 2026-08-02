import Link from "next/link";
import { IconArrowRight, type TablerIcon } from "@tabler/icons-react";
import type { ReactNode } from "react";
import type { AppRoute } from "@/lib/hrefs";

// The data-aware onboarding empty state (issue #171). When a data-aware widget's
// domain has no data yet, the page renders this compact CTA instead of a blank
// card — the dashboard doubles as the onboarding checklist, each empty widget
// pointing at the pipeline that fills it (connect Health Connect, import labs, add
// medications). Kept small so an empty widget is a quiet nudge, not clutter.
//
// The CTA is normally a LINK to the pipeline that fills the domain. Since #1892 it may
// instead be a supplied `cta` node, for the case where the thing that fills the domain
// is an in-place LOG rather than a page: the vitals card's empty and non-empty states
// then open the very same quick-entry, so the affordance does not vanish the moment
// the first reading lands. Exactly one of the two forms is given.
type WidgetEmptyProps = {
  title: string;
  icon: TablerIcon;
  message: string;
} & (
  | { ctaLabel: string; ctaHref: AppRoute; cta?: never }
  | { cta: ReactNode; ctaLabel?: never; ctaHref?: never }
);

export default function WidgetEmpty(props: WidgetEmptyProps) {
  const { title, icon: Icon, message } = props;
  return (
    <div className="card h-full" data-testid="widget-empty">
      <div className="mb-3 flex items-center gap-2">
        <Icon
          className="h-5 w-5 text-slate-500 dark:text-slate-400"
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
      {props.ctaHref !== undefined ? (
        <Link href={props.ctaHref} className="btn btn-sm">
          {props.ctaLabel}
          <IconArrowRight className="h-4 w-4" stroke={1.75} />
        </Link>
      ) : (
        props.cta
      )}
    </div>
  );
}
