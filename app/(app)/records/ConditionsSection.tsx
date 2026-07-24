import Link from "next/link";
import { getConditions, getMedicationsByIndication } from "@/lib/queries";
import { readForProfiles, stampSubjects, type ProfileScope } from "@/lib/scope";
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
//
// Multi-view (#1328): reads the whole view-set list-first (readForProfiles loops the
// per-profile reader so each profile's document-dedup CTE stays scoped correctly),
// stamps subject identity, and threads `multiView` to the list so non-acting rows
// carry a subject chip and per-item write gate. Single view (viewIds = [acting])
// renders byte-identical.
export default function ConditionsSection({
  scope,
  cond,
}: {
  scope: ProfileScope;
  cond?: string;
}) {
  const status: ConditionStatus | undefined =
    cond === "active" || cond === "resolved" || cond === "inactive"
      ? cond
      : undefined;
  const multi = scope.viewIds.length > 1;
  const rows = stampSubjects(
    scope,
    readForProfiles(scope.viewIds, (pid) =>
      getConditions(pid, status ? { status } : {})
    )
  );
  // Med → indication inverse view (#1052): condition id → treating med names, so the
  // list can show a "Treated with:" sub-line. Condition ids are globally unique, so
  // merging the per-profile maps across the view-set is collision-free.
  const treatedWith = Object.fromEntries(
    scope.viewIds.flatMap((pid) => [...getMedicationsByIndication(pid)])
  );
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
        <ConditionList
          items={rows}
          treatedWith={treatedWith}
          multiView={
            multi ? { actingProfileId: scope.actingProfileId } : undefined
          }
        />
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
