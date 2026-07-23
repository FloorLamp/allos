import Link from "next/link";
import { today } from "@/lib/db";
import { EmptyState } from "@/components/ui";
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
  substanceDef,
} from "@/lib/substance-use";
import type { SubstanceInstrument } from "@/lib/substance-use";
import {
  getAllSubstanceWeekStates,
  getSubstanceWeeklyTrend,
} from "@/lib/queries";
import { getSmokingHistory } from "@/lib/settings";
import { resolveSmoking, smokingStatusLabel } from "@/lib/smoking";
import SubstanceInstrumentsForm from "@/app/(app)/medical/substance-use/SubstanceInstrumentsForm";
import ConsumptionSection from "@/app/(app)/medical/substance-use/ConsumptionSection";

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
  initialInstrument,
}: {
  profileId: number;
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
        <SubstanceInstrumentsForm
          defaultDate={td}
          initialInstrument={initialInstrument}
        />
        <div data-testid="substance-history">
          {readings.length === 0 ? (
            <EmptyState message="No screening scores yet. Answer the AUDIT-C or DAST-10 above, or enter a total from elsewhere." />
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

      {/* Consumption + reduction target, one section per tracked substance
          (#1078): alcohol on the shared food-log ledger, nicotine/cannabis on
          the dedicated substance_log ledger — same one-tap log/undo, weekly cap,
          calm progress line, and trailing trend, all through the ONE dispatched
          computation the coaching finding also reads. */}
      {weeks.map((week) => {
        const def = substanceDef(week.substance);
        const trend = trends.get(week.substance) ?? [];
        const maxTrend = Math.max(1, ...trend.map((w) => w.count));
        return (
          <section className="space-y-3" key={week.substance}>
            <h2 className="text-sm font-semibold text-slate-600 dark:text-slate-300">
              {def.label} intake
            </h2>
            <p
              className="text-sm"
              data-testid={`substance-week-count-${week.substance}`}
            >
              <span className="font-semibold">{week.count}</span>{" "}
              {week.count === 1 ? def.countSingular : def.countPlural} logged
              this week.
            </p>
            {week.status ? (
              <p
                className="text-sm"
                data-testid={`substance-cap-progress-${week.substance}`}
              >
                {capProgressLine(week.status, week.substance)}
              </p>
            ) : null}
            <ConsumptionSection
              substance={week.substance}
              weekCount={week.count}
              capSet={week.target != null}
              cap={week.target?.cap ?? null}
            />
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {def.unitNote}
            </p>

            {/* Trailing weekly trend — a calm bar list, oldest first. */}
            <div
              className="space-y-1"
              data-testid={`substance-trend-${week.substance}`}
            >
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
        );
      })}

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
