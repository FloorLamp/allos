import Link from "next/link";
import { IconActivityHeartbeat, IconCircleCheck } from "@tabler/icons-react";
import { requireSession } from "@/lib/auth";
import { isTrainingRestricted } from "@/lib/age-gate";
import { getUserAge } from "@/lib/settings";
import { getBioAgeReadings } from "@/lib/queries";
import {
  bioAgeSurface,
  completenessChecklistMessage,
  inputCompleteness,
  isBioAgeHiddenForAge,
  PHENOAGE_INPUT_NAMES,
} from "@/lib/bio-age";
import { pillarHref } from "@/lib/longevity-pillars";
import { readingDetailHref } from "@/lib/hrefs";

// The bio-age INPUT PANEL on Results › Biomarkers (#2367).
//
// The hero used to render here AND on Longevity, so a reader moving between the two
// pages met the same headline block twice. The split is by what each page lets you
// DO: biological age is a longevity index, so the number, the delta, the pace and the
// per-input effects live on /longevity; what stays here is the part of the old hero
// that was about the biomarker CATALOG — which of the nine analytes you have, which
// you still need, and the import CTA — because this is the page where those analytes
// are added. Stranding that CTA on a page the reader visits less often would make
// bio-age harder to earn, not tidier.
//
// No computation is forked to achieve it: the render decision is the same
// bioAgeSurface call (lib/bio-age.ts) over the same getBioAgeReadings gather the
// Longevity section makes, and this card shows no estimate of its own.
export default async function BioAgeInputsCard() {
  const { profile } = await requireSession();

  // Adult gate — hidden for child profiles, mirroring the computation's floor (and
  // the fitness age-gate as a defensive belt-and-suspenders).
  const age = getUserAge(profile.id);
  const hiddenForProfile =
    isBioAgeHiddenForAge(age) || isTrainingRestricted(profile.id);

  const { draws, presentInputs } = getBioAgeReadings(profile.id);
  const completeness = inputCompleteness(presentInputs);
  const surface = bioAgeSurface(
    hiddenForProfile,
    draws.length,
    completeness.presentCount
  );
  // "hidden" covers the age gate AND a labs-empty profile, for which this card would
  // be pure noise (the page's own empty state covers that case). Both the checklist
  // and the hero state render the panel here — with a complete panel the useful thing
  // to say is that it IS complete, and where the result lives.
  if (surface === "hidden") return null;

  return (
    <section
      data-testid="bio-age-inputs-card"
      className="card mb-6 border-brand-100 dark:border-brand-950"
    >
      <div className="flex items-start gap-3">
        <IconActivityHeartbeat className="mt-0.5 h-6 w-6 shrink-0 text-brand-500" />
        <div className="min-w-0">
          <h2 className="font-semibold text-slate-800 dark:text-slate-100">
            Biological-age inputs
          </h2>
          <p
            className="mt-1 text-sm text-slate-600 dark:text-slate-300"
            data-testid="bio-age-inputs-status"
          >
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
                  href={readingDetailHref(name)}
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

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {/* The door to the headline result, wherever the panel stands: a partial
            panel has a section to land on once it completes, and a complete one has a
            number waiting there now. The href is pillarHref's, so this link and the
            dashboard pillar card can never point at different anchors. */}
        <Link
          href={pillarHref("bio-age")}
          className="btn btn-sm"
          data-testid="bio-age-hero-link"
        >
          See biological age
        </Link>
        {!completeness.complete && (
          <Link href="/data" className="btn-ghost btn-sm">
            Import labs
          </Link>
        )}
      </div>

      <p className="mt-4 border-t border-black/5 pt-3 text-xs leading-relaxed text-slate-500 dark:border-white/10 dark:text-slate-400">
        The Levine PhenoAge model (2018) needs all nine of these analytes from
        one draw, plus your age.
      </p>
    </section>
  );
}
