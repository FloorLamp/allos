import { requireSession } from "@/lib/auth";
import { getProviderNames } from "@/lib/queries";
import { loadMedicationsData } from "./med-data";
import MedicationsTodayPanel from "./MedicationsTodayPanel";
import MedicationRow from "./MedicationRow";
import MedicationListActions from "./MedicationListActions";
import RecordsBridge from "./RecordsBridge";
import DormantPrnSweep from "./DormantPrnSweep";
import MedicationForm from "@/components/MedicationForm";
import QuickAddMedication from "@/components/QuickAddMedication";
import IntakeWarnings from "@/components/IntakeWarnings";
import ProviderDatalist from "@/components/ProviderDatalist";
import { addSupplement } from "@/app/(app)/nutrition/supplement-actions";
import { PageHeader, EmptyState } from "@/components/ui";

export const dynamic = "force-dynamic";

// The Medications page (#817 redesign of #746): shaped around what's unique to
// medications rather than a supplement-shaped lifecycle-card transplant.
//   1. Today panel (leads) — scheduled dose check-offs + PRN administration rows,
//      the daily-use job first.
//   2. Safety strip — cross-kind interaction (#144) + PGx (#710) warnings, the same
//      dedupeKeys the Supplements tab renders through the shared bus (dismiss once,
//      silence both — #435); renders nothing when quiet.
//   3. Current medications — scannable rows (not lifecycle cards); a row links to
//      the /medications/[id] clinical-record detail page.
//   4. From your records — suggest-only bridge for imported prescriptions with no
//      tracked med (#560).
//   5. Past / discontinued — collapsed rows linking to detail.
//   6. Add medication — an OTC quick-add (#843: name → label-default prefill → confirm)
//      then the full med-specific form with a medication-aware name combobox.
// One intake_items table; supplements live on Nutrition → Supplements.
export default async function MedicationsPage() {
  const { profile } = await requireSession();
  const data = loadMedicationsData(profile.id);
  const medCount = data.current.length + data.past.length;

  return (
    <div>
      {/* Provider picker options for the medication add/edit forms. */}
      <ProviderDatalist names={getProviderNames()} />
      <PageHeader
        title="Medications"
        subtitle={
          medCount === 0
            ? "Prescription and OTC medications — dose check-offs, courses, side effects, and refills."
            : `${data.current.length} current · ${data.past.length} past`
        }
      />

      <div className="space-y-6">
        {/* 1. Today panel (leads). */}
        <MedicationsTodayPanel
          scheduled={data.current}
          prnToday={data.prnToday}
          taken={data.taken}
          skipped={data.skipped}
          nowHhmm={data.nowHhmm}
        />

        {/* 2. Safety strip — interaction + PGx + ototoxic warnings (also on Supplements). */}
        <IntakeWarnings
          interactionWarnings={data.interactionWarnings}
          pgxWarnings={data.pgxWarnings}
          ototoxicWarnings={data.ototoxicWarnings}
          allergyWarnings={data.allergyWarnings}
        />

        {medCount === 0 ? (
          <EmptyState message="No medications yet. Add one below. Supplements live on the Nutrition → Supplements tab." />
        ) : (
          <>
            {/* 3. Current medications — scannable rows. */}
            {data.current.length > 0 && (
              <section>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h2 className="section-label text-rose-600 dark:text-rose-400">
                    Current
                  </h2>
                  {/* Print / share the current-medication list (#852 item 4). */}
                  <MedicationListActions />
                </div>
                <div className="space-y-3">
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
              </section>
            )}

            {/* 5. Past / discontinued — collapsed rows. */}
            {data.past.length > 0 && (
              <details>
                <summary className="cursor-pointer section-label">
                  Past / discontinued ({data.past.length})
                </summary>
                <div className="mt-2 space-y-3">
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
                      monitoringNote={m.monitoringNote}
                      todayStr={data.todayStr}
                    />
                  ))}
                </div>
              </details>
            )}
          </>
        )}

        {/* 4. From your records — suggest-only prescription bridge (+ dismissed list). */}
        <RecordsBridge
          suggestions={data.bridge}
          dismissed={data.dismissedBridge}
        />

        {/* 4b. Dormant-PRN sweep (#880) — suggest-only "move to past" for active PRN meds
            with no dose in 90+ days; the existing-backlog cleanup. */}
        <DormantPrnSweep
          suggestions={data.dormantPrn}
          dismissed={data.dismissedDormantPrn}
        />
      </div>

      {/* 6a. OTC quick-add (#843) — the common case (an OTC PRN med) in ~three fields:
          name → label-default prefill → confirm. Creates the SAME intake_items row the
          full form does. The full form below stays the long-tail path. */}
      <div className="card mt-6">
        <h2 className="mb-1 font-semibold text-slate-800 dark:text-slate-100">
          Quick add (OTC)
        </h2>
        <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
          For an over-the-counter med like ibuprofen — pick the name and
          confirm. Use the full form below for prescriptions, schedules, and
          prescriber details.
        </p>
        <QuickAddMedication action={addSupplement} pediatric={data.pediatric} />
      </div>

      {/* 6b. Add medication — the med-specific form (med-aware combobox).
          Supplements are added on the Nutrition → Supplements tab. */}
      <div className="card mt-6">
        <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
          Add medication
        </h2>
        <MedicationForm
          action={addSupplement}
          allSupplements={data.allSupplements}
          stackItems={data.stackItems}
          pgxVariants={data.pgxVariants}
          trainingRestricted={data.trainingRestricted}
          pediatric={data.pediatric}
          age={data.age}
        />
      </div>
    </div>
  );
}
