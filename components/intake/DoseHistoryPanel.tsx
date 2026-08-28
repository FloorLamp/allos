"use client";

import { useState } from "react";
import HistoricalDoseForm from "@/components/medications/HistoricalDoseForm";
import EntryHistoryTable, {
  type EntryHistoryColumn,
} from "@/components/EntryHistoryTable";
import {
  deleteAdministration,
  logHistoricalDose,
} from "@/app/(app)/nutrition/intake-actions";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { useToast } from "@/components/Toast";
import { useOptimisticLedger } from "@/components/useOptimisticLedger";
import {
  formatClockValue,
  formatLongDate,
  parseClockHhmm,
} from "@/lib/format-date";
import { missedDoseDays, type AdherenceDot } from "@/lib/intake-adherence";
import {
  formatMedicationDoseLine,
  formatMedicationDoseProduct,
} from "@/lib/medication-dose-format";

// One recorded administration as the panel renders it. `time` is the
// already-formatted profile-local clock string — when the row states no intake time
// of its own, the caller marks the record-chain clock as "recorded 7:02am" rather
// than presenting a filing timestamp as an administration time (#2228 decision 4).
// `statedAt` is the row's stated event instant (occurred_at, ISO UTC) or null — the
// ONLY thing the edit form's time field may seed from (#2228 decision 1): a row
// whose intake time was never stated opens its editor with an EMPTY time field,
// never with recorded_at capture wearing an administration time's
// clothes.
export interface DoseHistoryEntry {
  id: number;
  doseId: number;
  date: string;
  time: string;
  statedAt: string | null;
  amount: string | null;
  product: string | null;
}

// The offer row's shape: the sheet-row grammar the app already draws an offer in —
// a full-width bordered row at the #644 tap floor, not a button-control. No new
// `globals.css` utility for four rows that exist inside one panel.
const OFFER_ROW_CLASS =
  "press flex min-h-11 w-full items-center rounded-lg border border-(--border) bg-surface px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-(--ghost-hover) disabled:opacity-50 dark:text-slate-200";

// What the backfill door is showing. `offers` is the missed-day list; `form` is
// today's form, either blank ("Another date…") or seeded with a day the offer could
// not write on its own.
type BackfillView = { kind: "offers" } | { kind: "form"; date?: string };

// A live (non-retired) dose row the backfill form may log against.
export interface DoseHistoryDose {
  id: number;
  amount: string | null;
  time_of_day: string | null;
}

