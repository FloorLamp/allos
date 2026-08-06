"use client";

import { useState } from "react";
import SaveStatus from "@/components/SaveStatus";
import { useSaveStatus } from "@/components/useSaveStatus";
import {
  peakFlowZone,
  personalBestRangeError,
  PEAK_FLOW_UNIT,
  PEAK_FLOW_ZONE_COPY,
  type PeakFlowZone,
} from "@/lib/peak-flow";

// THE PEAK-FLOW ZONE CARD (#1850) — the surface that formats the one zone decision.
//
// It is the respiratory sibling of `MetricJudgmentCard`, and it exists as a SEPARATE
// card for the reason the whole domain diverges: that card renders a population band
// resolved from the canonical vocabulary, and there is no population band for peak
// flow. What this renders instead is `peakFlowZone(latest, personalBest)` — the ONE
// pure decision, called here and nowhere re-derived.
//
// TWO STATES, AND THE EMPTY ONE IS THE IMPORTANT ONE. With no personal best recorded
// there is NO VERDICT: the card shows the field and says what the zones would mean,
// and it does not colour the latest reading at all. It never falls back to a
// population range, because there is none to fall back to and inventing one would put
// a green light on someone's red day.
//
// The personal best autosaves on blur — the settings convention, because that is what
// this field is: a declared profile health fact, not a record. The suggestion beside
// it is a SUGGESTION: the highest reading on file is offered as text, and the user's
// typing is the write (the attention doctrine's declared-only rule).

const ZONE_CLASS: Record<PeakFlowZone, string> = {
  green:
    "border-l-emerald-500 dark:border-l-emerald-400 text-emerald-700 dark:text-emerald-300",
  yellow:
    "border-l-amber-500 dark:border-l-amber-400 text-amber-700 dark:text-amber-300",
  red: "border-l-rose-500 dark:border-l-rose-400 text-rose-700 dark:text-rose-300",
};

export default function PeakFlowZoneCard({
  latest,
  personalBest,
  suggestedBest,
  action,
}: {
  /** The most recent charted reading, in L/min, or null when there is none. */
  latest: number | null;
  /** The profile's declared personal best, or null when unset. */
  personalBest: number | null;
  /** The highest reading on file, when it exceeds the declared best. */
  suggestedBest: number | null;
  action: (formData: FormData) => Promise<void>;
}) {
  const [value, setValue] = useState(
    personalBest == null ? "" : String(personalBest)
  );
  const [error, setError] = useState<string | null>(null);
  const { pending, savedAt, error: saveError, save: runSave } = useSaveStatus();

  const verdict = peakFlowZone(latest, personalBest);
  const copy = verdict ? PEAK_FLOW_ZONE_COPY[verdict.zone] : null;

  function save(next: string) {
    const trimmed = next.trim();
    if (trimmed === (personalBest == null ? "" : String(personalBest))) return;
    if (trimmed !== "") {
      const n = Number(trimmed);
      // The SAME pure bounds the server core enforces, so an impossible best shows
      // an inline error instead of a silent no-op.
      const bad =
        !Number.isFinite(n) || n <= 0
          ? "Enter a valid peak flow reading."
          : personalBestRangeError(Math.round(n));
      if (bad) {
        setError(bad);
        return;
      }
    }
    setError(null);
    const fd = new FormData();
    fd.set("personal_best", trimmed);
    runSave(async () => {
      await action(fd);
    });
  }

  return (
    <div
      data-testid="peak-flow-zone"
      data-zone={verdict?.zone ?? "none"}
      className={`card mb-6 border-l-4 ${
        verdict
          ? ZONE_CLASS[verdict.zone]
          : "border-l-slate-300 dark:border-l-slate-600"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3">
        <div>
          <div className="label">Zone</div>
          {verdict && copy ? (
            <>
              <div
                className="text-2xl font-bold"
                data-testid="peak-flow-zone-label"
              >
                {copy.label}
              </div>
              <div
                className="mt-0.5 text-sm tabular-nums text-slate-500 dark:text-slate-400"
                data-testid="peak-flow-zone-percent"
              >
                {verdict.percent}% of your personal best ({verdict.personalBest}{" "}
                {PEAK_FLOW_UNIT})
              </div>
            </>
          ) : (
            <div
              className="text-sm text-slate-500 dark:text-slate-400"
              data-testid="peak-flow-zone-none"
            >
              {personalBest == null
                ? "No zone yet — record your personal best and every reading is read against it."
                : "No zone yet — no peak flow readings on file."}
            </div>
          )}
        </div>
        <div>
          <div className="flex items-center gap-2">
            <label className="label !mb-0" htmlFor="peak-flow-personal-best">
              Personal best
            </label>
            <SaveStatus pending={pending} savedAt={savedAt} error={saveError} />
          </div>
          <div className="mt-1 flex items-center gap-2">
            <input
              id="peak-flow-personal-best"
              data-testid="peak-flow-personal-best"
              type="number"
              step="1"
              min="0"
              className="input w-28"
              defaultValue={personalBest ?? ""}
              onChange={(e) => setValue(e.target.value)}
              onBlur={() => save(value)}
            />
            <span className="text-sm text-slate-500 dark:text-slate-400">
              {PEAK_FLOW_UNIT}
            </span>
          </div>
          {error && (
            <p
              className="mt-1 text-xs text-rose-600 dark:text-rose-400"
              data-testid="peak-flow-personal-best-error"
            >
              {error}
            </p>
          )}
          {suggestedBest != null && (
            <p
              className="mt-1 text-xs text-slate-500 dark:text-slate-400"
              data-testid="peak-flow-personal-best-hint"
            >
              Your highest recorded reading is {suggestedBest} {PEAK_FLOW_UNIT}.
            </p>
          )}
        </div>
      </div>
      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
        {copy
          ? copy.blurb
          : "Zones are a percentage of your own personal best — green 80% or more, yellow 50–80%, red under 50%. Informational, and no substitute for the action plan your clinician gave you."}
      </p>
    </div>
  );
}
