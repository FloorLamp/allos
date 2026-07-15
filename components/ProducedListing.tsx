import Link from "next/link";
import { IconChevronRight } from "@tabler/icons-react";
import type { ProducedItem } from "@/lib/import-browser";
import { EmptyState } from "./ui";

// Read-only listing panel for a non-medical_records tab of the import-detail
// records browser (#271): the rows this document produced in one domain table
// (visits, conditions, …), each deep-linking to its domain page. The rows are
// shaped by the pure lib/import-browser helpers; editing stays on the domain
// pages themselves.
export default function ProducedListing({
  title,
  items,
}: {
  title: string;
  items: ProducedItem[];
}) {
  return (
    <div className="card" data-testid="produced-listing">
      <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
        {title}{" "}
        <span className="font-normal text-slate-500 dark:text-slate-400">
          ({items.length})
        </span>
      </h2>
      {items.length === 0 ? (
        <EmptyState message="No rows of this type are stored for this document." />
      ) : (
        <ul className="text-sm text-slate-600 dark:text-slate-300">
          {items.map((item, i) => (
            <li
              // Ids can repeat across the merged body-sample sources, so the
              // index disambiguates the key.
              key={`${item.id}-${i}`}
              data-testid="produced-item"
              className="border-b border-black/5 last:border-0 dark:border-white/10"
            >
              <Link
                href={item.href}
                className="group flex flex-wrap items-baseline gap-x-2 py-2 hover:text-brand-700 dark:hover:text-brand-400"
              >
                <span className="font-medium text-slate-800 group-hover:text-brand-700 dark:text-slate-100 dark:group-hover:text-brand-400">
                  {item.title}
                </span>
                {item.detail && (
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {item.detail}
                  </span>
                )}
                {item.date && (
                  <span className="ml-auto whitespace-nowrap text-xs tabular-nums text-slate-500 dark:text-slate-400">
                    {item.date}
                  </span>
                )}
                <IconChevronRight className="h-3.5 w-3.5 shrink-0 self-center text-slate-300 group-hover:text-brand-600 dark:text-slate-600 dark:group-hover:text-brand-400" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
