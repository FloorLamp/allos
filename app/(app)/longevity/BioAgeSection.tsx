import Link from "next/link";
import { IconActivityHeartbeat } from "@tabler/icons-react";
import { requireSession } from "@/lib/auth";
import { isTrainingRestricted } from "@/lib/age-gate";
import { getUserAge, getDisplayFormatPrefs } from "@/lib/settings";
import { getBioAgeReadings } from "@/lib/queries";
import {
  bioAgeDelta,
  bioAgeDeltaPhrase,
  bioAgeEffectLabel,
  bioAgeEffectPhrase,
  bioAgeSurface,
  inputCompleteness,
  isBioAgeAgeInput,
  isBioAgeHiddenForAge,
  paceOfAging,
  paceOfAgingPhrase,
  phenoAgeReferenceBasisLabel,
  censoredInputNote,
  type BioAgeDirection,
} from "@/lib/bio-age";
import { formatLongDate } from "@/lib/format-date";
import { readingDetailHref } from "@/lib/hrefs";
import PhoneFold from "@/components/PhoneFold";

// Longevity §1 — the biological-age HERO (#209, #1042 phase 4, split by #2367).
//
// Biological age IS a longevity index, so the headline result lives here, beside the
// other pillars that give it context, and it renders on exactly ONE page. The part of
// the old shared hero that was about the biomarker CATALOG rather than about longevity
// — the missing-inputs checklist and its import CTA — moved to Results › Biomarkers
// (app/(app)/results/BioAgeInputsCard.tsx), which is where those analytes are added.
// So this section now follows ordinary pillar-membership rules: no complete draw, no
// section. The computation is untouched and unforked — both surfaces still read the
// ONE bioAgeSurface decision (lib/bio-age.ts) over the ONE getBioAgeReadings gather.
//
// ADULT-GATED exactly as the computation is: hidden for child profiles (PhenoAge is
// an adult population model).
//
// PHONE FOLD (#1578): the headline — the number, the delta, the pace — is the answer.
// The per-input list below it is ten more lines, which at 390px is most of the card's
// height, so below `sm` it folds behind a toggle; from `sm` up it renders inline. The
// ESTIMATE CAVEAT never folds: it qualifies the number itself, so it has to travel
// with it at every width.

// Delta colour by direction — younger is the good direction.
const DELTA_CLASS: Record<BioAgeDirection, string> = {
  younger: "text-emerald-600 dark:text-emerald-400",
  older: "text-amber-600 dark:text-amber-400",
  even: "text-slate-600 dark:text-slate-300",
};

// The estimate caveat. Names the model, its validated adult population, and that it
// moves with the inputs (never a verdict). A per-input breakdown makes the number feel
// more precise than it is, which is exactly why this sentence sits under it.
function EstimateNote() {
  return (
    <p
      className="mt-4 border-t border-black/5 pt-3 text-xs leading-relaxed text-slate-500 dark:border-white/10 dark:text-slate-400"
      data-testid="bio-age-estimate"
    >
      An <strong>estimate</strong> from the Levine PhenoAge model (2018), an
      NHANES-validated index for adults (~20–84). It moves with the nine
      analytes below plus your chronological age, and is a population-level
      signal, not a precise verdict — discuss anything concerning with a
      clinician.
    </p>
  );
}

export default async function BioAgeSection() {
  const { login, profile } = await requireSession();
  const formatPrefs = getDisplayFormatPrefs(login.id);
  const age = getUserAge(profile.id);
  const hiddenForProfile =
    isBioAgeHiddenForAge(age) || isTrainingRestricted(profile.id);
  const { draws, presentInputs } = getBioAgeReadings(profile.id);
  const surface = bioAgeSurface(
    hiddenForProfile,
    draws.length,
    inputCompleteness(presentInputs).presentCount
  );
  // Only the HERO state renders here now (#2367): the checklist state's home is the
  // page that lets you act on it.
  if (surface !== "hero") return null;

  // Latest draw drives the value, the delta and the per-input effects; the full
  // complete-draw series drives the pace trend.
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
  const censoredNote = censoredInputNote(latest);
  const effects = latest.effects ?? [];

  return (
    <section
      id="bio-age"
      data-testid="longevity-bio-age"
      className="scroll-mt-20"
    >
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

        {/* Censored input (#2334). A component reported beyond its detection limit
            ("<0.2") is substituted AT that limit — the app's convention everywhere —
            but a chart can show that with a hollow dot and this headline number
            cannot, so the caveat is said in words. Never folds: like the estimate
            note, it qualifies the number itself. */}
        {censoredNote && (
          <p
            className="mt-2 text-xs text-slate-500 dark:text-slate-400"
            data-testid="bio-age-censored"
          >
            {censoredNote}
          </p>
        )}

        {/* What moves the number (#2366). The provenance list the hero used to show
            answered "which analytes is this built from"; this answers the question the
            reader actually has — which of them is moving it, and by how much — while
            still naming every input, its value, and a link to its own series, so the
            claim stays checkable against a row you can open. */}
        <PhoneFold
          testId="bio-age-inputs-fold"
          showLabel={`Show what moves it (${effects.length} inputs)`}
          hideLabel="Hide inputs"
          folded={
            <div className="mt-4">
              <h3 className="mb-1 section-label">What moves this number</h3>
              <p className="mb-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                Each line re-runs the whole model with that one input moved to a
                reference value and nothing else changed, ranked by how many
                years it shifts the result. Chronological age is one of the ten
                inputs and is usually the largest. These are properties of the
                model — not predictions about you, and not a plan.
              </p>
              <ul className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
                {effects.map((e) => {
                  const label = bioAgeEffectLabel(e);
                  return (
                    <li
                      key={e.key}
                      className="min-w-0 text-sm"
                      data-testid="bio-age-input"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        {isBioAgeAgeInput(e) ? (
                          <span className="truncate text-slate-700 dark:text-slate-200">
                            {e.name}
                          </span>
                        ) : (
                          <Link
                            href={readingDetailHref(e.name)}
                            className="truncate text-brand-700 hover:underline dark:text-brand-400"
                          >
                            {e.name}
                          </Link>
                        )}
                        <span
                          className="shrink-0 tabular-nums font-medium text-slate-700 dark:text-slate-200"
                          data-testid="bio-age-effect"
                          title={bioAgeEffectPhrase(e)}
                        >
                          {label ?? "no comparison"}
                        </span>
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        {/* A censored component keeps its marker here too — the list
                            shows what the lab reported, never a laundered exact
                            value — and the comparison beside it rests on that same
                            substituted limit. */}
                        <span className="tabular-nums">
                          {e.bound ?? ""}
                          {e.value}
                          {e.unit ? ` ${e.unit}` : ""}
                        </span>
                        {e.reference ? (
                          <>
                            {" · vs "}
                            <span className="tabular-nums">
                              {Math.round(e.reference.value * 10) / 10}
                              {e.unit ? ` ${e.unit}` : ""}
                            </span>
                            {` (${phenoAgeReferenceBasisLabel(e.reference)})`}
                          </>
                        ) : (
                          " · no curated reference value"
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          }
        />

        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
          As of {formatLongDate(latest.date, formatPrefs)}
        </p>

        <EstimateNote />
      </section>
    </section>
  );
}
