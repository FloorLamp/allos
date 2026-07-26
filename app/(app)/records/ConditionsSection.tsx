import {
  getConditions,
  getMedicationsByIndication,
  encountersForRecords,
} from "@/lib/queries";
import FilterPills, { type FilterPillOption } from "@/components/FilterPills";
import { readForProfiles, stampSubjects, type ProfileScope } from "@/lib/scope";
import ConditionForm from "@/app/(app)/conditions/ConditionForm";
import ListRailLayout from "@/components/ListRailLayout";
import ConditionList from "@/app/(app)/conditions/ConditionList";
import { addCondition } from "@/app/(app)/conditions/actions";
import type { ConditionStatus } from "@/lib/types";

// The status filter, as the family's ONE filter affordance (#1449 cluster C):
// outline pills, link-driven so each state is a real URL and the (server) section
// needs no client JS. `all` drops the param rather than encoding it.
const FILTERS: readonly FilterPillOption<string>[] = [
  { value: "all", label: "All", href: "/records/problems/conditions" },
  {
    value: "active",
    label: "Active",
    href: "/records/problems/conditions?cond=active",
  },
  {
    value: "resolved",
    label: "Resolved",
    href: "/records/problems/conditions?cond=resolved",
  },
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
  // "Diagnosed at: <visit>" (#1355): condition id → its linked encounter, joining the
  // "Treated with:" line so a row reads diagnosis → visit → treatment. Condition ids are
  // globally unique, so merging the per-profile maps is collision-free.
  const diagnosedAt = Object.fromEntries(
    scope.viewIds.flatMap((pid) =>
      Object.entries(encountersForRecords(pid, "condition"))
    )
  );
  const active = cond ?? "all";

  return (
    <ListRailLayout
      rail={
        <>
          <ConditionForm action={addCondition} />
          <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
            Imported problems come from uploaded health records (CCD Active
            Problems section).
          </p>
        </>
      }
    >
      <FilterPills
        options={FILTERS}
        value={active}
        label="Filter conditions by status"
        testId="conditions-filter"
      />
      <ConditionList
        items={rows}
        treatedWith={treatedWith}
        diagnosedAt={diagnosedAt}
        multiView={
          multi ? { actingProfileId: scope.actingProfileId } : undefined
        }
      />
    </ListRailLayout>
  );
}
