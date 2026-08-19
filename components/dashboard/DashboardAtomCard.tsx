import Link from "next/link";
import type { AppRoute } from "@/lib/hrefs";

export default function DashboardAtomCard({
  title,
  value,
  detail,
  href,
  actionLabel,
}: {
  title: string;
  value?: string | number | null;
  detail?: string | null;
  href?: AppRoute;
  actionLabel?: string;
}) {
  return (
    <article className="card" data-testid="dashboard-atom">
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
    </article>
  );
}
