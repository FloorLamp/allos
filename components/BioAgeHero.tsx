import Link from "next/link";
import { IconActivityHeartbeat, IconCircleCheck } from "@tabler/icons-react";
import { requireSession } from "@/lib/auth";
import { isTrainingRestricted } from "@/lib/age-gate";
import { getUserAge } from "@/lib/settings";
import { getBioAgeReadings } from "@/lib/queries";
import {
  bioAgeDelta,
  bioAgeDeltaPhrase,
  paceOfAging,
  paceOfAgingPhrase,
  inputCompleteness,
  completenessChecklistMessage,
  isBioAgeHiddenForAge,
  PHENOAGE_INPUT_NAMES,
  type BioAgeDirection,
} from "@/lib/bio-age";
import { formatLongDate } from "@/lib/format-date";
import { biomarkerViewHref } from "@/lib/hrefs";

// The biological-age hero (issue #209). Surfaces the derived PhenoAge index (#157)
// as a headline "how am I aging" result rather than a buried table row: the
// estimated biological age, its delta to chronological age (younger = good), the
// pace-of-aging trend, and the nine inputs that drive it — or, when the panel is
// incomplete, a checklist import CTA. The derived table row stays too (consistency);
// this is the primary surface.
//
// ADULT-GATED exactly as the computation is: hidden for child profiles (PhenoAge is
// an adult population model). Self-contained so it drops in above the Biomarkers
// table with no props.

const BIOMARKER_VIEW = (name: string) => biomarkerViewHref(name);

// Delta colour by direction — younger is the good direction.
const DELTA_CLASS: Record<BioAgeDirection, string> = {
  younger: "text-emerald-600 dark:text-emerald-400",
  older: "text-amber-600 dark:text-amber-400",
  even: "text-slate-600 dark:text-slate-300",
};

// The estimate caveat — every rendered state carries it. Names the model, its
// validated adult population, and that it moves with the inputs (never a verdict).
function EstimateNote() {
  return (
    <p
      className="mt-4 border-t border-black/5 pt-3 text-xs leading-relaxed text-slate-500 dark:border-white/10 dark:text-slate-400"
      data-testid="bio-age-estimate"
    >
      An <strong>estimate</strong> from the Levine PhenoAge model (2018), an
      NHANES-validated index for adults (~20–84). It moves with the nine inputs
      below and is a population-level signal, not a precise verdict — discuss
      anything concerning with a clinician.
    </p>
  );
}

