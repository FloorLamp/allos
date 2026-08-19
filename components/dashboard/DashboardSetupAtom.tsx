import Link from "next/link";
import { IconArrowRight, type TablerIcon } from "@tabler/icons-react";
import type { AppRoute } from "@/lib/hrefs";

// A compact setup atom for a domain with no data yet. It points at the pipeline
// that fills the domain (connect a source, import results, or log a first value).
//
type DashboardSetupAtomProps = {
  title: string;
  icon: TablerIcon;
  message: string;
  ctaLabel: string;
  ctaHref: AppRoute;
};

export default function DashboardSetupAtom({
  title,
  icon: Icon,
  message,
  ctaLabel,
  ctaHref,
}: DashboardSetupAtomProps) {
  return (
    <div className="card h-full" data-testid="dashboard-setup-atom">
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
      <Link href={ctaHref} className="btn btn-sm">
        {ctaLabel}
        <IconArrowRight className="h-4 w-4" stroke={1.75} />
      </Link>
    </div>
  );
}
