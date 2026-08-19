import Link from "next/link";
import { IconArrowRight } from "@tabler/icons-react";
import type { AppRoute } from "@/lib/hrefs";
import type { ReactNode } from "react";

// Shared header for a card or nested section: the title on the left and a small
// "go to the full page" link on the right.
export default function CardSectionHeader({
  title,
  href,
  linkLabel = "View all",
  variant = "card",
  action,
  titleHref,
  showPageLink = true,
}: {
  title: string;
  href: AppRoute;
  linkLabel?: string;
  variant?: "card" | "section";
  action?: ReactNode;
  titleHref?: AppRoute;
  showPageLink?: boolean;
}) {
  const Heading = variant === "section" ? "h3" : "h2";
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <Heading
        className={
          variant === "section"
            ? "text-sm font-semibold text-slate-700 dark:text-slate-200"
            : "font-semibold text-slate-800 dark:text-slate-100"
        }
      >
        {titleHref ? (
          <Link
            href={titleHref}
            className="inline-flex items-center gap-1 text-link"
          >
            {title} <IconArrowRight className="h-4 w-4" />
          </Link>
        ) : (
          title
        )}
      </Heading>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {action}
        {showPageLink ? (
          <Link
            href={href}
            aria-label={`${linkLabel} ${title.toLowerCase()}`}
            className="inline-flex items-center gap-1 text-xs text-link"
          >
            {linkLabel} <IconArrowRight className="h-4 w-4" />
          </Link>
        ) : null}
      </div>
    </div>
  );
}
