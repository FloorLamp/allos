import { requireScope, stampSubjects, type SubjectInfo } from "@/lib/scope";
import { today } from "@/lib/db";
import {
  getRankedPickerProviders,
  getIntakeCatalogOptions,
  getConditions,
  collectHouseholdRollup,
  countVisiblePools,
  findLinkableSupply,
} from "@/lib/queries";
import { mergedSituationOptions } from "@/lib/situations";
import { loadMedicationsData, type MedicationsData } from "./med-data";
import MedicationBoard from "./MedicationBoard";
import MedicationTodayStrip from "./MedicationTodayStrip";
import MedicationAddWorkspace from "./MedicationAddWorkspace";
import { ProviderOptionsProvider } from "@/components/ProviderOptionsContext";
import { SituationOptionsProvider } from "@/components/SituationOptionsContext";
import { IntakeOptionsProvider } from "@/components/IntakeOptionsContext";
import { addIntakeItem } from "@/app/(app)/nutrition/intake-actions";
import PageContainer from "@/components/PageContainer";
import {
  getDisplayFormatPrefs,
  getUnitPrefs,
  getSituations,
} from "@/lib/settings";
import { MEDICATION_FILTERS, type MedicationFilter } from "@/lib/hrefs";
import {
  medBoardOrder,
  medStripMember,
  type MedStripMember,
} from "@/lib/medication-multi-view";
import { isOnDemand } from "@/lib/intake-schedule";

export const dynamic = "force-dynamic";

