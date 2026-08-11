import Link from "next/link";
import { today } from "@/lib/db";
import { Notice } from "@/components/Notice";
import { readingDetailHref } from "@/lib/hrefs";
import {
  getSubstanceInstrumentReadings,
  type SubstanceInstrumentReading,
} from "@/lib/instrument-records";
import {
  SUBSTANCE_INSTRUMENTS,
  shouldSuggestClinicianDiscussion,
  capProgressLine,
  substanceInstrumentDef,
} from "@/lib/substance-use";
import type { SubstanceInstrument } from "@/lib/substance-use";
import {
  getAllSubstanceWeekStates,
  getSubstanceDailyTotals,
  getSubstanceWeeklyTrend,
} from "@/lib/queries";
import { getSmokingHistory } from "@/lib/settings";
import type { DisplayFormatPrefs } from "@/lib/format-date";
import { resolveSmoking, smokingStatusLabel } from "@/lib/smoking";
import SubstanceInstrumentsForm from "@/app/(app)/medical/substance-use/SubstanceInstrumentsForm";
import ConsumptionSection from "@/app/(app)/medical/substance-use/ConsumptionSection";
import InstrumentHistoryList from "@/app/(app)/medical/instruments/InstrumentHistoryList";
import AddEntryPanel from "@/components/AddEntryPanel";
import {
  updateSubstanceInstrumentAction,
  deleteSubstanceInstrumentAction,
} from "@/app/(app)/medical/substance-use/actions";

