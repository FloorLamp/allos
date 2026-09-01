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

// THE SUBSTANCE DOMAIN'S ONE ROW CONTROL (#4424 ruling 3), named by
// `LOG_MANIFEST.substance.pieces.rowControl`: the unit tap, its undo and the #998 cap
// verdict. The record's card and the quick-log sheet's row both mount it.
//
// THE CAP LINE BELONGS TO THE CONTROL, NOT ITS HOSTS. The manifest excludes this domain
// from the offline queue for exactly one reason (#3279) — the verdict renders beside
// the button and a queued unit would leave that safety readout understating — so the
// verdict travels with the TAP, and a second tap surface cannot forget to draw it.
// `capProgress` is null for a profile that set no target, and null renders NOTHING: no
// "no cap set", no dash, no placeholder. That boundary is structural
// (docs/internals/substances.md); do not add a flag re-asking it. `cap: 0` is the other
// state and DOES render — an opted-in target of zero is a target.
//
// ONE FIELD SET AT EVERY MOUNT (#4424 class C): the sheet's row offered no undo.
// `weekCount` is optional because only the card's read knows it; undefined means
// unknown, so the tap is offered rather than disabled on a guess (undo is idempotent),
// and every write answers with the post-write count.
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
    // The ledger's inert window absorbs an accidental double click; undo carries its
    // own key, so a correction straight after a log is not absorbed by it.
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
          {ledger.pending("log")
            ? "Logging…"
            : substanceDef(substance).logLabel}
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
