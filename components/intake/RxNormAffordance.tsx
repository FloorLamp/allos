"use client";

import type { RxcuiState } from "@/components/intake/useIntakeRxcui";

// The standardized-ingredient EDITOR, behind the `rxnorm` fact chip of both intake
// forms (#846, #5301). The CHIP states the fact — `match RxNorm` while there is none,
// the confirmed code once there is — and this is what opens under it: the candidates
// the lookup returned, or the code with the control that releases it.
//
// NO BUTTON RESTATES THE TAP THAT GOT YOU HERE. The lookup runs when the chip opens,
// which is why the old "Match standardized ingredient" text button under the name field
// is gone: its label named the mechanism rather than the fact, and the fact is now a
// chip like every other. The lookup is the only network call in the interaction feature
// and sends just the term (#144).
//
// Presentational over the shared useIntakeRxcui hook; the form owns the hidden
// `rxcui`/`rxcui_ingredients` inputs.
export default function RxNormAffordance({ rx }: { rx: RxcuiState }) {
  return (
    <div
      data-testid="rxcui-affordance"
      className="space-y-1.5 text-sm text-slate-600 sm:col-span-2 dark:text-slate-300"
    >
      {rx.rxcui ? (
        <p data-testid="rxcui-current" className="flex items-center gap-2">
          <span className="font-medium text-slate-700 dark:text-slate-200">
            RxNorm {rx.rxcui}
          </span>
          <button
            type="button"
            data-testid="rxcui-clear"
            className="btn-ghost btn-sm"
            onClick={rx.clear}
          >
            Clear
          </button>
        </p>
      ) : rx.loading ? (
        <p data-testid="rxcui-loading">Looking up…</p>
      ) : null}

      {rx.error && (
        <p className="text-slate-500 dark:text-slate-400">{rx.error}</p>
      )}

      {rx.candidates && rx.candidates.length > 0 && !rx.rxcui && (
        <div data-testid="rxcui-candidates" className="space-y-1">
          {rx.candidates.map((c) => (
            <div key={c.rxcui} className="flex flex-wrap items-center gap-2">
              <span>
                {c.name || "(unnamed)"}{" "}
                <span className="text-slate-500 dark:text-slate-400">
                  · {c.rxcui}
                </span>
              </span>
              <button
                type="button"
                data-testid={`rxcui-use-${c.rxcui}`}
                className="btn-ghost btn-sm"
                onClick={() => void rx.confirm(c.rxcui)}
              >
                Use
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
