import Link from "next/link";
import { today } from "@/lib/db";
import { EmptyState } from "@/components/ui";
import { Notice } from "@/components/Notice";
import { biomarkerViewHref } from "@/lib/hrefs";
import { getResolvedCrisisResources } from "@/lib/settings";
import CrisisResources from "@/components/CrisisResources";
import {
  getInstrumentReadings,
  getInstrumentStates,
} from "@/lib/instrument-records";
import type { Instrument } from "@/lib/mental-health";
import InstrumentsView from "@/app/(app)/medical/instruments/InstrumentsView";

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

      <InstrumentsView defaultDate={td} initialInstrument={initialInstrument} />

      {/* History + trend */}
      <section className="space-y-3" data-testid="instrument-history">
        <h2 className="text-sm font-semibold text-slate-600 dark:text-slate-300">
          History
        </h2>
        {readings.length === 0 ? (
          <EmptyState message="No instrument scores yet. Answer a questionnaire above, or enter a score from a clinician." />
        ) : (
          <ul className="space-y-2">
            {readings.map((r) => (
              <li
                key={r.id}
                data-testid={`instrument-reading-${r.id}`}
                className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg border border-black/5 px-3 py-2 text-sm dark:border-white/5"
              >
                <span>
                  <Link
                    href={biomarkerViewHref(r.instrument)}
                    className="font-medium text-brand-600 hover:underline dark:text-brand-400"
                  >
                    {r.instrument}
                  </Link>{" "}
                  <span className="text-slate-500 dark:text-slate-400">
                    {r.date}
                  </span>
                </span>
                <span>
                  <span className="font-semibold">{r.total}</span> ·{" "}
                  <span data-testid={`instrument-reading-band-${r.id}`}>
                    {r.band.label}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
