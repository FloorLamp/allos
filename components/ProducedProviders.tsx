import Link from "next/link";
import {
  IconChevronRight,
  IconUser,
  IconBuildingHospital,
} from "@tabler/icons-react";
import type { ProducedProvider } from "@/lib/import-browser";
import { EmptyState } from "./ui";

// Read-only listing panel for the import-detail Providers tab (#1182): the
// distinct global-registry providers THIS document's rows reference, each
// deep-linking to its /providers/[id] page (#275). Promotes the old count chip
// (which dumped you into the whole registry index) to a real produced-rows
// panel. Rows are shaped by lib/import-browser.providerItems — the disambiguated
// label (#531/#534) and the individual/organization type both come pre-computed;
// this only renders. Providers stay excluded from extracted_count (#212).
export default function ProducedProviders({
  title,
  providers,
}: {
  title: string;
  providers: ProducedProvider[];
}) {
  return (
    <div className="card" data-testid="produced-providers">
      <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
        {title}{" "}
        <span className="font-normal text-slate-500 dark:text-slate-400">
          ({providers.length})
        </span>
      </h2>
      {providers.length === 0 ? (
        <EmptyState message="This document references no providers." />
      ) : (
        <ul className="text-sm text-slate-600 dark:text-slate-300">
          {providers.map((p) => {
            const Icon = p.type === "individual" ? IconUser : IconBuildingHospital;
            return (
              <li
                key={p.id}
                data-testid="produced-provider"
                className="border-b border-black/5 last:border-0 dark:border-white/10"
              >
                <Link
                  href={p.href}
                  className="group flex items-center gap-2 py-2 hover:text-brand-700 dark:hover:text-brand-400"
                >
                  <Icon
                    className="h-4 w-4 shrink-0 text-slate-400 group-hover:text-brand-600 dark:text-slate-500 dark:group-hover:text-brand-400"
                    aria-label={
                      p.type === "individual" ? "Individual" : "Organization"
                    }
                  />
                  <span className="font-medium text-slate-800 group-hover:text-brand-700 dark:text-slate-100 dark:group-hover:text-brand-400">
                    {p.label}
                  </span>
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {p.type === "individual" ? "Individual" : "Organization"}
                  </span>
                  <IconChevronRight className="ml-auto h-3.5 w-3.5 shrink-0 self-center text-slate-300 group-hover:text-brand-600 dark:text-slate-600 dark:group-hover:text-brand-400" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
