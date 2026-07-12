import Link from "next/link";
import { IconArrowRight } from "@tabler/icons-react";
import type { AppRoute } from "@/lib/hrefs";

// Shared card header for dashboard widgets: the title on the left and a small
// "go to the full page" link on the right. Extracted so the widgets that used to
// be inline cards keep byte-identical markup without repeating it.
export default function WidgetHeader({
  title,
  href,
  linkLabel,
}: {
  title: string;
  href: AppRoute;
  linkLabel: string;
}) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="font-semibold text-slate-800 dark:text-slate-100">
        {title}
      </h2>
      <Link
        href={href}
        className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline dark:text-brand-400"
      >
        {linkLabel} <IconArrowRight className="h-4 w-4" />
      </Link>
    </div>
  );
}
