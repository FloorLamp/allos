"use client";

import type { RxcuiState } from "@/components/intake/useIntakeRxcui";

// The RxNorm confirm affordance shared by both intake forms (#846): "Find RxNorm
// code" → candidate list → confirm, or the confirmed-code chip with Clear. The lookup
// is the only network call in the interaction feature and sends just the term (#144).
// Presentational over the shared useIntakeRxcui hook; the form owns the hidden
// `rxcui`/`rxcui_ingredients` inputs.
export default function RxNormAffordance({
  name,
  rx,
}: {
  name: string;
  rx: RxcuiState;
}) {
  return (
    <>
      <div
        data-testid="rxcui-affordance"
        className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400"
      >
        {rx.rxcui ? (
          <span
            data-testid="rxcui-current"
            className="inline-flex items-center gap-1"
          >
            RxNorm code{" "}
            <span className="font-medium text-slate-700 dark:text-slate-200">
              {rx.rxcui}
            </span>
            <button
              type="button"
              data-testid="rxcui-clear"
              className="btn-ghost px-1.5 py-0.5 text-xs"
              onClick={rx.clear}
            >
              Clear
            </button>
          </span>
        ) : (
          <button
            type="button"
            data-testid="rxcui-lookup"
            className="btn-ghost px-2 py-0.5 text-xs"
            onClick={() => void rx.find(name)}
            disabled={rx.loading || !name.trim()}
          >
            {rx.loading ? "Looking up…" : "Find RxNorm code"}
          </button>
        )}
      </div>
      {rx.error && (
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {rx.error}
        </p>
      )}
      {rx.candidates && rx.candidates.length > 0 && !rx.rxcui && (
        <div
          data-testid="rxcui-candidates"
          className="mt-1.5 space-y-1 rounded-lg border border-black/10 p-2 dark:border-white/10"
        >
          {rx.candidates.map((c) => (
            <div
              key={c.rxcui}
              className="flex flex-wrap items-center gap-2 text-xs"
            >
              <span className="text-slate-600 dark:text-slate-300">
                {c.name || "(unnamed)"}{" "}
                <span className="text-slate-500 dark:text-slate-400">
                  · {c.rxcui}
                </span>
              </span>
              <button
                type="button"
                data-testid={`rxcui-use-${c.rxcui}`}
                className="btn-ghost px-2 py-0.5 text-xs"
                onClick={() => void rx.confirm(c.rxcui)}
              >
                Use
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
