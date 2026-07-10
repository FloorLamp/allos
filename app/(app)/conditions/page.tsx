import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { getConditions } from "@/lib/queries";
import { PageHeader } from "@/components/ui";
import ConditionForm from "./ConditionForm";
import ConditionList from "./ConditionList";
import { addCondition } from "./actions";
import type { ConditionStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "resolved", label: "Resolved" },
] as const;

// Conditions / problem list: the current problem list, with manual
// add/edit/delete and an active/resolved filter.
export default async function ConditionsPage(props: {
  searchParams: Promise<{ status?: string }>;
}) {
  const searchParams = await props.searchParams;
  const { profile } = await requireSession();
  const raw = searchParams.status;
  const status: ConditionStatus | undefined =
    raw === "active" || raw === "resolved" || raw === "inactive"
      ? raw
      : undefined;
  const rows = getConditions(profile.id, status ? { status } : {});
  const active = raw ?? "all";

  return (
    <div>
      <PageHeader
        title="Conditions"
        subtitle="Your problem list — active conditions and diagnoses, coded (ICD-10 / SNOMED) when imported from a health record."
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <div className="flex flex-wrap items-center gap-2">
            {FILTERS.map((f) => {
              const isActive = active === f.key;
              const href =
                f.key === "all" ? "/conditions" : `/conditions?status=${f.key}`;
              return (
                <Link
                  key={f.key}
                  href={href}
                  className={`rounded-full px-3 py-1 text-sm font-medium transition ${
                    isActive
                      ? "bg-brand-500 text-white"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-ink-800 dark:text-slate-300 dark:hover:bg-ink-750"
                  }`}
                >
                  {f.label}
                </Link>
              );
            })}
          </div>
          <ConditionList items={rows} />
        </div>

        <div className="min-w-0 space-y-4">
          <ConditionForm action={addCondition} />
          <p className="px-1 text-xs text-slate-400 dark:text-slate-500">
            Informational only, not medical advice. Imported problems come from
            uploaded health records (CCD Active Problems section).
          </p>
        </div>
      </div>
    </div>
  );
}
