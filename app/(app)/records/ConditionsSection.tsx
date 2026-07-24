import Link from "next/link";
import { getConditions, getMedicationsByIndication } from "@/lib/queries";
import ConditionForm from "@/app/(app)/conditions/ConditionForm";
import ConditionList from "@/app/(app)/conditions/ConditionList";
import { addCondition } from "@/app/(app)/conditions/actions";
import type { ConditionStatus } from "@/lib/types";
import type { AppRoute } from "@/lib/hrefs";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "resolved", label: "Resolved" },
] as const;

// Conditions / problem list (former /conditions index, #1042 phase 6): the
// current problem list, with manual add/edit/delete and an active/resolved
// filter, now the #conditions section of /records. The status filter rides the
// `?cond=` query param — namespaced away from Immunizations' `?status=` filter,
// which shares this page — with the section anchor preserved on each link.
export default function ConditionsSection({
  profileId,
  cond,
}: {
  profileId: number;
  cond?: string;
}) {
  const status: ConditionStatus | undefined =
    cond === "active" || cond === "resolved" || cond === "inactive"
      ? cond
      : undefined;
  const rows = getConditions(profileId, status ? { status } : {});
  // Med → indication inverse view (#1052): condition id → treating med names, so the
  // list can show a "Treated with:" sub-line. One query for the whole list (no N+1).
  const treatedWith = Object.fromEntries(getMedicationsByIndication(profileId));
  const active = cond ?? "all";

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="min-w-0 space-y-4 lg:col-span-2">
        <div className="flex flex-wrap items-center gap-2">
          {FILTERS.map((f) => {
            const isActive = active === f.key;
            const href: AppRoute =
              f.key === "all"
                ? "/records/problems"
                : `/records/problems?cond=${f.key}`;
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
        <ConditionList items={rows} treatedWith={treatedWith} />
      </div>

      <div className="min-w-0 space-y-4">
        <ConditionForm action={addCondition} />
        <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
          Imported problems come from uploaded health records (CCD Active
          Problems section).
        </p>
      </div>
    </div>
  );
}
