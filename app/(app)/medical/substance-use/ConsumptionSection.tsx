"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import DateField from "@/components/DateField";
import ModalShell from "@/components/ModalShell";
import NotesText from "@/components/NotesText";
import OverflowMenu, {
  MENU_ITEM,
  MENU_ITEM_DANGER,
} from "@/components/OverflowMenu";
import { ResponsiveTable, Td } from "@/components/ResponsiveTable";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { useUndoableDelete } from "@/components/useUndoableDelete";
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

const COLLAPSED_HISTORY_COUNT = 5;
const POST_SUCCESS_COOLDOWN_MS = 2000;

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
  const undoable = useUndoableDelete();
  const cooldownTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pending, setPending] = useState(false);
  const [cooldown, setCooldown] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cardMenuOpen, setCardMenuOpen] = useState(false);
  const [rowMenuOpen, setRowMenuOpen] = useState<number | null>(null);
  const [capOpen, setCapOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [capInput, setCapInput] = useState(cap != null ? String(cap) : "");

  useEffect(
    () => () => {
      if (cooldownTimer.current) clearTimeout(cooldownTimer.current);
    },
    []
  );

  function withSubstance(extra?: Record<string, string>): FormData {
    const fd = new FormData();
    fd.set("substance", substance);
    for (const [key, value] of Object.entries(extra ?? {})) fd.set(key, value);
    return fd;
  }

  async function runOneTap(kind: "log" | "undo") {
    if (pending || cooldown) return;
    setError(null);
    setPending(true);
    try {
      const result =
        kind === "log"
          ? await logSubstanceUnitAction(withSubstance())
          : await undoSubstanceUnitAction(withSubstance());
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // #2007: additive substance taps never confirm. A short inert window after
      // success absorbs an accidental queued/double click and then silently clears.
      setCooldown(true);
      cooldownTimer.current = setTimeout(
        () => setCooldown(false),
        POST_SUCCESS_COOLDOWN_MS
      );
    } catch {
      setError("Couldn't update that entry.");
    } finally {
      setPending(false);
    }
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
    entry: SubstanceHistoryEntry
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
    setEditingId(null);
    toast("Entry updated.");
  }

  async function removeEntry(entry: SubstanceHistoryEntry) {
    if (
      !(await confirm({
        title: `Delete ${def.label.toLowerCase()} entry?`,
        message: "This changes the weekly count and can be undone.",
        confirmLabel: "Delete entry",
        danger: true,
      }))
    )
      return;
    const fd = withSubstance({ id: String(entry.id) });
    await undoable(deleteSubstanceHistoryEntryAction, fd, {
      deletedMessage: "Entry deleted.",
    });
  }

  const visibleHistory = expanded
    ? history
    : history.slice(0, COLLAPSED_HISTORY_COUNT);
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
          disabled={pending || cooldown}
          onClick={() => void runOneTap("log")}
          data-testid={`substance-log-${substance}`}
          className="btn"
        >
          {pending ? "Logging…" : def.logLabel}
        </button>
        <button
          type="button"
          disabled={pending || cooldown || weekCount === 0}
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
            <ResponsiveTable className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-black/10 text-xs text-slate-500 dark:border-white/10 dark:text-slate-400">
                  <th className="px-2 py-1.5 font-medium">Date</th>
                  <th className="px-2 py-1.5 font-medium">Amount</th>
                  <th className="px-2 py-1.5 font-medium">Notes</th>
                  <th className="w-16 px-2 py-1.5 text-right font-medium">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleHistory.map((entry) => (
                  <tr
                    key={entry.id}
                    data-testid={`substance-history-row-${substance}-${entry.id}`}
                    className="border-b border-black/5 align-top last:border-0 dark:border-white/5"
                  >
                    {editingId === entry.id ? (
                      <Td slot="full" colSpan={4} className="px-2 py-2">
                        <form
                          className="grid gap-3 sm:grid-cols-2"
                          onSubmit={(event) => void editEntry(event, entry)}
                        >
                          <HistoryFields
                            entry={entry}
                            defaultDate={defaultDate}
                          />
                          <div className="flex gap-2 sm:col-span-2">
                            <button
                              type="submit"
                              className="btn"
                              disabled={pending}
                              data-testid={`substance-history-save-${substance}`}
                            >
                              {pending ? "Saving…" : "Save"}
                            </button>
                            <button
                              type="button"
                              className="btn-ghost"
                              onClick={() => setEditingId(null)}
                            >
                              Cancel
                            </button>
                          </div>
                        </form>
                      </Td>
                    ) : (
                      <>
                        <Td slot="title" className="px-2 py-2 tabular-nums">
                          {formatDateWithYear(entry.date, formatPrefs)}
                        </Td>
                        <Td slot="value" label="Amount" className="px-2 py-2">
                          {entry.amount}{" "}
                          {entry.amount === 1
                            ? def.unitSingular
                            : def.unitPlural}
                        </Td>
                        <Td
                          slot="meta"
                          label="Notes"
                          empty={!entry.notes}
                          className="max-w-sm px-2 py-2 text-slate-500 dark:text-slate-400"
                        >
                          {entry.notes ? (
                            <NotesText notes={entry.notes} />
                          ) : (
                            "—"
                          )}
                        </Td>
                        <Td slot="actions" className="px-2 py-2">
                          <div className="flex justify-end">
                            <OverflowMenu
                              label={`${def.label} entry actions`}
                              open={rowMenuOpen === entry.id}
                              onOpenChange={(open) =>
                                setRowMenuOpen(open ? entry.id : null)
                              }
                            >
                              {({ close }) => (
                                <>
                                  <button
                                    type="button"
                                    role="menuitem"
                                    className={MENU_ITEM}
                                    data-testid={`substance-history-edit-${substance}-${entry.id}`}
                                    onClick={() => {
                                      close();
                                      setEditingId(entry.id);
                                    }}
                                  >
                                    Edit
                                  </button>
                                  <button
                                    type="button"
                                    role="menuitem"
                                    className={MENU_ITEM_DANGER}
                                    data-testid={`substance-history-delete-${substance}-${entry.id}`}
                                    onClick={() => {
                                      close();
                                      void removeEntry(entry);
                                    }}
                                  >
                                    Delete
                                  </button>
                                </>
                              )}
                            </OverflowMenu>
                          </div>
                        </Td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </ResponsiveTable>
            {history.length > COLLAPSED_HISTORY_COUNT ? (
              <button
                type="button"
                className="mt-2 text-sm font-medium text-brand-700 hover:underline dark:text-brand-300"
                aria-expanded={expanded}
                onClick={() => setExpanded((value) => !value)}
                data-testid={`substance-history-toggle-${substance}`}
              >
                {expanded
                  ? "Show fewer entries"
                  : `View all ${history.length} entries`}
              </button>
            ) : null}
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
