import Link from "next/link";
import { IconActivityHeartbeat, IconCircleCheck } from "@tabler/icons-react";
import { requireSession } from "@/lib/auth";
import { getDisplayFormatPrefs, getProfileAge } from "@/lib/settings";
import { getBioAgeReadings, type BioAgeDraw } from "@/lib/queries";
import {
  bioAgeDelta,
  bioAgeDeltaPhrase,
  bioAgeEffectLabel,
  bioAgeEffectPhrase,
  bioAgeInputsStatus,
  bioAgeSurface,
  censoredInputNote,
  inputCompleteness,
  isBioAgeAgeInput,
  isBioAgeHiddenForAge,
  paceOfAging,
  paceOfAgingPhrase,
  phenoAgeReferenceBasisLabel,
  PHENOAGE_INPUT_NAMES,
  type BioAgeDirection,
} from "@/lib/bio-age";
import { isLongevityRelevant } from "@/lib/life-stage";
import CardFootnote from "@/components/CardFootnote";
import InfoTooltipIcon from "@/components/InfoTooltipIcon";
import PhoneFold from "@/components/PhoneFold";
import { displayUnit } from "@/lib/display-unit";
import { clinicalResultDetailHref } from "@/lib/hrefs";

// Biological age on Results › Clinical results (#209, #5556): the headline estimate
// once a complete draw exists, and otherwise the checklist of the nine PhenoAge
// analytes with the import CTA. One card, on the page where the analytes are added.
// The status line names which draw the number is from, or why there is none.
//
// ADULT-GATED as the computation is: a known minor sees nothing; an unknown age sees
// the checklist (no estimate) with a prompt to add it.
//
// PHONE FOLD (#1578): the per-input effects fold below `sm`; the estimate caveat
// never folds, because it qualifies the number itself.

// Delta colour by direction — younger is the good direction.
const DELTA_CLASS: Record<BioAgeDirection, string> = {
  younger: "text-emerald-600 dark:text-emerald-400",
  older: "text-amber-600 dark:text-amber-400",
  even: "text-slate-600 dark:text-slate-300",
};