// The substance-use surface (issue #998), formerly the standalone
// /medical/substance-use page, now the #substance-use section of Records ›
// Specialty (#1175, the #1042 relocation pattern) sitting beside Mental health:
// screen → track → support reduction. Validated screening instruments (AUDIT-C
// and DAST-10 in-app — the latter since #1085; AUDIT as an outside total) trended
// like biomarkers; per-substance consumption ledgers (#1078: alcohol on the shared
// food-log ledger, nicotine/cannabis on substance_log); user-set weekly reduction
// targets with calm progress. NON-JUDGMENTAL AND NEVER GAMIFIED (product-decided):
// no streaks, no badges, no milestones, no celebratory copy — a harm-reduction
// tracker, not a chip-counter. A high score gets a calm discuss-with-a-clinician
// note, NEVER the crisis surface (#996 is explicit/item-9 only) and never a
// notification. Informational, not medical advice.
//
// Life-stage gated (#1174): its instruments are adult-validated (USPSTF alcohol/
// drug screening is 18+, adolescents use CRAFFT not these), so the whole section
// hides for a KNOWN minor — the gate lives in the section-visibility predicate
// (records/nav.ts + getRecordsSpecialtyRelevance), which drops both this section
// and its jump-link. Mental health, adolescent-validated, stays ungated on
// purpose. The server actions in app/(app)/medical/substance-use/actions.ts stay
// put (route-independent); this is a re-mount, not a rewrite.
export default function SubstanceUseSection({
  profileId,
  formatPrefs,
  initialInstrument,
}: {
  profileId: number;
  // The viewer login's date shape (#964), resolved at the page boundary — the
  // weekly-trend labels render through the shared formatter rather than slicing
  // the ISO string (issue #1448).
  formatPrefs: DisplayFormatPrefs;
  // Deep-link preselect (#1083) forwarded to the instrument form.
  initialInstrument?: SubstanceInstrument;
}) {
  const td = today(profileId);
  const readings = getSubstanceInstrumentReadings(profileId);
  // Per-substance week state + trend (#1078): alcohol / nicotine / cannabis, each
  // dispatched to its own ledger by the ONE query-layer computation.
  const weeks = getAllSubstanceWeekStates(profileId);
  const trends = new Map(
    weeks.map((w) => [
      w.substance,
      getSubstanceWeeklyTrend(profileId, w.substance),
    ])
  );
  const smoking = resolveSmoking(getSmokingHistory(profileId), false);

  // The latest reading per instrument that sits in a discuss-with-a-clinician
  // band — drives the ONE calm note below (never crisis, never a push).
  const discuss = SUBSTANCE_INSTRUMENTS.map((inst) =>
    readings.find((r) => r.instrument === inst)
  ).filter(
    (r): r is SubstanceInstrumentReading =>
      r != null && shouldSuggestClinicianDiscussion(r.instrument, r.total)
  );

  return (
    <div className="space-y-6">
      {/* Calm clinician-discussion note (#998): shown for a latest score in a
          higher band. Deliberately NOT the crisis surface and never a
          notification — informational framing only. */}
      {discuss.length > 0 ? (
        <Notice
          tone="amber"
          testid="substance-clinician-note"
          title="A recent score may be worth discussing with a clinician"
        >
          <p>
            {discuss
              .map(
                (r) =>
                  `${r.instrument} on ${r.date}: ${r.total} (${r.band.label.toLowerCase()})`
              )
              .join(" · ")}
            . A screening score is a conversation starter.
          </p>
        </Notice>
      ) : null}

      {/* Consumption + reduction target, one section per tracked substance
          (#1078): alcohol on the shared food-log ledger, nicotine/cannabis on
          the dedicated substance_log ledger — same one-tap log/undo, weekly cap,
          calm progress line, and trailing trend, all through the ONE dispatched
          computation the coaching finding also reads. */}
      {weeks.map((week) => {
        return (
          <ConsumptionSection
            key={week.substance}
            substance={week.substance}
            weekCount={week.count}
            capSet={week.target != null}
            cap={week.target?.cap ?? null}
            capProgress={
              week.status ? capProgressLine(week.status, week.substance) : null
            }
            capAttention={
              week.status ? week.status.atCap || week.status.over : false
            }
            history={getSubstanceDailyTotals(profileId, week.substance)}
            trend={trends.get(week.substance) ?? []}
            defaultDate={td}
            formatPrefs={formatPrefs}
          />
        );
      })}

      {/* Screening history leads; the questionnaire itself opens only on request. */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-600 dark:text-slate-300">
          Screening
        </h2>
        <div data-testid="substance-history">
          <InstrumentHistoryList
            testidPrefix="substance"
            emptyMessage="No screening scores yet. Add an AUDIT-C or DAST-10 screening, or enter a total from elsewhere."
            updateAction={updateSubstanceInstrumentAction}
            deleteAction={deleteSubstanceInstrumentAction}
            rows={readings.map((r) => ({
              id: r.id,
              instrument: r.instrument,
              date: r.date,
              total: r.total,
              bandLabel: r.band.label,
              maxTotal: substanceInstrumentDef(r.instrument).maxTotal,
              href: readingDetailHref(r.instrument),
              documentId: r.documentId,
            }))}
          />
        </div>
        <AddEntryPanel
          testId="add-substance-screening-panel"
          panelId="add-substance-screening-panel-body"
          label="Add screening"
          defaultOpen={!!initialInstrument}
          presentation="modal"
        >
          <SubstanceInstrumentsForm
            defaultDate={td}
            initialInstrument={initialInstrument}
          />
        </AddEntryPanel>
      </section>

      {/* Tobacco/nicotine STATUS: the existing structured smoking status links in
          as the risk-factor / screening-eligibility source of truth (#83 —
          pack-years drives USPSTF lung/AAA cadence and is NEVER recomputed from
          the nicotine consumption log above; they answer different questions and
          deliberately coexist, #1078). Recorded on Health record → Background. */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-600 dark:text-slate-300">
          Tobacco
        </h2>
        <p className="text-sm" data-testid="substance-smoking-status">
          Smoking status:{" "}
          <span className="font-medium">
            {smokingStatusLabel(smoking.status)}
          </span>
          {smoking.status === "former" && smoking.quitYear != null
            ? ` (quit ${smoking.quitYear})`
            : null}
          {" · "}
          <Link
            href="/records/care/overview"
            className="text-brand-600 hover:underline dark:text-brand-400"
          >
            Update in Background
          </Link>
        </p>
      </section>
    </div>
  );
}