// The Medications page (#817 redesign of #746; multi-view #1373).
//
// Single-view (the overwhelmingly common case): ONE regimen board, computed exactly as
// before — the Today panel, safety strip, current/past lists, and review — with the
// acting-only add-workspace above it. Byte-identical to the pre-#1373 page by
// construction (MedicationBoard renders the bare body when no subject is stamped).
//
// Multi-view (the login has toggled other profiles into view, #1096): a merged "Today
// across everyone" strip leads, then ONE compact regimen board per in-view member in
// scope order (acting first). Each member's board is loop-composed from its OWN
// loadMedicationsData — Today panel dueness, safety warnings, refill, adherence all
// derived in THAT member's timezone/today() (the per-profile-context trap; no set-based
// SQL — these are per-member derivations). Write reach gates per member: dose confirms
// carry the member's profileId (#858), deep management + the add-workspace stay acting-
// only (#1096 write-centric), a read-only member's board is view-only. One intake_items
// table; supplements live on Nutrition → Supplements.
export default async function MedicationsPage(props: {
  searchParams: Promise<{
    filter?: string | string[];
    supply?: string | string[];
  }>;
}) {
  const searchParams = await props.searchParams;
  const scope = await requireScope();
  const { loginId, actingProfileId, viewIds } = scope;
  const multi = viewIds.length > 1;

  // Maintenance filter (#1146): `?filter=needs-rxcui` narrows each board's current list
  // to active meds with no confirmed RxNorm code. Unknown values ignored.
  const rawFilter = Array.isArray(searchParams.filter)
    ? searchParams.filter[0]
    : searchParams.filter;
  const filter: MedicationFilter | null = MEDICATION_FILTERS.includes(
    rawFilter as MedicationFilter
  )
    ? (rawFilter as MedicationFilter)
    : null;

  // Opened from the medicine cabinet's "Add for another person" (#1705): `?supply=`
  // names the bottle this add should be seeded from and linked to. Resolved through the
  // SAME offerability rule the item form's picker uses, so an id outside this caller's
  // reach simply doesn't seed anything.
  const initialSupply = findLinkableSupply(
    scope.ids,
    Number(
      (Array.isArray(searchParams.supply)
        ? searchParams.supply[0]
        : searchParams.supply) ?? 0
    )
  );

  const weightUnit = getUnitPrefs(loginId).weightUnit;
  const timeFormat = getDisplayFormatPrefs(loginId).timeFormat;

  // Board order (product-decided): acting first, then the remaining in-view members.
  const boardOrder = medBoardOrder(actingProfileId, viewIds);

  // Loop-compose each member's data in its OWN context — the per-profile-context trap:
  // loadMedicationsData resolves today()/timezone/dueness per profile, so a set-based
  // SQL read would be wrong here.
  const boardData = new Map<number, MedicationsData>();
  for (const pid of boardOrder) {
    boardData.set(pid, loadMedicationsData(pid, weightUnit, timeFormat));
  }
  const actingData = boardData.get(actingProfileId)!;

  // Subject identity (#534) is stamped ONLY in multi-view, so a single-profile page
  // renders no header and stays byte-identical.
  const subjectById = new Map<number, SubjectInfo>();
  if (multi) {
    for (const s of stampSubjects(
      scope,
      boardOrder.map((id) => ({ profileId: id }))
    )) {
      subjectById.set(s.profileId, s.subject);
    }
  }

  // The leading "Today across everyone" strip — the household per-member attention
  // rollup (#221), medication-filtered, each in the member's own today().
  const stripMembers: { subject: SubjectInfo; strip: MedStripMember }[] = multi
    ? boardOrder.map((pid) => ({
        subject: subjectById.get(pid)!,
        strip: medStripMember(pid, collectHouseholdRollup(pid, today(pid))),
      }))
    : [];

  // The add-workspace is ACTING-ONLY (#1096 write-centric): its pickers/options come
  // from the acting profile. Conditions for the "For condition…" indication picker
  // (#1052); situation options for the schedule form.
  const medConditions = getConditions(actingProfileId).map((c) => ({
    id: c.id,
    name: c.name,
  }));
  const situationOptions = mergedSituationOptions(
    getSituations(actingProfileId)
  ).map((o) => o.name);

  const medCount = actingData.current.length + actingData.past.length;
  const prnCount = actingData.current.filter((item) =>
    isOnDemand(item.med)
  ).length;
  const subtitle = [
    `${actingData.current.length} current`,
    prnCount > 0 ? `${prnCount} as needed` : null,
    `${actingData.past.length} past`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <PageContainer width="reading" className="mx-auto">
      <ProviderOptionsProvider
        providers={getRankedPickerProviders(actingProfileId)}
      >
        <SituationOptionsProvider options={situationOptions}>
          <IntakeOptionsProvider
            options={getIntakeCatalogOptions(actingProfileId)}
          >
            <MedicationAddWorkspace
              initialSupply={initialSupply}
              // The medicine-cabinet door (#1522), counted over the WHOLE accessible
              // set rather than the acting profile — the cabinet is household-scoped,
              // and this is the number the /supplies page will list.
              cabinetCount={countVisiblePools(scope.ids)}
              subtitle={
                medCount === 0
                  ? "Track prescriptions, over-the-counter medications, doses, and refills."
                  : subtitle
              }
              action={addIntakeItem}
              allIntakeItems={actingData.allIntakeItems}
              stackItems={actingData.stackItems}
              pgxVariants={actingData.pgxVariants}
              trainingRestricted={actingData.trainingRestricted}
              pediatric={actingData.pediatric}
              age={actingData.age}
              todayStr={actingData.todayStr}
              conditions={medConditions}
            />

            {multi && <MedicationTodayStrip members={stripMembers} />}

            {/* Single-view renders the ONE board with no wrapper (byte-identical to the
          pre-#1373 page body); multi-view stacks the per-member boards. */}
            {(() => {
              const boards = boardOrder.map((pid) => (
                <MedicationBoard
                  key={pid}
                  data={boardData.get(pid)!}
                  timeFormat={timeFormat}
                  filter={filter}
                  subject={multi ? (subjectById.get(pid) ?? null) : null}
                  profileId={pid}
                  isActing={pid === actingProfileId}
                  canWrite={scope.access.get(pid) === "write"}
                />
              ));
              return multi ? (
                <div className="space-y-8">{boards}</div>
              ) : (
                boards[0]
              );
            })()}
          </IntakeOptionsProvider>
        </SituationOptionsProvider>
      </ProviderOptionsProvider>
    </PageContainer>
  );
}
