import Link from "next/link";
import { IconArrowRight, type TablerIcon } from "@tabler/icons-react";
import type { ReactNode } from "react";
import type { AppRoute } from "@/lib/hrefs";

// The DORMANT collapse (#2652 behavior 2). A card whose domain has recorded and then
// gone quiet past its declared interval (lib/domain-dormancy.ts) spends one line here
// instead of a card about today.
//
// THIS IS NOT AN EMPTY STATE, and it deliberately shares nothing with one:
//   • `<EmptyState>`'s `data-empty-state` marker is load-bearing (#2531/#2399 — an
//     ABSENT chart must not reserve the chart's height). A dormant domain is not
//     absent; it has data, just none recently. Copying that marker here would tell
//     every consumer of it the opposite of the truth, so this carries its own.
//   • `<WidgetEmpty>` is the ONBOARDING case, and its copy is a first-run invitation.
//     Saying "no weigh-ins yet" to somebody with a year of them is the defect this
//     replaces.
//
// WHAT THE LINE OWES. It states the age of the RECORD (never a claim about the body,
// never a guess at why), and it carries the fix — a link to the surface that would end
// the silence, or, where the fix is a WRITE, the write itself. Everything it replaced
// stays one tap away: nothing is removed by adaptation.
//
// The heading stays an `<h2>` so the card keeps its place in the page's outline: a
// collapsed section is still a section, and a reader navigating by heading must still
// find it. Only its height changed.
type WidgetDormantProps = {
  title: string;
  icon: TablerIcon;
  /** The honest sentence from `dormantRecordLine` — the record, and how long. */
  line: string;
} & (
  | { ctaLabel: string; ctaHref: AppRoute; cta?: never }
  | { cta: ReactNode; ctaLabel?: never; ctaHref?: never }
);

export default function WidgetDormant(props: WidgetDormantProps) {
  const { title, icon: Icon, line } = props;
  return (
    <div
      className="card flex flex-wrap items-center gap-x-2 gap-y-1 border-dashed py-3 text-sm"
      data-testid="widget-dormant"
    >
      <Icon
        className="h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400"
        stroke={1.75}
        aria-hidden="true"
      />
      <h2 className="font-semibold text-slate-800 dark:text-slate-100">
        {title}
      </h2>
      <p
        className="text-slate-500 dark:text-slate-400"
        data-testid="widget-dormant-line"
      >
        {line}
      </p>
      {props.ctaHref !== undefined ? (
        <Link
          href={props.ctaHref}
          className="inline-flex items-center gap-0.5 text-link"
        >
          {props.ctaLabel}
          <IconArrowRight className="h-4 w-4" stroke={1.75} />
        </Link>
      ) : (
        props.cta
      )}
    </div>
  );
}
