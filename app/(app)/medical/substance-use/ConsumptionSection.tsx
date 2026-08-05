"use client";

import { useState, type FormEvent } from "react";
import DateField from "@/components/DateField";
import ModalShell from "@/components/ModalShell";
import NotesText from "@/components/NotesText";
import OverflowMenu, {
  MENU_ITEM,
  MENU_ITEM_DANGER,
} from "@/components/OverflowMenu";
import EntryHistoryTable, {
  type EntryHistoryColumn,
} from "@/components/EntryHistoryTable";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { useOptimisticLedger } from "@/components/useOptimisticLedger";
import { EmptyState } from "@/components/ui";
import {
  formatDateWithYear,
  formatMonthDay,
  type DisplayFormatPrefs,
} from "@/lib/format-date";
import type { SubstanceHistoryEntry, SubstanceTrendWeek } from "@/lib/queries";
import {
  MAX_SUBSTANCE_ENTRY_AMOUNT,
  MAX_WEEKLY_CAP,
  substanceDef,
  type Substance,
} from "@/lib/substance-use";
import {
  addSubstanceHistoryEntryAction,
  clearSubstanceTargetAction,
  deleteSubstanceHistoryEntryAction,
  logSubstanceUnitAction,
  setSubstanceTargetAction,
  undoSubstanceUnitAction,
  updateSubstanceHistoryEntryAction,
} from "./actions";

function mutationError(kind: string): string {
  if (kind === "invalid-date") return "Enter a valid date.";
  if (kind === "invalid-amount")
    return `Enter an amount between 1 and ${MAX_SUBSTANCE_ENTRY_AMOUNT}.`;
  if (kind === "date-conflict")
    return "An entry already exists for that date. Edit it instead.";
  return "Couldn't save that entry.";
}

