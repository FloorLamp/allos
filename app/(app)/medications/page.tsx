import { requireSession } from "@/lib/auth";
import { getProviderNames, getConditions } from "@/lib/queries";
import { loadMedicationsData } from "./med-data";
import MedicationsTodayPanel from "./MedicationsTodayPanel";
import MedicationRow from "./MedicationRow";
import MedicationListActions from "./MedicationListActions";
import RecordsBridge from "./RecordsBridge";
import DormantPrnSweep from "./DormantPrnSweep";
import MedicationAddWorkspace from "./MedicationAddWorkspace";
import IntakeWarnings, { IntakeSafetyScope } from "@/components/IntakeWarnings";
import ProviderDatalist from "@/components/ProviderDatalist";
import { addSupplement } from "@/app/(app)/nutrition/supplement-actions";
import CardGroup, { CardGroupSection } from "@/components/CardGroup";
import PageContainer from "@/components/PageContainer";
import { getDisplayFormatPrefs, getUnitPrefs } from "@/lib/settings";
import { IconChevronDown } from "@tabler/icons-react";

export const dynamic = "force-dynamic";

// The Medications page (#817 redesign of #746): shaped around what's unique to
// medications rather than a supplement-shaped lifecycle-card transplant.
//   1. Today panel (leads) — scheduled dose check-offs + PRN administration rows,
//      the daily-use job first.
//   2. Safety strip — cross-kind interaction (#144) + PGx (#710) warnings, the same
//      dedupeKeys the Supplements tab renders through the shared bus (dismiss once,
//      silence both — #435); renders nothing when quiet.
//   3. Medication list — current medications as flat, dose-forward rows in one
//      surface, with Past collapsed below and print/share in the section header.
//   4. Review medication list — imported-prescription and dormant-PRN suggestions
//      grouped as maintenance work rather than floating page sections.
//   5. Add medication — one header CTA opens an inline workspace that starts with
//      OTC quick-add and switches to the full prescription/schedule form on demand.
// One intake_items table; supplements live on Nutrition → Supplements.
export default async function MedicationsPage() {
  const { login, profile } = await requireSession();
  const formatPrefs = getDisplayFormatPrefs(login.id);
  const data = loadMedicationsData(
    profile.id,
    getUnitPrefs(login.id).weightUnit,
    formatPrefs.timeFormat
  );
  // Conditions for the "For condition…" indication picker (#1052) on the add/edit
  // med forms — just id + name.
  const medConditions = getConditions(profile.id).map((c) => ({
    id: c.id,
    name: c.name,
  }));
  const medCount = data.current.length + data.past.length;
  const prnCount = data.current.filter(
    (item) => item.med.as_needed === 1
  ).length;
  const hasReviewItems =
    data.bridge.length > 0 ||
    data.dismissedBridge.length > 0 ||
    data.dormantPrn.length > 0 ||
    data.dismissedDormantPrn.length > 0;
  const hasSafetyWarnings =
    data.interactionWarnings.length > 0 ||
    data.pgxWarnings.length > 0 ||
    data.ototoxicWarnings.length > 0 ||
    data.allergyWarnings.length > 0;
  const subtitle = [
    `${data.current.length} current`,
    prnCount > 0 ? `${prnCount} as needed` : null,
    `${data.past.length} past`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <PageContainer width="reading" className="mx-auto">
      {/* Provider picker options for the medication add/edit forms. */}
      <ProviderDatalist names={getProviderNames()} />
      <MedicationAddWorkspace
        subtitle={
          medCount === 0
            ? "Track prescriptions, over-the-counter medications, doses, and refills."
            : subtitle
        }
        action={addSupplement}
        allSupplements={data.allSupplements}
        stackItems={data.stackItems}
        pgxVariants={data.pgxVariants}
        trainingRestricted={data.trainingRestricted}
        pediatric={data.pediatric}
        age={data.age}
        todayStr={data.todayStr}
        conditions={medConditions}
      />

      <div className="space-y-5">
        {/* 1. Today panel (leads). */}
        <MedicationsTodayPanel
          scheduled={data.current}
          prnToday={data.prnToday}
          taken={data.taken}
          skipped={data.skipped}
          nowHhmm={data.nowHhmm}
          nowIso={data.nowIso}
          timeFormat={formatPrefs.timeFormat}
          timezone={data.tz}
        />

        {/* 2. Safety strip — medication-related interaction, PGx, and ototoxic
            warnings. Cross-kind interactions also appear on Supplements; medication-only
            findings stay here. */}
        <IntakeWarnings
          interactionWarnings={data.interactionWarnings}
          pgxWarnings={data.pgxWarnings}
          ototoxicWarnings={data.ototoxicWarnings}
          allergyWarnings={data.allergyWarnings}
          coverage={data.coverage}
        />

        {/* 3. Current medications stay primary. Past medications use their own muted,
            collapsed surface below so the two states are distinguishable at a glance. */}
        <CardGroup
          title="Current medications"
          description={`${data.current.length} active medication${data.current.length === 1 ? "" : "s"} · Dose schedules, refill status, and recent adherence.`}
          action={
            data.current.length > 0 ? <MedicationListActions /> : undefined
          }
          data-testid="medication-list"
        >
          <CardGroupSection>
            {data.current.length > 0 ? (
              <div className="divide-y divide-black/5 dark:divide-white/5">
                {data.current.map((m) => (
                  <MedicationRow
                    key={m.med.id}
                    med={m.med}
                    doses={m.doses}
                    courses={m.courses}
                    sideEffects={m.sideEffects}
                    strip={m.strip}
                    refillRate={m.refillRate}
                    prnRedoseLine={m.prnRedoseLine}
                    monitoringNote={m.monitoringNote}
                    todayStr={data.todayStr}
                  />
                ))}
              </div>
            ) : (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                No current medications yet.
              </p>
            )}
          </CardGroupSection>
        </CardGroup>

        {data.past.length > 0 ? (
          <details className="card group" data-testid="past-medications">
            <summary className="-m-2 flex w-[calc(100%+1rem)] cursor-pointer list-none items-center justify-between gap-4 rounded-lg p-2 outline-none transition hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-500/40 [&::-webkit-details-marker]:hidden dark:hover:bg-ink-850">
              <span className="min-w-0">
                <span className="block text-base font-semibold text-slate-700 dark:text-slate-200">
                  Past medications
                </span>
                <span className="mt-1 block text-sm text-slate-500 dark:text-slate-400">
                  {data.past.length} completed or stopped
                </span>
              </span>
              <IconChevronDown className="h-4 w-4 shrink-0 text-slate-500 transition-transform group-open:rotate-180 dark:text-slate-400" />
            </summary>
            <div className="mt-5 divide-y divide-black/5 border-t border-black/5 pt-1 dark:divide-white/5 dark:border-white/5">
              {data.past.map((m) => (
                <MedicationRow
                  key={m.med.id}
                  med={m.med}
                  doses={m.doses}
                  courses={m.courses}
                  sideEffects={m.sideEffects}
                  strip={m.strip}
                  refillRate={m.refillRate}
                  prnRedoseLine={m.prnRedoseLine}
                  todayStr={data.todayStr}
                />
              ))}
            </div>
          </details>
        ) : null}

        {/* 4. Maintenance suggestions share one review surface instead of floating rows. */}
        {hasReviewItems ? (
          <CardGroup
            title="Review medication list"
            description="Resolve imported prescriptions and medications that may no longer be current."
            data-testid="medication-review"
          >
            {(data.bridge.length > 0 || data.dismissedBridge.length > 0) && (
              <CardGroupSection>
                <RecordsBridge
                  suggestions={data.bridge}
                  dismissed={data.dismissedBridge}
                />
              </CardGroupSection>
            )}
            {(data.dormantPrn.length > 0 ||
              data.dismissedDormantPrn.length > 0) && (
              <CardGroupSection>
                <DormantPrnSweep
                  suggestions={data.dormantPrn}
                  dismissed={data.dismissedDormantPrn}
                />
              </CardGroupSection>
            )}
          </CardGroup>
        ) : null}

        {!hasSafetyWarnings ? (
          <IntakeSafetyScope coverage={data.coverage} />
        ) : null}
      </div>
    </PageContainer>
  );
}