export default async function BioAgeCard() {
  const { login, profile } = await requireSession();
  const age = getProfileAge(profile.id);
  const { draws, presentInputs, panels } = getBioAgeReadings(profile.id);
  const completeness = inputCompleteness(presentInputs);
  const status = bioAgeInputsStatus(
    completeness,
    draws,
    panels,
    getDisplayFormatPrefs(login.id)
  );
  const surface = bioAgeSurface(
    isBioAgeHiddenForAge(age),
    draws.length,
    completeness.presentCount
  );
  // "hidden" covers the age gate AND a labs-empty profile, for which this card would
  // be pure noise (the page's own empty state covers that case).
  if (surface === "hidden") return null;
  const adult = isLongevityRelevant(age);
  const hero = surface === "hero" && adult;
  // The headline reads the latest complete draw; the pace trend reads them all.
  const latest = draws[draws.length - 1];
  const delta = hero
    ? bioAgeDelta(latest.bioAge, latest.chronoAge ?? age)
    : null;
  const paceText = paceOfAgingPhrase(
    paceOfAging(
      draws.flatMap((d) =>
        d.chronoAge == null
          ? []
          : [{ date: d.date, bioAge: d.bioAge, chronoAge: d.chronoAge }]
      )
    )
  );
  const censoredNote = hero ? censoredInputNote(latest) : null;

  return (
    <section
      id="bio-age"
      data-testid="bio-age-inputs-card"
      className="card section-seam mb-6 scroll-mt-20 border-brand-100 dark:border-brand-950"
    >
      <div className="flex items-start gap-3">
        <IconActivityHeartbeat className="mt-0.5 h-6 w-6 shrink-0 text-brand-500" />
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-slate-800 dark:text-slate-100">
            Biological age
          </h2>
          {delta && (
            <div data-testid="bio-age-hero">
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
                <span className="badge bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300">
                  Estimate
                </span>
              </div>
              <p
                className={`mt-1 text-sm font-medium ${DELTA_CLASS[delta.direction]}`}
                data-testid="bio-age-delta"
              >
                {bioAgeDeltaPhrase(delta)}
              </p>
              {/* No slope until ≥2 complete draws. */}
              <p
                className="mt-1 text-sm text-slate-600 dark:text-slate-300"
                data-testid="bio-age-pace"
              >
                {paceText ??
                  "Based on one measurement — add another complete panel to track your pace of aging."}
              </p>
              {/* A component reported beyond its detection limit is substituted AT
                  that limit (#2334); the headline cannot show that, so it is said in
                  words. */}
              {censoredNote && (
                <p
                  className="mt-1 text-xs text-slate-500 dark:text-slate-400"
                  data-testid="bio-age-censored"
                >
                  {censoredNote}
                </p>
              )}
            </div>
          )}
          <p
            className="mt-1 text-sm text-slate-600 dark:text-slate-300"
            data-testid="bio-age-inputs-status"
          >
            {status.message}
          </p>
        </div>
      </div>

      {hero ? (
        <BioAgeEffects draw={latest} />
      ) : (
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
                    href={clinicalResultDetailHref(name)}
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
      )}

      {/* The import CTA follows the STATUS, not the tick count (#3050): nine
          analytes present but never on one draw, or a newer panel that missed by
          one, both leave importing as the whole answer. */}
      {(!adult || status.kind !== "computed") && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {!adult && (
            <Link href="/settings/health" className="btn btn-sm">
              Add your age
            </Link>
          )}
          {status.kind !== "computed" && (
            <Link href="/data" className="btn-ghost btn-sm">
              Import labs
            </Link>
          )}
        </div>
      )}

      {hero ? (
        <CardFootnote data-testid="bio-age-estimate">
          An <strong>estimate</strong> from the Levine PhenoAge model (2018), an
          NHANES-validated index for adults (~20–84). It moves with the nine
          analytes above plus your chronological age, and is a population-level
          signal, not a precise verdict — discuss anything concerning with a
          clinician.
        </CardFootnote>
      ) : (
        <CardFootnote>
          The Levine PhenoAge model (2018) needs all nine of these analytes from
          one draw, plus your age.
        </CardFootnote>
      )}
    </section>
  );
}

// What moves the number (#2366): every input, its value, a link to its series, and
// how many years moving it to a reference value shifts the result.
function BioAgeEffects({ draw }: { draw: BioAgeDraw }) {
  const { effects } = draw;
  return (
    <PhoneFold
      testId="bio-age-inputs-fold"
      showLabel={`Show what moves it (${effects.length} inputs)`}
      hideLabel="Hide inputs"
      folded={
        <div className="mt-4">
          <h3 className="mb-1 section-label">What moves this number</h3>
          <p className="mb-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            Each line re-runs the whole model with that one input moved to a
            reference value and nothing else changed, ranked by how many years
            it shifts the result. Chronological age is one of the ten inputs and
            is usually the largest. These are properties of the model — not
            predictions about you, and not a plan.
          </p>
          <ul className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
            {effects.map((e) => {
              const label = bioAgeEffectLabel(e);
              const shownUnit = displayUnit(e.unit);
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
                        href={clinicalResultDetailHref(e.name)}
                        className="truncate text-brand-700 hover:underline dark:text-brand-400"
                      >
                        {e.name}
                      </Link>
                    )}
                    <span className="inline-flex shrink-0 items-center tabular-nums font-medium text-slate-700 dark:text-slate-200">
                      <span data-testid="bio-age-effect">
                        {label ?? "no comparison"}
                      </span>
                      <InfoTooltipIcon label={bioAgeEffectPhrase(e)} />
                    </span>
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    {/* A censored component keeps its marker: the list shows what
                        the lab reported, never a laundered exact value. */}
                    <span className="tabular-nums">
                      {e.bound ?? ""}
                      {e.value}
                      {shownUnit ? ` ${shownUnit}` : ""}
                    </span>
                    {e.reference ? (
                      <>
                        {" · vs "}
                        <span className="tabular-nums">
                          {Math.round(e.reference.value * 10) / 10}
                          {shownUnit ? ` ${shownUnit}` : ""}
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
  );
}
