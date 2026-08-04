import Link from "next/link";
import { today } from "@/lib/db";
import { Notice } from "@/components/Notice";
import { readingDetailHref } from "@/lib/hrefs";
import { getResolvedCrisisResources } from "@/lib/settings";
import CrisisResources from "@/components/CrisisResources";
import {
  getInstrumentReadings,
  getInstrumentStates,
} from "@/lib/instrument-records";
import type { Instrument } from "@/lib/mental-health";
import { instrumentDef } from "@/lib/mental-health";
import InstrumentsView from "@/app/(app)/medical/instruments/InstrumentsView";
import InstrumentHistoryList from "@/app/(app)/medical/instruments/InstrumentHistoryList";
import AddEntryPanel from "@/components/AddEntryPanel";
import {
  updateInstrumentAction,
  deleteInstrumentAction,
} from "@/app/(app)/medical/instruments/actions";

// The mental-health instrument surface (issue #716), former /medical/instruments,
// now the #mental-health section of /records (#1042 final tail). Tracks validated
// screening instruments — PHQ-9 (depression), GAD-7 (anxiety) — as numeric, severity-
// banded scores (the app's measurement DNA), NOT a mood diary. Administer in-app or
// enter an outside score; each score trends like a biomarker. A SEVERE score or a
// positive PHQ-9 item 9 shows a NON-DISMISSIBLE crisis-resources line + a discuss-
// with-a-clinician note. Informational, never diagnostic — a screening instrument,
// not a diagnosis.
//
// The in-app instrument flow is the ONLY creation path for this domain, and the
// safety contract is content, not route (#1042): the crisis line travels WITH this
// section. So the section renders unconditionally (its former nav leaf was ungated) —
// the crisis line is thus always reachable whenever there is a signal to show it.
// Server Actions + client component stayed in app/(app)/medical/instruments/.
export default function MentalHealthSection({
  profileId,
  isAdmin,
  initialInstrument,
}: {
  profileId: number;
  isAdmin: boolean;
  // Deep-link preselect (#1083) forwarded to the instrument form.
  initialInstrument?: Instrument;
}) {
  const td = today(profileId);
  const readings = getInstrumentReadings(profileId);
  const states = getInstrumentStates(profileId);
  const escalating = states.filter((s) => s.crisis?.escalate && s.latest);
  // Configured crisis resources for THIS profile (override > global > neutral
  // fallback, #996) — resolved from the profile's own settings, never egressed.
  const crisisResources = getResolvedCrisisResources(profileId);

  return (
    <div className="space-y-6">
      {/* Non-dismissible crisis-resources line (#716). Rendered structurally OUTSIDE the
          dismissal bus — the same standing as a safety dose reminder — so it can never be
          hidden. Shown whenever the latest PHQ-9/GAD-7 is severe or PHQ-9 item 9 is
          positive. Informational framing, never a diagnosis. */}
      {escalating.length > 0 ? (
        <Notice
          tone="rose"
          testid="instrument-crisis-line"
          title="Your recent results suggest reaching out for support"
        >
          <CrisisResources resources={crisisResources} isAdmin={isAdmin} />
        </Notice>
      ) : null}

      {/* Explicit user affordance (#996): a calm, always-present link to the crisis-
          resources surface — a deliberate tap, never auto-surfaced, never a trend. */}
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Need support now?{" "}
        <Link
          href="/crisis-resources"
          className="text-brand-600 hover:underline dark:text-brand-400"
          data-testid="instrument-crisis-support-link"
        >
          Crisis resources
        </Link>
      </p>

      {/* History + trend */}
      <section className="space-y-3" data-testid="instrument-history">
        <h2 className="text-sm font-semibold text-slate-600 dark:text-slate-300">
          History
        </h2>
        {/* Per-row correct/remove (#1396): a screening score used to be create-only,
            so a fat-fingered outside total permanently distorted the trend and could
            permanently trip the non-dismissible crisis line above. Correcting the row
            releases that line by construction — the banner and this list read the ONE
            computation over the same stored rows. */}
        <InstrumentHistoryList
          testidPrefix="instrument"
          emptyMessage="No instrument scores yet. Answer a questionnaire above, or enter a score from a clinician."
          updateAction={updateInstrumentAction}
          deleteAction={deleteInstrumentAction}
          rows={readings.map((r) => ({
            id: r.id,
            instrument: r.instrument,
            date: r.date,
            total: r.total,
            bandLabel: r.band.label,
            maxTotal: instrumentDef(r.instrument).maxTotal,
            href: readingDetailHref(r.instrument),
            documentId: r.documentId,
          }))}
        />
      </section>

      <AddEntryPanel
        testId="add-mental-health-screening-panel"
        panelId="add-mental-health-screening-panel-body"
        label="Add screening"
        defaultOpen={!!initialInstrument}
        presentation="modal"
      >
        <InstrumentsView
          defaultDate={td}
          initialInstrument={initialInstrument}
        />
      </AddEntryPanel>
    </div>
  );
}