export default async function BioAgeHero() {
  const { profile } = await requireSession();

  // Adult gate — hidden for child profiles, mirroring the computation's floor
  // (and the fitness age-gate as a defensive belt-and-suspenders).
  const age = getUserAge(profile.id);
  if (isBioAgeHiddenForAge(age) || isTrainingRestricted(profile.id))
    return null;

  const { draws, presentInputs } = getBioAgeReadings(profile.id);
  const completeness = inputCompleteness(presentInputs);

  // No complete draw: show the partial-panel checklist CTA — but only when the
  // profile has at least one of the nine inputs (otherwise the card would be pure
  // noise on a labs-empty profile; the page's own empty state covers that case).
  if (draws.length === 0) {
    if (completeness.presentCount === 0) return null;
    return (
      <section
        data-testid="bio-age-hero"
        className="card mb-6 border-brand-100 dark:border-brand-950"
      >
        <div className="flex items-start gap-3">
          <IconActivityHeartbeat className="mt-0.5 h-6 w-6 shrink-0 text-brand-500" />
          <div className="min-w-0">
            <h2 className="font-semibold text-slate-800 dark:text-slate-100">
              Biological age
            </h2>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
              {completenessChecklistMessage(completeness)}
            </p>
          </div>
        </div>

        <ul className="mt-4 grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-3">
          {PHENOAGE_INPUT_NAMES.map((name) => {
            const have = completeness.present.includes(name);
            return (
              <li
                key={name}
                className="flex items-center gap-2 text-sm"
                data-testid="bio-age-input"
              >
                {have ? (
                  <IconCircleCheck className="h-4 w-4 shrink-0 text-emerald-500" />
                ) : (
                  <span className="h-4 w-4 shrink-0 rounded-full border border-dashed border-slate-300 dark:border-ink-600" />
                )}
                {have ? (
                  <Link
                    href={BIOMARKER_VIEW(name)}
                    className="truncate text-slate-700 hover:underline dark:text-slate-200"
                  >
                    {name}
                  </Link>
                ) : (
                  <span className="truncate text-slate-500 dark:text-slate-400">
                    {name}
                  </span>
                )}
              </li>
            );
          })}
        </ul>

        <div className="mt-4">
          <Link
            href="/data"
            className="inline-flex items-center rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-brand-700"
          >
            Import labs
          </Link>
        </div>

        <EstimateNote />
      </section>
    );
  }

  // Complete draw(s): the headline result. Latest draw drives the value + delta;
  // the full complete-draw series drives the pace trend.
  const latest = draws[draws.length - 1];
  // Every complete draw carries a known chronological age (PhenoAge requires it),
  // but guard the type; a null age would have prevented computation.
  const chrono = latest.chronoAge ?? age ?? 0;
  const delta = bioAgeDelta(latest.bioAge, chrono);
  const pace = paceOfAging(
    draws
      .filter((d) => d.chronoAge != null)
      .map((d) => ({
        date: d.date,
        bioAge: d.bioAge,
        chronoAge: d.chronoAge as number,
      }))
  );
  const paceText = paceOfAgingPhrase(pace);

  return (
    <section
      data-testid="bio-age-hero"
      className="card mb-6 border-brand-100 dark:border-brand-950"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <IconActivityHeartbeat className="mt-1 h-6 w-6 shrink-0 text-brand-500" />
          <div>
            <h2 className="font-semibold text-slate-800 dark:text-slate-100">
              Biological age
            </h2>
            <div className="mt-1 flex items-baseline gap-2">
              <span
                className="text-4xl font-bold tabular-nums text-slate-900 dark:text-white"
                data-testid="bio-age-value"
              >
                {delta.bioAge}
              </span>
              <span className="text-sm text-slate-500 dark:text-slate-400">
                years
              </span>
            </div>
            <p
              className={`mt-1 text-sm font-medium ${DELTA_CLASS[delta.direction]}`}
              data-testid="bio-age-delta"
            >
              {bioAgeDeltaPhrase(delta)}
            </p>
          </div>
        </div>
        <span className="badge bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300">
          Estimate
        </span>
      </div>

      {/* Pace of aging — the delta trend. NO slope until ≥2 complete draws; a single
          draw shows the value with a one-measurement note. */}
      <p
        className="mt-3 text-sm text-slate-600 dark:text-slate-300"
        data-testid="bio-age-pace"
      >
        {paceText ??
          "Based on one measurement — add another complete panel to track your pace of aging."}
      </p>

      {/* The nine inputs it was built from, each linking to its own series (the
          "why", and an honest-uncertainty affordance). */}
      <div className="mt-4">
        <h3 className="mb-2 section-label">Built from</h3>
        <ul className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-3">
          {latest.inputs.map((inp) => (
            <li
              key={inp.name}
              className="flex items-center justify-between gap-2 text-sm"
              data-testid="bio-age-input"
            >
              <Link
                href={BIOMARKER_VIEW(inp.name)}
                className="truncate text-brand-700 hover:underline dark:text-brand-400"
              >
                {inp.name}
              </Link>
              <span className="shrink-0 tabular-nums text-slate-500 dark:text-slate-400">
                {inp.value}
                {inp.unit ? ` ${inp.unit}` : ""}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
        As of {formatLongDate(latest.date)}
      </p>

      <EstimateNote />
    </section>
  );
}
