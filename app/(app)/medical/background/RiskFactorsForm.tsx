"use client";

import { useState } from "react";
import { saveRiskFactors } from "./actions";
import SaveStatus from "@/components/SaveStatus";
import { useSaveStatus } from "@/components/useSaveStatus";
import type { RiskAttributes } from "@/lib/risk-stratification";

// Health risk factors (issue #517) — the self-declared occupational / immune
// context the risk-stratification layer reads to bring some retests & screenings
// due sooner and rank them higher (e.g. a healthcare worker's hepatitis-A immunity
// check). A PROFILE-scoped property of the tracked person, following the active
// profile like smoking history. Informational only — not medical advice.

const FIELDS: {
  key: keyof RiskAttributes;
  name: string;
  label: string;
  hint: string;
}[] = [
  {
    key: "healthcareWorker",
    name: "healthcare_worker",
    label: "Healthcare worker",
    hint: "Occupational exposure — more frequent hepatitis-A/B immunity checks.",
  },
  {
    key: "immunocompromised",
    name: "immunocompromised",
    label: "Immunocompromised",
    hint: "Weakened immunity — immunity to vaccine-preventable illness is checked sooner.",
  },
  {
    key: "dialysis",
    name: "dialysis",
    label: "On dialysis",
    hint: "Kidney-function and hepatitis immunity monitored more closely.",
  },
  {
    key: "pregnant",
    name: "pregnant",
    label: "Pregnant",
    // Pregnancy rules now ship (#521): glucose (gestational-diabetes screening)
    // and CBC/ferritin (anemia screening) are retested sooner and ranked up. The
    // hint describes that real behavior now that RISK_RULES backs it.
    hint: "Gestational-diabetes (glucose) and anemia (CBC/ferritin) checks are brought due sooner and prioritized.",
  },
  {
    // Noise exposure (#717) — occupational/recreational loud noise (loud workplace,
    // firearms, power tools, concerts). Brings the age-related hearing screening due
    // sooner (NIOSH/CDC).
    key: "noiseExposure",
    name: "noise_exposure",
    label: "Loud-noise exposure",
    hint: "Loud workplace, firearms, power tools, or concerts — hearing screening is brought due sooner.",
  },
];

export default function RiskFactorsForm({
  attributes,
  reviewed: reviewedInitial,
}: {
  attributes: RiskAttributes;
  // Whether this profile has ever REVIEWED the list (#1045's marker, read at the
  // page boundary). Held in local state below so the footer reflects the save the
  // user just made without a round trip.
  reviewed: boolean;
}) {
  const [attrs, setAttrs] = useState<RiskAttributes>(attributes);
  const [reviewed, setReviewed] = useState(reviewedInitial);
  const { pending, savedAt, error, save: runSave } = useSaveStatus();

  function save(next: RiskAttributes) {
    const fd = new FormData();
    for (const { key, name } of FIELDS) fd.set(name, next[key] ? "1" : "0");
    runSave(async () => {
      await saveRiskFactors(fd);
      // EVERY save stamps the review marker (the action does it unconditionally),
      // so any successful save — a toggle or the footer button — makes the review
      // real. Flipping it here is what retires the button and shows the line.
      setReviewed(true);
    });
  }

  return (
    <div
      // Anchor target for the data-quality risk-attributes CTA (#1146):
      // /records/care/overview#risk-factors lands on THIS form, not the page top.
      id="risk-factors"
      className="card scroll-mt-24 space-y-4"
      data-testid="risk-factors"
    >
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Health risk factors
        </h2>
        <SaveStatus pending={pending} savedAt={savedAt} error={error} />
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-400">
        These help tailor how often some lab retests and screenings are
        suggested, and how they&rsquo;re prioritized on Upcoming. Simplified.
      </p>

      <div className="space-y-3">
        {FIELDS.map(({ key, name, label, hint }) => (
          <label
            key={name}
            className="flex cursor-pointer items-start gap-3"
            htmlFor={`risk-${name}`}
          >
            <input
              id={`risk-${name}`}
              data-testid={`risk-${name}`}
              type="checkbox"
              checked={attrs[key]}
              onChange={(e) => {
                const next = { ...attrs, [key]: e.target.checked };
                setAttrs(next);
                save(next);
              }}
              className="mt-0.5 h-4 w-4 shrink-0"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-slate-700 dark:text-slate-200">
                {label}
              </span>
              <span className="block text-xs text-slate-500 dark:text-slate-400">
                {hint}
              </span>
            </span>
          </label>
        ))}
      </div>

      {/* The negative declaration (#2299). The data-quality gap clears on the
          REVIEW MARKER, not on a stored flag — so a profile to which none of the
          five apply had nothing to press and the "Fix it →" CTA landed on a form
          with no fix. This footer both WRITES the marker (through the existing
          save path, with the current all-false payload — the stamp is a side
          effect saveRiskFactors already performs) and DISPLAYS it, which is the
          other half: an unreviewed profile and a declared-empty one used to render
          an identical list of five unchecked boxes.

          A button, not a sixth checkbox: a persistent "none apply" flag would be a
          VALUE contradicting the other five, needing mutual exclusion and an
          un-set path. The button writes the marker that already means exactly
          this. Offered while UNREVIEWED regardless of what is checked — checking a
          box saves, which sets reviewed, so "some factor is on" and "reviewed" are
          the same state; unreviewed → button, reviewed → line, never both. */}
      <div className="border-t border-black/5 pt-4 dark:border-white/10">
        {reviewed ? (
          <p
            className="text-xs text-slate-500 dark:text-slate-400"
            data-testid="risk-reviewed"
          >
            Reviewed &mdash; update any time.
          </p>
        ) : (
          <button
            type="button"
            className="btn-ghost btn-sm"
            data-testid="risk-none-apply"
            disabled={pending}
            onClick={() => save(attrs)}
          >
            None of these apply
          </button>
        )}
      </div>

      <p className="border-t border-black/5 pt-4 text-xs text-slate-500 dark:border-white/10 dark:text-slate-400">
        Privacy: like the rest of this profile&rsquo;s medical passport, anyone
        granted access to this profile (and any admin) can see these.
      </p>
    </div>
  );
}
