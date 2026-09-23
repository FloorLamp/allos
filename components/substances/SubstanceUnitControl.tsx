"use client";

import { useEffect, useRef, useState } from "react";
import InlineError from "@/components/InlineError";
import { useLoggedViaStamp } from "@/components/LoggedViaSurface";
import { useOptimisticLedger } from "@/components/useOptimisticLedger";
import { useKeyedReceipt } from "@/components/useUndoableAction";
import { substanceDef } from "@/lib/substance-use";
import { LabeledVerbChip } from "@/components/OfferRow";
import { BusyMark } from "@/components/Button";
import { useQuickEntryRow } from "@/components/quick-entry/QuickEntryRowList";
import {
  logSubstanceUnitAction,
  undoSubstanceUnitAction,
  type SubstanceCountResult,
  type SubstanceLogResult,
} from "@/app/(app)/medical/substance-use/actions";
import { useTimeStatement } from "@/components/TimeStatement";
import { useOptionalDayContext } from "@/components/DayContext";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import RollingNumber from "@/components/RollingNumber";
import { usePrefersReducedMotion } from "@/components/usePrefersReducedMotion";
import { formatClockValue } from "@/lib/format-date";
import { countDayWord } from "@/lib/day-word";
import { microMotionPlan } from "@/lib/micro-motion";

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
  // THE SHEET ROW'S RECEIPT (#5663 ruling 1): "1 today · 3 this week", from the
  // write's own answer. Null until this mount lands a write — the sheet's gather
  // carries no counts, and a row that has not written has nothing to state.
  const [dayCount, setDayCount] = useState<number | null>(null);
  // The cap verdict rides every write's answer (#998), so the line beside the tap
  // moves with the counts rather than standing at the host's last read.
  const [cap, setCap] = useState(capProgress);
  const [seenCapProp, setSeenCapProp] = useState(capProgress);
  if (seenCapProp !== capProgress) {
    setSeenCapProp(capProgress);
    setCap(capProgress);
  }
  const prefs = useFormatPrefs();
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
  // The receipt belongs to the subject and day it counted, like the toast's Undo.
  const receiptKey = `${subjectProfileId ?? ""}:${writeDate ?? ""}`;
  const [seenReceiptKey, setSeenReceiptKey] = useState(receiptKey);
  if (seenReceiptKey !== receiptKey) {
    setSeenReceiptKey(receiptKey);
    setDayCount(null);
    setCap(capProgress);
  }
  // ONE SETTLE PER LANDED LOG (#5900 problem 2), exactly as
  // `DoseStatusControl.settleConfirm`: one 300 ms run on the sheet's chip after a log
  // the server accepted, never on mount, a refusal or an Undo. Under reduced motion
  // the plan applies no class and the receipt line below simply changes.
  const reducedMotion = usePrefersReducedMotion();
  const settlePlan = microMotionPlan("settle", reducedMotion);
  const [settling, setSettling] = useState(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
    },
    []
  );
  function settleConfirm() {
    if (!settlePlan.animate) return;
    if (settleTimer.current) clearTimeout(settleTimer.current);
    setSettling(true);
    settleTimer.current = setTimeout(() => {
      settleTimer.current = null;
      setSettling(false);
    }, settlePlan.ms);
  }

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
        setDayCount(result.dayCount);
        setCap(result.capProgress);
        if (
          kind === "log" &&
          inQuickEntryRow &&
          receipt.profileId != null &&
          "eventId" in result
        ) {
          settleConfirm();
          const { eventId, date, statedClock } = result;
          const subject = subjectProfileId ?? receipt.profileId;
          const unit =
            substanceDef(substance).unitSingular === "drink"
              ? "Standard drink"
              : "Use";
          // Ruling 1's grammar, `<Thing> logged · <time>`. The slot is the minute the
          // write accepted and drops when none was stated, as on the stool and
          // measurements bodies (#5921): a tap's own moment is not a claim of use.
          const clock = formatClockValue(
            statedClock,
            prefs.timeFormat,
            "",
            "upper-space"
          );
          receipt.announce({
            key: `substance-log:${subject}:${substance}:${eventId}`,
            message: `${unit} logged${clock ? ` · ${clock}` : ""}`,
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
                if (isCurrent() && undone.dayCount != null)
                  setDayCount(undone.dayCount);
                if (isCurrent() && undone.capProgress !== undefined)
                  setCap(undone.capProgress);
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

  // The day word is the sheet switcher's own (#5663 ruling 5), so the line never says
  // "today" under a Yesterday tab. A zero day drops its half, as `practiceRowFacts`
  // does, rather than printing an absence.
  const dayWord = writeDate
    ? countDayWord(writeDate, dayContext?.today ?? writeDate, prefs)
    : "today";

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {inQuickEntryRow ? (
          <span
            data-testid={`${testIdPrefix}-settle-${substance}`}
            data-settling={settling ? "true" : "false"}
            data-reduced-motion={reducedMotion ? "true" : "false"}
            className={`inline-flex rounded-full${
              settling ? ` ${settlePlan.className}` : ""
            }`}
          >
            <LabeledVerbChip
              label={
                substanceDef(substance).unitSingular === "drink"
                  ? "Standard drink"
                  : "Use"
              }
              verb="Log"
              tone="neutral"
              disabled={ledger.blocked("log")}
              busy={ledger.pending("log")}
              onAct={() => void tap("log")}
              ariaLabel={substanceDef(substance).logLabel}
              testId={`${testIdPrefix}-log-${substance}`}
            />
          </span>
        ) : (
          <button
            type="button"
            className="btn"
            disabled={ledger.blocked("log")}
            aria-busy={ledger.pending("log") || undefined}
            onClick={() => void tap("log")}
            data-testid={`${testIdPrefix}-log-${substance}`}
          >
            {/* The mark PRECEDES the label rather than replacing it (#5900): this
                arm has a label, and swapping it to "Logging…" is what moved the
                word out from under the finger. */}
            {ledger.pending("log") ? <BusyMark /> : null}
            {substanceDef(substance).logLabel}
          </button>
        )}
        {!inQuickEntryRow ? (
          <button
            type="button"
            className="btn-ghost"
            disabled={ledger.blocked("undo") || count === 0}
            aria-busy={ledger.pending("undo") || undefined}
            onClick={() => void tap("undo")}
            data-testid={`${testIdPrefix}-undo-${substance}`}
          >
            {ledger.pending("undo") ? <BusyMark /> : null}
            Undo today
          </button>
        ) : null}
        {statement.door}
      </div>
      {statement.reveal}
      {inQuickEntryRow && dayCount != null && count != null ? (
        <p
          className="text-sm text-slate-500 dark:text-slate-400"
          data-testid={`${testIdPrefix}-receipt-${substance}`}
        >
          {dayCount > 0 ? (
            <>
              <RollingNumber
                value={dayCount}
                format={(n) => `${n} ${dayWord}`}
              />
              {" · "}
            </>
          ) : null}
          <RollingNumber value={count} format={(n) => `${n} this week`} />
        </p>
      ) : null}
      {cap ? (
        <p
          className={`text-sm ${
            capAttention
              ? "font-medium text-amber-700 dark:text-amber-300"
              : "text-slate-500 dark:text-slate-400"
          }`}
          data-testid={`${testIdPrefix}-cap-progress-${substance}`}
        >
          {cap}
        </p>
      ) : null}
      <InlineError data-testid={`${testIdPrefix}-error-${substance}`}>
        {error}
      </InlineError>
    </div>
  );
}
