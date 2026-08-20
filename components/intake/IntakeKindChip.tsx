"use client";

import {
  INTAKE_KIND_NOUN,
  intakeKindAskPrompt,
  intakeKindReason,
  type IntakeKindDerivation,
} from "@/lib/intake-kind";
import type { IntakeItemKind } from "@/lib/types";

// The derived kind, rendered (#3216 decision 1).
//
// It is a CHIP, not a control, because that is what it is: the form worked the kind
// out from the name and is telling you, the way it tells you anything else it
// decided. `change` is beside it so the answer is correctable in one tap — which is
// the difference between deriving a fact and guessing at one. A kind-locked door has
// nothing to correct, so it renders no toggle.
//
// The two asks are DIFFERENT QUESTIONS and say so: a name on both lists is a real
// ambiguity, a name on neither is a name we do not know. Merging them into one
// "which is it?" would tell the melatonin case nothing about why it was asked.

export default function IntakeKindChip({
  derivation,
  onChoose,
}: {
  derivation: IntakeKindDerivation;
  onChoose: (kind: IntakeItemKind) => void;
}) {
  if (derivation.kind == null) {
    return (
      <div
        data-testid="intake-kind-ask"
        data-ask={derivation.source}
        className="sm:col-span-2"
      >
        <p className="mb-1.5 text-sm text-slate-600 dark:text-slate-300">
          {intakeKindAskPrompt(derivation.source)}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {(["medication", "supplement"] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              data-testid={`intake-kind-pick-${kind}`}
              onClick={() => onChoose(kind)}
              className="tap-target rounded-full border border-(--border) bg-surface px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-(--ghost-hover) dark:text-slate-200"
            >
              {INTAKE_KIND_NOUN[kind]}
            </button>
          ))}
        </div>
      </div>
    );
  }

  const reason = intakeKindReason(derivation.source);
  const other =
    derivation.kind === "medication" ? "supplement" : ("medication" as const);
  return (
    <div
      data-testid="intake-kind-chip"
      data-kind={derivation.kind}
      data-source={derivation.source}
      className="flex flex-wrap items-center gap-2 sm:col-span-2"
    >
      <span className="inline-flex items-center rounded-full bg-brand-50 px-3 py-1.5 text-sm font-medium text-brand-700 dark:bg-brand-950 dark:text-brand-300">
        {INTAKE_KIND_NOUN[derivation.kind]}
        {reason && (
          <span className="ml-1.5 font-normal opacity-80">· {reason}</span>
        )}
      </span>
      {derivation.correctable && (
        <button
          type="button"
          data-testid="intake-kind-change"
          onClick={() => onChoose(other)}
          className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-400"
        >
          change
        </button>
      )}
    </div>
  );
}