export default function ConsumptionSection({
  substance,
  weekCount,
  capSet,
  cap,
  capProgress,
  capAttention,
  history,
  trend,
  defaultDate,
  formatPrefs,
}: {
  substance: Substance;
  weekCount: number;
  capSet: boolean;
  cap: number | null;
  capProgress: string | null;
  capAttention: boolean;
  history: SubstanceHistoryEntry[];
  trend: SubstanceTrendWeek[];
  defaultDate: string;
  formatPrefs: DisplayFormatPrefs;
}) {
  const def = substanceDef(substance);
  const confirm = useConfirm();
  const toast = useToast();
  // The shared one-tap ledger (#2041): this surface has no optimistic count to move —
  // the week figure re-renders from the action's revalidation — so the cooldown IS its
  // feedback design (#2007 layer 1), which is exactly what the registry records.
  const ledger = useOptimisticLedger("substance-unit");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cardMenuOpen, setCardMenuOpen] = useState(false);
  const [capOpen, setCapOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [capInput, setCapInput] = useState(cap != null ? String(cap) : "");

  function withSubstance(extra?: Record<string, string>): FormData {
    const fd = new FormData();
    fd.set("substance", substance);
    for (const [key, value] of Object.entries(extra ?? {})) fd.set(key, value);
    return fd;
  }

  async function runOneTap(kind: "log" | "undo") {
    if (pending) return;
    setError(null);
    // #2007: additive substance taps never confirm — several a day is the use case.
    // The ledger's short inert window after success absorbs an accidental queued or
    // double click and then silently clears; an undo carries its own key, so a
    // correction straight after a log is not absorbed by it.
    await ledger.tap({
      key: kind,
      write: () =>
        kind === "log"
          ? logSubstanceUnitAction(withSubstance())
          : undoSubstanceUnitAction(withSubstance()),
      settle: (result) => {
        if (!result.ok) {
          setError(result.error);
          // Nothing was written, so the tap stays immediately retryable.
          return { kind: "rollback" };
        }
        return { kind: "keep" };
      },
      onError: () => {
        setError("Couldn't update that entry.");
        return { kind: "rollback" };
      },
    });
  }

  async function saveCap(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    const result = await setSubstanceTargetAction(
      withSubstance({ cap: capInput })
    );
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setCapOpen(false);
  }

  async function clearCap() {
    if (
      !(await confirm({
        title: `Remove ${def.label.toLowerCase()} weekly cap?`,
        message: "Your consumption history will stay in place.",
        confirmLabel: "Remove cap",
        danger: true,
      }))
    )
      return;
    setPending(true);
    const result = await clearSubstanceTargetAction(withSubstance());
    setPending(false);
    if (!result.ok) setError(result.error);
  }

  async function addEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    const fd = new FormData(event.currentTarget);
    fd.set("substance", substance);
    const result = await addSubstanceHistoryEntryAction(fd);
    setPending(false);
    if (result.kind !== "added") {
      setError(mutationError(result.kind));
      return;
    }
    setError(null);
    setAddOpen(false);
    toast("Entry added.");
  }

  async function editEntry(
    event: FormEvent<HTMLFormElement>,
    entry: SubstanceHistoryEntry,
    done: () => void
  ) {
    event.preventDefault();
    setPending(true);
    const fd = new FormData(event.currentTarget);
    fd.set("substance", substance);
    fd.set("id", String(entry.id));
    const result = await updateSubstanceHistoryEntryAction(fd);
    setPending(false);
    if (result.kind !== "updated") {
      setError(mutationError(result.kind));
      return;
    }
    setError(null);
    done();
    toast("Entry updated.");
  }

  const historyColumns: EntryHistoryColumn<SubstanceHistoryEntry>[] = [
    {
      header: "Date",
      slot: "title",
      cellClassName: "tabular-nums",
      cell: (entry) => formatDateWithYear(entry.date, formatPrefs),
    },
    {
      header: "Amount",
      slot: "value",
      label: "Amount",
      cell: (entry) =>
        `${entry.amount} ${entry.amount === 1 ? def.unitSingular : def.unitPlural}`,
    },
    {
      header: "Notes",
      slot: "meta",
      label: "Notes",
      empty: (entry) => !entry.notes,
      cellClassName: "max-w-sm text-slate-500 dark:text-slate-400",
      cell: (entry) => (entry.notes ? <NotesText notes={entry.notes} /> : "—"),
    },
  ];

  const maxTrend = Math.max(1, ...trend.map((week) => week.count));

  return (
    <section
      className="card space-y-4"
      data-testid={`substance-card-${substance}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-slate-900 dark:text-slate-100">
            {def.label}
          </h2>
          <p
            className="mt-1 text-sm text-slate-600 dark:text-slate-300"
            data-testid={`substance-week-count-${substance}`}
          >
            <span className="font-semibold">{weekCount}</span>{" "}
            {weekCount === 1 ? def.countSingular : def.countPlural} logged this
            week.
          </p>
          {capProgress ? (
            <p
              className={`mt-1 text-sm ${
                capAttention
                  ? "font-medium text-amber-700 dark:text-amber-300"
                  : "text-slate-500 dark:text-slate-400"
              }`}
              data-testid={`substance-cap-progress-${substance}`}
            >
              {capProgress}
            </p>
          ) : null}
        </div>
        <OverflowMenu
          label={`${def.label} options`}
          open={cardMenuOpen}
          onOpenChange={setCardMenuOpen}
        >
          {({ close }) => (
            <>
              <button
                type="button"
                role="menuitem"
                className={MENU_ITEM}
                data-testid={`substance-cap-open-${substance}`}
                onClick={() => {
                  close();
                  setError(null);
                  setCapInput(cap != null ? String(cap) : "");
                  setCapOpen(true);
                }}
              >
                {capSet ? "Change weekly cap" : "Set weekly cap"}
              </button>
              {capSet ? (
                <button
                  type="button"
                  role="menuitem"
                  className={MENU_ITEM_DANGER}
                  data-testid={`substance-cap-clear-${substance}`}
                  onClick={() => {
                    close();
                    void clearCap();
                  }}
                >
                  Remove weekly cap
                </button>
              ) : null}
            </>
          )}
        </OverflowMenu>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={pending || ledger.blocked("log")}
          onClick={() => void runOneTap("log")}
          data-testid={`substance-log-${substance}`}
          className="btn"
        >
          {ledger.pending("log") ? "Logging…" : def.logLabel}
        </button>
        <button
          type="button"
          disabled={pending || ledger.blocked("undo") || weekCount === 0}
          onClick={() => void runOneTap("undo")}
          data-testid={`substance-undo-${substance}`}
          className="btn-ghost"
        >
          Undo today
        </button>
        <button
          type="button"
          className="btn-ghost text-sm"
          data-testid={`substance-history-add-${substance}`}
          onClick={() => {
            setError(null);
            setAddOpen(true);
          }}
        >
          Add for another day
        </button>
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        {def.unitNote}
      </p>

      {error ? (
        <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>
      ) : null}

      <div>
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          History
        </h3>
        {history.length === 0 ? (
          <div className="mt-2">
            <EmptyState
              testId={`substance-history-empty-${substance}`}
              message={`No ${def.label.toLowerCase()} entries yet.`}
              compact
            />
          </div>
        ) : (
          <div className="mt-2" data-testid={`substance-history-${substance}`}>
            <EntryHistoryTable
              items={history}
              columns={historyColumns}
              expandToggle={{
                collapsedLabel: `View all ${history.length} entries`,
                expandedLabel: "Show fewer entries",
                testId: `substance-history-toggle-${substance}`,
              }}
              menuLabel={`${def.label} entry actions`}
              rowTestId={(entry) =>
                `substance-history-row-${substance}-${entry.id}`
              }
              editTestId={(entry) =>
                `substance-history-edit-${substance}-${entry.id}`
              }
              deleteTestId={(entry) =>
                `substance-history-delete-${substance}-${entry.id}`
              }
              renderEditForm={(entry, done) => (
                <form
                  className="grid gap-3 sm:grid-cols-2"
                  onSubmit={(event) => void editEntry(event, entry, done)}
                >
                  <HistoryFields entry={entry} defaultDate={defaultDate} />
                  <div className="flex gap-2 sm:col-span-2">
                    <button
                      type="submit"
                      className="btn"
                      disabled={pending}
                      data-testid={`substance-history-save-${substance}`}
                    >
                      {pending ? "Saving…" : "Save"}
                    </button>
                    <button type="button" className="btn-ghost" onClick={done}>
                      Cancel
                    </button>
                  </div>
                </form>
              )}
              confirmDelete={() => ({
                title: `Delete ${def.label.toLowerCase()} entry?`,
                message: "This changes the weekly count and can be undone.",
                confirmLabel: "Delete entry",
              })}
              deleteFormData={(entry) =>
                withSubstance({ id: String(entry.id) })
              }
              deleteAction={deleteSubstanceHistoryEntryAction}
              deletedMessage="Entry deleted."
            />
          </div>
        )}
      </div>

      <details className="text-sm">
        <summary className="cursor-pointer text-slate-500 dark:text-slate-400">
          8-week trend
        </summary>
        <div
          className="mt-3 space-y-1"
          data-testid={`substance-trend-${substance}`}
        >
          {trend.map((week) => (
            <div key={week.start} className="flex items-center gap-2 text-xs">
              <span className="w-20 shrink-0 text-slate-500 dark:text-slate-400">
                {formatMonthDay(week.start, formatPrefs)}
                {week.isCurrent ? " (now)" : ""}
              </span>
              <div className="h-2 flex-1 rounded bg-black/5 dark:bg-white/5">
                <div
                  className="h-2 rounded bg-brand-400/70"
                  style={{ width: `${(week.count / maxTrend) * 100}%` }}
                />
              </div>
              <span className="w-6 text-right tabular-nums">{week.count}</span>
            </div>
          ))}
        </div>
      </details>

      {addOpen ? (
        <ModalShell
          title={`Add ${def.label.toLowerCase()} entry`}
          onClose={() => setAddOpen(false)}
          className="w-full max-w-lg rounded-xl bg-white p-4 shadow-xl outline-none sm:p-5 dark:bg-ink-900"
        >
          <form
            className="mt-4 grid gap-3 sm:grid-cols-2"
            onSubmit={(event) => void addEntry(event)}
            data-testid={`substance-history-add-form-${substance}`}
          >
            <HistoryFields defaultDate={defaultDate} />
            {error ? (
              <p className="text-sm text-rose-600 sm:col-span-2 dark:text-rose-400">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2 sm:col-span-2">
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setAddOpen(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn"
                disabled={pending}
                data-testid={`substance-history-add-save-${substance}`}
              >
                {pending ? "Adding…" : "Add entry"}
              </button>
            </div>
          </form>
        </ModalShell>
      ) : null}

      {capOpen ? (
        <ModalShell
          title={`${capSet ? "Change" : "Set"} ${def.label.toLowerCase()} weekly cap`}
          onClose={() => setCapOpen(false)}
          className="w-full max-w-lg rounded-xl bg-white p-4 shadow-xl outline-none sm:p-5 dark:bg-ink-900"
        >
          <form
            className="mt-4 space-y-4"
            onSubmit={(event) => void saveCap(event)}
          >
            <label className="block text-sm">
              Weekly cap ({def.countPlural}, 0–{MAX_WEEKLY_CAP})
              <input
                type="number"
                min={0}
                max={MAX_WEEKLY_CAP}
                value={capInput}
                onChange={(event) => setCapInput(event.target.value)}
                data-testid={`substance-cap-input-${substance}`}
                className="input mt-1 w-full"
                required
              />
            </label>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Set 0 for {def.freeWeekPhrase}.
            </p>
            {error ? (
              <p className="text-sm text-rose-600 dark:text-rose-400">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setCapOpen(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn"
                disabled={pending || capInput === ""}
                data-testid={`substance-cap-save-${substance}`}
              >
                {pending ? "Saving…" : "Save cap"}
              </button>
            </div>
          </form>
        </ModalShell>
      ) : null}
    </section>
  );
}

function HistoryFields({
  entry,
  defaultDate,
}: {
  entry?: SubstanceHistoryEntry;
  defaultDate: string;
}) {
  return (
    <>
      <label className="text-sm">
        Date
        <DateField
          name="date"
          defaultValue={entry?.date ?? defaultDate}
          max={defaultDate}
          required
          inputClassName="mt-1 w-full"
        />
      </label>
      <label className="text-sm">
        Amount
        <input
          type="number"
          name="amount"
          min={1}
          max={MAX_SUBSTANCE_ENTRY_AMOUNT}
          step={1}
          defaultValue={entry?.amount ?? 1}
          required
          className="input mt-1 w-full"
        />
      </label>
      <label className="text-sm sm:col-span-2">
        Notes
        <textarea
          name="notes"
          rows={3}
          defaultValue={entry?.notes ?? ""}
          className="input mt-1 w-full"
        />
      </label>
    </>
  );
}
