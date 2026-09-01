"use client";

import { useState } from "react";
import InlineError from "@/components/InlineError";
import { useLoggedViaStamp } from "@/components/LoggedViaSurface";
import { useOptimisticLedger } from "@/components/useOptimisticLedger";
import { substanceDef } from "@/lib/substance-use";
import {
  logSubstanceUnitAction,
  undoSubstanceUnitAction,
} from "@/app/(app)/medical/substance-use/actions";

// THE SUBSTANCE DOMAIN'S ONE ROW CONTROL (#4424 ruling 3) — the unit tap, its undo,
// and the #998 cap verdict that must stand beside them. It is what
// `LOG_MANIFEST.substance.pieces.rowControl` names.
//
// WHY THE CAP LINE IS PART OF THE CONTROL AND NOT OF ITS HOSTS. The manifest excludes
// this domain from the offline queue for exactly one reason (#3279): "the card renders
// the week count and the cap verdict beside the button, and a queued unit would leave
// that safety readout silently understating". That argument is about the TAP, so the
// verdict travels with the tap rather than with whichever page happens to draw it — a
// second tap surface that forgot to render it would re-open the hole the exclusion
// closes. `capProgress` is null for a profile that set no target, and null renders
// NOTHING: no "no cap set", no dash. The opt-in boundary is structural
// (docs/internals/substances.md) — do not add a flag re-answering it.
//
// ONE FIELD SET AT EVERY MOUNT (#4424 class C: folds may collapse, fields may not
// vanish per mount). The quick-log sheet's row used to offer a log and no undo, so a
// mis-tap there had to be corrected on another page; both taps are here now, under the
// SAME `substance-unit` one-tap ledger whose registry entry already says what a second
// tap means — additive, cooldown feedback, never a confirm.
//
// `weekCount` IS OPTIONAL BECAUSE ONLY SOME MOUNTS KNOW IT. The substance card is
// rendered from the week state and can say "nothing has been logged, so there is
// nothing to undo"; the sheet's row is built from a different read and cannot. Undefined
// therefore means "unknown", and the tap is offered rather than disabled on a guess —
// the undo core is idempotent, so the worst case is a no-op. Every write answers with
// the post-write count, so after the first tap the control knows it whatever it was
// handed.
export default function SubstanceUnitControl({
  substance,
  weekCount,
  capProgress,
  capAttention = false,
  testIdPrefix,
}: {
  substance: string;
  weekCount?: number;
  capProgress: string | null;
  capAttention?: boolean;
  /** `substance` on the record's card, `quick-entry-substance` in the sheet. */
  testIdPrefix: string;
}) {
  const ledger = useOptimisticLedger("substance-unit");
  const stampLoggedVia = useLoggedViaStamp();
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState(weekCount);

  async function tap(kind: "log" | "undo"): Promise<void> {
    setError(null);
    // #2007: additive substance taps never confirm — several a day is the use case.
    // The ledger's short inert window after success absorbs an accidental double click
    // and then clears; undo carries its own key, so a correction straight after a log
    // is not absorbed by it.
    await ledger.tap({
      key: kind,
      write: () => {
        const fd = stampLoggedVia(new FormData());
        fd.set("substance", substance);
        return kind === "log"
          ? logSubstanceUnitAction(fd)
          : undoSubstanceUnitAction(fd);
      },
      settle: (result) => {
        if (!result.ok) {
          setError(result.error);
          // Nothing was written, so the tap stays immediately retryable.
          return { kind: "rollback" };
        }
        setCount(result.weekCount);
        return { kind: "keep" };
      },
      onError: () => {
        setError("Couldn't update that entry.");
        return { kind: "rollback" };
      },
    });
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn"
          disabled={ledger.blocked("log")}
          onClick={() => void tap("log")}
          data-testid={`${testIdPrefix}-log-${substance}`}
        >
          {ledger.pending("log") ? "Logging…" : substanceDef(substance).logLabel}
        </button>
        <button
          type="button"
          className="btn-ghost"
          disabled={ledger.blocked("undo") || count === 0}
          onClick={() => void tap("undo")}
          data-testid={`${testIdPrefix}-undo-${substance}`}
        >
          Undo today
        </button>
      </div>
      {capProgress ? (
        <p
          className={`text-sm ${
            capAttention
              ? "font-medium text-amber-700 dark:text-amber-300"
              : "text-slate-500 dark:text-slate-400"
          }`}
          data-testid={`${testIdPrefix}-cap-progress-${substance}`}
        >
          {capProgress}
        </p>
      ) : null}
      <InlineError data-testid={`${testIdPrefix}-error-${substance}`}>
        {error}
      </InlineError>
    </div>
  );
}