// The dose-history panel: an item's recorded administrations, with backfill, amend,
// and delete-with-undo behind the ⋯ row-action convention (#1488).
//
// ONE component for BOTH kinds (#1933). It was inline in MedicationCard, which is
// exactly how the split survived: supplements and medications share their dose,
// adherence, refill, interaction, and warning machinery by rule, and historical dose
// correction is adherence machinery. A second copy under the supplements tab would
// have re-created the divergence this issue exists to remove, so the medication card
// and the supplement row now render the same panel over the same ungated cores.
//
// The ROWS are the shared EntryHistoryTable since #2417 — that component's header had
// named dose history as one of the four clones it existed to absorb, and this was the
// copy that never migrated. The bespoke `<ul>`, its own ⋯ menu, and its own delete
// wiring are gone; what stays here is what is genuinely dose history's own: the
// columns, the backfill/amend form, and the item's dose options.
//
// This is the ITEM-SCOPED scope of one question. The CROSS-ITEM scope — the same
// rows for every item at once — is components/intake/DoseLedgerTable.tsx, over the
// same cores and the same table. An item-scoped question stays answerable on the
// item, which is why this panel keeps its own "Log past dose" entry.
//
// Every action renders its core's typed outcome: the forms show the refusal text the
// action returned, and the delete goes through EntryHistoryTable's useUndoableDelete,
// which only offers Undo when the core actually handed back a token. Nothing here
// confirms unconditionally.
export default function DoseHistoryPanel({
  itemId,
  itemName,
  product,
  doses,
  asNeeded,
  history,
  strip = [],
  minDate,
  maxDate,
  defaultTime,
  canWrite = true,
  courseBound = true,
  backfillDisabledReason,
  note,
}: {
  itemId: number;
  itemName: string;
  product: string | null;
  doses: DoseHistoryDose[];
  asNeeded: boolean;
  history: DoseHistoryEntry[];
  // The adherence strip the CARD already renders and already holds (#3674). Passed
  // down rather than recomputed: the missed days the backfill offers are the same
  // days this strip is drawing, and there is exactly one computation of them (#221,
  // #3369). Defaulted so a caller with no strip simply offers no shortcut.
  strip?: readonly AdherenceDot[];
  minDate?: string;
  maxDate: string;
  defaultTime: string;
  canWrite?: boolean;
  // Whether this item's history is bounded by a medication course (see the form).
  courseBound?: boolean;
  // Why a backfill can't be offered right now (no live dose, no course covering any
  // date). Present = the button is disabled and says so; absent = it is offered.
  backfillDisabledReason?: string;
  // What this list is bounded to, when a caller shows a window rather than the whole
  // record. Rendered rather than left implicit, so a list that stops at 90 days never
  // reads as "you have no older doses".
  note?: string;
}) {
  const [backfill, setBackfill] = useState<BackfillView | null>(null);
  const formatPrefs = useFormatPrefs();
  const toast = useToast();
  const ledger = useOptimisticLedger("dose-backfill");

  const doseOptions = doses.map((dose) => ({
    id: dose.id,
    label:
      formatMedicationDoseLine({
        amount: dose.amount,
        product,
        timeOfDay: dose.time_of_day,
        asNeeded,
        timeFormat: formatPrefs.timeFormat,
      }) || "Dose",
    amount: dose.amount,
  }));

  // An offer may never promise what the core would refuse (#1505), so the days are
  // clipped to the same bounds the form's date field is clipped to before any of them
  // is drawn. Everything else the core re-checks server-side and can still refuse
  // out loud — a course gap, a dose retired since the page rendered.
  const offeredDays = missedDoseDays(strip).filter(
    (date) => (!minDate || date >= minDate) && date <= maxDate
  );
  // A day with ONE live dose has a single answer to "which dose"; a day with more has
  // none the app can pick, so that row routes into the form seeded with the date
  // instead of guessing (#3674). The condition is per ITEM and not per day on
  // purpose: the strip carries one state per DAY, so "two doses due on THAT day" is
  // not a question it can answer, and asking it would mean deriving dueness a second
  // time — the one thing this offer exists not to do.
  const soleDose = doses.length === 1 ? doses[0]! : null;

  // WHAT AN OFFER MAY PROMISE ABOUT THE TIME. A dose's `time_of_day` is free text and
  // is as often a bucket ("Morning") as a clock ("08:00"), and only a clock can be
  // written. When it is one, the offer both POSTS it and NAMES it. When it is not,
  // the offer falls back to the form's own default and DROPS the slot word from its
  // label — a row reading "morning" that records 13:04 promises what the tap does not
  // do (#1505), and the label is the whole promise here because there is no visible
  // field to correct it in.
  const offerHhmm = parseClockHhmm(soleDose?.time_of_day);
  const offerPromise = [
    soleDose ? formatMedicationDoseProduct(soleDose.amount, product) : null,
    offerHhmm ? formatClockValue(offerHhmm, formatPrefs.timeFormat) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  function logMissedDay(date: string) {
    if (!soleDose) {
      setBackfill({ kind: "form", date });
      return;
    }
    void ledger.tap({
      // Per DAY: two offers in the list are two independent writes, and neither may
      // be absorbed by the other's cooldown.
      key: date,
      write: () => {
        const fd = new FormData();
        fd.set("id", String(itemId));
        fd.set("dose_id", String(soleDose.id));
        fd.set("date", date);
        // The same field names and the same amount the form posts, so the offer and
        // the form produce one row rather than two spellings of one write. The TIME
        // is the one value derived better than the form derives it — see
        // `offerHhmm` — because this row's words are the only thing standing for it.
        fd.set("time", offerHhmm ?? defaultTime);
        if (soleDose.amount) fd.set("amount", soleDose.amount);
        return logHistoricalDose(fd);
      },
      settle: (result) => {
        if (!result.ok) {
          toast(result.error, { tone: "error" });
          return { kind: "rollback" };
        }
        toast(`Logged past dose of ${itemName}.`);
        setBackfill(null);
        return { kind: "keep" };
      },
      onError: () => {
        toast("Couldn't log that — try again.", { tone: "error" });
        return { kind: "rollback" };
      },
    });
  }

  const columns: EntryHistoryColumn<DoseHistoryEntry>[] = [
    {
      header: "Date",
      slot: "title",
      cellClassName: "font-medium text-slate-600 dark:text-slate-300",
      cell: (entry) => formatLongDate(entry.date, formatPrefs),
    },
    {
      header: "Amount",
      slot: "value",
      label: "Amount",
      empty: (entry) =>
        !formatMedicationDoseProduct(entry.amount, entry.product),
      cellClassName: "text-slate-600 dark:text-slate-300",
      cell: (entry) =>
        formatMedicationDoseProduct(entry.amount, entry.product) || "—",
    },
    {
      header: "Time",
      slot: "trailing",
      empty: (entry) => !entry.time,
      cellClassName: "text-xs text-slate-500 dark:text-slate-400",
      cell: (entry) => entry.time || "—",
    },
  ];

  return (
    <div data-testid="dose-history">
      <div className="mb-1 flex items-center justify-between gap-3">
        <span className="section-label">Dose history</span>
        {canWrite ? (
          <button
            type="button"
            onClick={() =>
              setBackfill(
                backfill
                  ? null
                  : offeredDays.length > 0
                    ? { kind: "offers" }
                    : { kind: "form" }
              )
            }
            className="btn-ghost btn-sm"
            disabled={!!backfillDisabledReason}
            aria-expanded={!!backfill}
            data-testid="dose-history-add"
          >
            {/* ONE identity (#3674). The control used to rename itself "Cancel"
                because it toggled a form; it now opens a surface that carries its
                own dismissal, so the label says what the control is for. With no
                missed day to offer it opens the form directly — no empty offer
                state, and no button promising a list it cannot show. */}
            Log past dose
          </button>
        ) : null}
      </div>
      {canWrite && backfillDisabledReason ? (
        <p className="mb-1 text-xs text-slate-500 dark:text-slate-400">
          {backfillDisabledReason}
        </p>
      ) : null}
      {note ? (
        <p className="mb-1 text-xs text-slate-500 dark:text-slate-400">
          {note}
        </p>
      ) : null}
      {canWrite && backfill?.kind === "offers" ? (
        <div
          className="mt-2 flex flex-col gap-1"
          data-testid="dose-backfill-offers"
        >
          {/* THE TAP IS THE WRITE (#1505/#3674). Each row names the day and the dose
              it will record, and posts the SAME backfill action the form below posts
              — its plausibility gates, bounds, course binding and as-needed handling
              unchanged and still re-checked server-side. There is no second write
              path here, only a second way to reach the one there is. */}
          {offeredDays.map((date) => (
            <button
              key={date}
              type="button"
              data-testid="dose-backfill-offer"
              disabled={ledger.blocked(date)}
              onClick={() => logMissedDay(date)}
              className={OFFER_ROW_CLASS}
            >
              {`${formatLongDate(date, formatPrefs)} · ${
                soleDose ? offerPromise : "choose a dose"
              }`}
            </button>
          ))}
          <button
            type="button"
            data-testid="dose-backfill-other"
            onClick={() => setBackfill({ kind: "form" })}
            className={OFFER_ROW_CLASS}
          >
            Another date…
          </button>
          <div>
            <button
              type="button"
              onClick={() => setBackfill(null)}
              className="btn-ghost btn-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {canWrite && backfill?.kind === "form" ? (
        <HistoricalDoseForm
          itemId={itemId}
          itemName={itemName}
          doses={doseOptions}
          minDate={minDate}
          maxDate={maxDate}
          initialDate={backfill.date}
          defaultTime={defaultTime}
          asNeeded={asNeeded}
          courseBound={courseBound}
          onDone={() => setBackfill(null)}
        />
      ) : null}
      {history.length > 0 ? (
        <div className="mt-2">
          <EntryHistoryTable
            items={history}
            columns={columns}
            readOnly={!canWrite}
            menuKind="Dose"
            menuItemName={(entry) => formatLongDate(entry.date, formatPrefs)}
            rowTestId={() => "dose-history-row"}
            renderEditForm={(entry, done) => (
              <HistoricalDoseForm
                itemId={itemId}
                itemName={itemName}
                doses={doseOptions}
                minDate={minDate}
                maxDate={maxDate}
                defaultTime={defaultTime}
                asNeeded={asNeeded}
                courseBound={courseBound}
                editing={{
                  logId: entry.id,
                  doseId: entry.doseId,
                  date: entry.date,
                  statedAt: entry.statedAt,
                  amount: entry.amount,
                }}
                onDone={done}
              />
            )}
            confirmDelete={(entry) => ({
              title: "Delete dose?",
              message: `Remove the ${formatLongDate(
                entry.date,
                formatPrefs
              )} dose of ${itemName} from the record. You can undo this.`,
              confirmLabel: "Delete dose",
            })}
            deleteFormData={(entry) => {
              const fd = new FormData();
              fd.set("log_id", String(entry.id));
              return fd;
            }}
            deleteAction={deleteAdministration}
            deletedMessage="Dose deleted."
          />
        </div>
      ) : (
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          No doses recorded yet.
        </p>
      )}
    </div>
  );
}
