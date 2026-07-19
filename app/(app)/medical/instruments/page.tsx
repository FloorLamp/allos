import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import PageContainer from "@/components/PageContainer";
import { PageHeader, EmptyState } from "@/components/ui";
import { Notice } from "@/components/Notice";
import { biomarkerViewHref } from "@/lib/hrefs";
import { CRISIS_RESOURCES_LINE } from "@/lib/mental-health";
import {
  getInstrumentReadings,
  getInstrumentStates,
} from "@/lib/instrument-records";
import InstrumentsView from "./InstrumentsView";

export const dynamic = "force-dynamic";

// The mental-health instrument surface (issue #716), under Medical. Tracks validated
// screening instruments — PHQ-9 (depression), GAD-7 (anxiety) — as numeric, severity-
// banded scores (the app's measurement DNA), NOT a mood diary. Administer in-app or enter
// an outside score; each score trends like a biomarker. A SEVERE score or a positive
// PHQ-9 item 9 shows a NON-DISMISSIBLE crisis-resources line + a discuss-with-a-clinician
// note. Informational, never diagnostic — a screening instrument, not a diagnosis.

export default async function InstrumentsPage() {
  const { profile } = await requireSession();
  const td = today(profile.id);
  const readings = getInstrumentReadings(profile.id);
  const states = getInstrumentStates(profile.id);
  const escalating = states.filter((s) => s.crisis?.escalate && s.latest);

  return (
    <PageContainer width="reading" className="mx-auto space-y-6">
      <PageHeader
        title="Mental health"
        subtitle="Track validated screening instruments — PHQ-9 and GAD-7 — as severity-banded scores over time. A screening tool, not a diagnosis. Informational, not medical advice."
      />

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
          {CRISIS_RESOURCES_LINE}
        </Notice>
      ) : null}

      <InstrumentsView defaultDate={td} />

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
    </PageContainer>
  );
}
