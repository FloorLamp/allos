"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
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
];

export default function RiskFactorsForm({
  attributes,
}: {
  attributes: RiskAttributes;
}) {
  const router = useRouter();
  const [attrs, setAttrs] = useState<RiskAttributes>(attributes);
  const { pending, savedAt, error, save: runSave } = useSaveStatus();

  function save(next: RiskAttributes) {
    const fd = new FormData();
    for (const { key, name } of FIELDS) fd.set(name, next[key] ? "1" : "0");
    runSave(async () => {
      await saveRiskFactors(fd);
      router.refresh();
    });
  }

  return (
    <div className="card max-w-lg space-y-4" data-testid="risk-factors">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Health risk factors
        </h2>
        <SaveStatus pending={pending} savedAt={savedAt} error={error} />
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-400">
        These help tailor how often some lab retests and screenings are
        suggested, and how they&rsquo;re prioritized on Upcoming. Simplified and
        informational — not medical advice.
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
              <span className="block text-xs text-slate-400 dark:text-slate-500">
                {hint}
              </span>
            </span>
          </label>
        ))}
      </div>

      <p className="border-t border-black/5 pt-4 text-xs text-slate-400 dark:border-white/10 dark:text-slate-500">
        Privacy: like the rest of this profile&rsquo;s medical passport, anyone
        granted access to this profile (and any admin) can see these.
      </p>
    </div>
  );
}
