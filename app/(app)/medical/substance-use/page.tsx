import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import PageContainer from "@/components/PageContainer";
import { PageHeader, EmptyState } from "@/components/ui";
import { Notice } from "@/components/Notice";
import { biomarkerViewHref } from "@/lib/hrefs";
import {
  getSubstanceInstrumentReadings,
  type SubstanceInstrumentReading,
} from "@/lib/instrument-records";
import {
  SUBSTANCE_INSTRUMENTS,
  shouldSuggestClinicianDiscussion,
  capProgressLine,
} from "@/lib/substance-use";
import { getSubstanceWeekState, getAlcoholWeeklyTrend } from "@/lib/queries";
import { getSmokingHistory } from "@/lib/settings";
import { resolveSmoking, smokingStatusLabel } from "@/lib/smoking";
import SubstanceInstrumentsForm from "./SubstanceInstrumentsForm";
import ConsumptionSection from "./ConsumptionSection";

export const dynamic = "force-dynamic";

// The substance-use surface (issue #998), under Medical next to Mental health:
// screen → track → support reduction. Validated screening instruments (AUDIT-C
// in-app; AUDIT / DAST-10 as outside totals) trended like biomarkers; standard-
// drink consumption on the shared food-log ledger; a user-set weekly reduction
// target with calm progress. NON-JUDGMENTAL AND NEVER GAMIFIED (product-decided):
// no streaks, no badges, no milestones, no celebratory copy — a harm-reduction
// tracker, not a chip-counter. A high score gets a calm discuss-with-a-clinician
// note, NEVER the crisis surface (#996 is explicit/item-9 only) and never a
// notification. Informational, not medical advice.

export default async function SubstanceUsePage() {
  const { profile } = await requireSession();
  const td = today(profile.id);
  const readings = getSubstanceInstrumentReadings(profile.id);
  const week = getSubstanceWeekState(profile.id);
  const trend = getAlcoholWeeklyTrend(profile.id);
  const smoking = resolveSmoking(getSmokingHistory(profile.id), false);

  // The latest reading per instrument that sits in a discuss-with-a-clinician
  // band — drives the ONE calm note below (never crisis, never a push).
  const discuss = SUBSTANCE_INSTRUMENTS.map((inst) =>
    readings.find((r) => r.instrument === inst)
  ).filter(
    (r): r is SubstanceInstrumentReading =>
      r != null && shouldSuggestClinicianDiscussion(r.instrument, r.total)
  );

  const maxTrend = Math.max(1, ...trend.map((w) => w.count));

  return (
    <PageContainer width="reading" className="mx-auto space-y-6">
      <PageHeader
        title="Substance use"
        subtitle="Track validated screening scores (AUDIT-C, AUDIT, DAST-10), standard drinks over time, and a reduction target you set yourself. A screening tool, not a diagnosis. Informational, not medical advice."
      />

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
            . A screening score is not a diagnosis — it&rsquo;s a conversation
            starter.
          </p>
        </Notice>
      ) : null}

      {/* Screening instruments */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-600 dark:text-slate-300">
          Screening
        </h2>
        <SubstanceInstrumentsForm defaultDate={td} />
        <div data-testid="substance-history">
          {readings.length === 0 ? (
            <EmptyState message="No screening scores yet. Answer the AUDIT-C above, or enter an AUDIT or DAST-10 total from elsewhere." />
          ) : (
            <ul className="space-y-2">
              {readings.map((r) => (
                <li
                  key={r.id}
                  data-testid={`substance-reading-${r.id}`}
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
                    <span data-testid={`substance-reading-band-${r.id}`}>
                      {r.band.label}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* Consumption + reduction target */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-600 dark:text-slate-300">
          Alcohol intake
        </h2>
        <p className="text-sm" data-testid="substance-week-count">
          <span className="font-semibold">{week.count}</span> standard{" "}
          {week.count === 1 ? "drink" : "drinks"} logged this week.
        </p>
        {week.status ? (
          <p className="text-sm" data-testid="substance-cap-progress">
            {capProgressLine(week.status)}
          </p>
        ) : null}
        <ConsumptionSection
          weekCount={week.count}
          capSet={week.target != null}
          cap={week.target?.cap ?? null}
        />
        <p className="text-xs text-slate-500 dark:text-slate-400">
          One standard drink ≈ 12 oz beer, 5 oz wine, or 1.5 oz spirits. Drinks
          log into the same ledger as Nutrition&rsquo;s alcohol group — logging
          in either place counts once.
        </p>

        {/* Trailing weekly trend — a calm bar list, oldest first. */}
        <div className="space-y-1" data-testid="substance-trend">
          {trend.map((w) => (
            <div key={w.start} className="flex items-center gap-2 text-xs">
              <span className="w-20 shrink-0 text-slate-500 dark:text-slate-400">
                {w.start.slice(5)}
                {w.isCurrent ? " (now)" : ""}
              </span>
              <div className="h-2 flex-1 rounded bg-black/5 dark:bg-white/5">
                <div
                  className="h-2 rounded bg-brand-400/70"
                  style={{ width: `${(w.count / maxTrend) * 100}%` }}
                />
              </div>
              <span className="w-6 text-right tabular-nums">{w.count}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Tobacco/nicotine: the existing structured smoking status links in as the
          risk factor (#83) — recorded on Medical → Background. */}
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
            href="/records#background"
            className="text-brand-600 hover:underline dark:text-brand-400"
          >
            Update in Background
          </Link>
        </p>
      </section>
    </PageContainer>
  );
}
