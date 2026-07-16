import Link from "next/link";
import { notFound } from "next/navigation";
import { IconArrowLeft } from "@tabler/icons-react";
import { requireSession } from "@/lib/auth";
import { getProviderNames, getPrnAdministrationHistory } from "@/lib/queries";
import { shiftDateStr } from "@/lib/date";
import { formatGivenAtClock } from "@/lib/administration-format";
import { MEDICATIONS_HREF } from "@/lib/hrefs";
import { PageHeader } from "@/components/ui";
import ProviderDatalist from "@/components/ProviderDatalist";
import { loadMedicationsData } from "../med-data";
import MedicationCard from "../MedicationCard";

export const dynamic = "force-dynamic";

// The medication clinical-record detail page (#817) — the home for one med's whole
// lifecycle (course timeline, side effects, administration/adherence history,
// interaction + food guidance, refill/supply, "what is this" explainer, prescriber/
// pharmacy/Rx, edit/stop/restart). Reuses the rich MedicationCard as its body
// (detailView opens the History disclosure). Scoped: a med not owned by the active
// profile (or a supplement/foreign id) isn't in the loader's medication set, so the
// page 404s — the encounters/[id] precedent.
export default async function MedicationDetailPage(props: {
  params: Promise<{ id: string }>;
}) {
  const params = await props.params;
  const { profile } = await requireSession();
  const id = Number(params.id);
  const data = loadMedicationsData(profile.id);
  const m = id ? data.byId.get(id) : undefined;
  if (!m) notFound();

  // Past PRN administration history for the med's own page (#851 item 13), grouped by
  // day and formatted in the profile's timezone — the "how often last month" roll-up
  // the card alone (today-only) can't answer. Empty for a scheduled medication.
  const prnHistory: { date: string; times: string[] }[] = [];
  if (m.med.as_needed === 1) {
    const since = shiftDateStr(data.todayStr, -30);
    const byDate = new Map<string, string[]>();
    for (const a of getPrnAdministrationHistory(profile.id, m.med.id, since)) {
      const arr = byDate.get(a.date) ?? [];
      arr.push(formatGivenAtClock(data.tz, a.given_at ?? a.taken_at));
      byDate.set(a.date, arr);
    }
    for (const [date, times] of byDate) prnHistory.push({ date, times });
  }

  return (
    <div data-testid="medication-detail">
      <ProviderDatalist names={getProviderNames()} />
      <Link
        href={MEDICATIONS_HREF}
        className="mb-2 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-brand-600 dark:text-slate-400 dark:hover:text-brand-400"
      >
        <IconArrowLeft className="h-4 w-4" />
        Back to medications
      </Link>
      <PageHeader
        title={m.med.name}
        subtitle={[m.med.brand, m.med.product].filter(Boolean).join(" · ")}
      />
      <MedicationCard
        supplement={m.med}
        doses={m.doses}
        allSupplements={data.allSupplements}
        stackItems={data.stackItems}
        pgxVariants={data.pgxVariants}
        pairs={m.pairs}
        takenDoseIds={data.taken}
        skippedDoseIds={data.skipped}
        due={m.due}
        courses={m.courses}
        sideEffects={m.sideEffects}
        strip={m.strip}
        refillRate={m.refillRate}
        todayStr={data.todayStr}
        trainingRestricted={data.trainingRestricted}
        suppressedFoodKeys={data.suppressedFoodKeys}
        prnDayLabel={m.prnDayLabel}
        prnAdministrations={m.prnAdministrations}
        prnHistory={prnHistory}
        prnRedoseLine={m.prnRedoseLine}
        pediatric={data.pediatric}
        age={data.age}
        detailView
      />
      <p className="mt-4 text-xs text-slate-500 dark:text-slate-400">
        Informational only, not medical advice.
      </p>
    </div>
  );
}
