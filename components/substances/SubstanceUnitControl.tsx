"use client";

import { useState } from "react";
import InlineError from "@/components/InlineError";
import { useLoggedViaStamp } from "@/components/LoggedViaSurface";
import { useOptimisticLedger } from "@/components/useOptimisticLedger";
import { useKeyedReceipt } from "@/components/useUndoableAction";
import { substanceDef } from "@/lib/substance-use";
import { LabeledVerbChip } from "@/components/OfferRow";
import { useQuickEntryRow } from "@/components/quick-entry/QuickEntryRowList";
import {
  logSubstanceUnitAction,
  undoSubstanceUnitAction,
  type SubstanceCountResult,
  type SubstanceLogResult,
} from "@/app/(app)/medical/substance-use/actions";
import { useTimeStatement } from "@/components/TimeStatement";
import { useOptionalDayContext } from "@/components/DayContext";

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
  subjectProfileId,
  date,
}: {
  substance: string;
  weekCount?: number;
  capProgress: string | null;
  capAttention?: boolean;
  /** `substance` on the record's card, `quick-entry-substance` in the sheet. */
  testIdPrefix: string;
  // The quick-log sheet's chosen subject (#4932), when it is not the acting
  // profile. Posted as `profile_id` and re-gated by the action's own
  // `gateItemProfile` call.
  subjectProfileId?: number;
  /** Selected quick-entry day. Other mounts omit it and keep today. */
  date?: string;
}) {
  const ledger = useOptimisticLedger("substance-unit");
  const stampLoggedVia = useLoggedViaStamp();
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState(weekCount);
  const inQuickEntryRow = useQuickEntryRow();
  const dayContext = useOptionalDayContext();
  const writeDate = dayContext?.parts.day ?? date;
  const statement = useTimeStatement({
    shown: inQuickEntryRow && writeDate != null,
    day: writeDate ?? "",
    timeLabel: "Time used",
    testId: `${testIdPrefix}-when-${substance}`,
  });
  // The receipt lifecycle this control used to spell by hand (#5738): a mount ref, a
  // generation counter, an origin toast scope and a claimed-owner map. The subject is
  // what a receipt here is ABOUT, so re-pointing the row at another person, substance
  // or day ends the receipts earned under the old one.
  const openReceipt = useKeyedReceipt(
    `${subjectProfileId ?? ""}:${substance}:${writeDate ?? ""}`
  );

  async function tap(kind: "log" | "undo"): Promise<void> {
    setError(null);
    const stated = statement.at;
    const statedInstant = statement.instant;
    const receipt = openReceipt();
    const isCurrent = receipt.isCurrent;
    const originProfileId = subjectProfileId ?? receipt.profileId;
    // #2007: additive substance taps never confirm — several a day is the use case.
    // The ledger's inert window absorbs an accidental double click; undo carries its
    // own key, so a correction straight after a log is not absorbed by it.
    await ledger.tap({
      key: kind,
      write: async (): Promise<SubstanceLogResult | SubstanceCountResult> => {
        const fd = stampLoggedVia(new FormData());
        fd.set("substance", substance);
        if (writeDate) {
          fd.set("date", writeDate);
        }
        if (kind === "log" && statedInstant) fd.set("stated_at", statedInstant);
        if (originProfileId != null)
          fd.set("profile_id", String(originProfileId));
        return kind === "log"
          ? await logSubstanceUnitAction(fd)
          : await undoSubstanceUnitAction(fd);
      },
      settle: (result) => {
        if (!result.ok) {
          if (isCurrent()) setError(result.error);
          // Nothing was written, so the tap stays immediately retryable.
          return { kind: "rollback" };
        }
        if (!isCurrent()) return { kind: "keep" };
        if (kind === "log") statement.spend(stated);
        setCount(result.weekCount);
        if (
          kind === "log" &&
          inQuickEntryRow &&
          receipt.profileId != null &&
          "eventId" in result
        ) {
          const { eventId, date } = result;
          const subject = subjectProfileId ?? receipt.profileId;
          const unit =
            substanceDef(substance).unitSingular === "drink"
              ? "Standard drink"
              : "Use";
          receipt.announce({
            key: `substance-log:${subject}:${substance}:${eventId}`,
            message: `${unit} logged.`,
            undo: {
              undoneMessage: `${unit} undone.`,
              run: async () => {
                if (!isCurrent()) return { ok: false, reason: "changed" };
                const undoFd = new FormData();
                undoFd.set("profile_id", String(subject));
                undoFd.set("substance", substance);
                undoFd.set("event_id", String(eventId));
                undoFd.set("date", date);
                const undone = await undoSubstanceUnitAction(undoFd);
                if (isCurrent() && undone.weekCount != null)
                  setCount(undone.weekCount);
                return undone.ok
                  ? { ok: true }
                  : {
                      ok: false,
                      reason:
                        undone.error === "That use has changed."
                          ? "changed"
                          : "failed",
                    };
              },
            },
          });
        }
        return { kind: "keep" };
      },
      onError: () => {
        if (isCurrent()) setError("Couldn't update that entry.");
        return { kind: "rollback" };
      },
    });
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {inQuickEntryRow ? (
          <LabeledVerbChip
            label={
              substanceDef(substance).unitSingular === "drink"
                ? "Standard drink"
                : "Use"
            }
            verb={ledger.pending("log") ? "Logging…" : "Log"}
            tone="neutral"
            disabled={ledger.blocked("log")}
            onAct={() => void tap("log")}
            ariaLabel={substanceDef(substance).logLabel}
            testId={`${testIdPrefix}-log-${substance}`}
          />
        ) : (
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
        )}
        {!inQuickEntryRow ? (
          <button
            type="button"
            className="btn-ghost"
            disabled={ledger.blocked("undo") || count === 0}
            onClick={() => void tap("undo")}
            data-testid={`${testIdPrefix}-undo-${substance}`}
          >
            Undo today
          </button>
        ) : null}
        {statement.door}
      </div>
      {statement.reveal}
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
