"use client";
import { useLoggedViaStamp } from "@/components/LoggedViaSurface";

import { useState, type FormEvent } from "react";
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
import InlineError from "@/components/InlineError";
import SubstanceForm from "@/components/substances/SubstanceForm";
import SubstanceUnitControl from "@/components/substances/SubstanceUnitControl";
import { EmptyState } from "@/components/ui";
import {
  formatDateWithYear,
  formatMonthDay,
  type DisplayFormatPrefs,
} from "@/lib/format-date";
import type { SubstanceDailyTotal, SubstanceTrendWeek } from "@/lib/queries";
import {
  MAX_WEEKLY_CAP,
  substanceDef,
  type SubstanceKey,
} from "@/lib/substance-use";
import {
  clearSubstanceTargetAction,
  deleteSubstanceDailyTotalAction,
  setSubstanceTargetAction,
} from "./actions";
import Disclosure from "@/components/Disclosure";
import SubmitButton from "@/components/SubmitButton";
import Link from "next/link";

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
  substance: SubstanceKey;
  weekCount: number;
  capSet: boolean;
  cap: number | null;
  capProgress: string | null;
  capAttention: boolean;
  history: SubstanceDailyTotal[];
  trend: SubstanceTrendWeek[];
  defaultDate: string;
  formatPrefs: DisplayFormatPrefs;
}) {
  const def = substanceDef(substance);
  const confirm = useConfirm();
  // The Records page's own consumption section — declared, not assumed (#3087):
  // the shared pieces post the same actions from the quick-log sheet and the record.
  const stampLoggedVia = useLoggedViaStamp();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cardMenuOpen, setCardMenuOpen] = useState(false);
  const [capOpen, setCapOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [capInput, setCapInput] = useState(cap != null ? String(cap) : "");

  function withSubstance(extra?: Record<string, string>): FormData {
    const fd = stampLoggedVia(new FormData());
    fd.set("substance", substance);
    for (const [key, value] of Object.entries(extra ?? {})) fd.set(key, value);
    return fd;
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

  const historyColumns: EntryHistoryColumn<SubstanceDailyTotal>[] = [
    {
      header: "Date",
      slot: "title",
      cellClassName: "tabular-nums",
      cell: (entry) => formatDateWithYear(entry.date, formatPrefs),
    },
    {
      // A substance day IS its amount, so that is what stays on the phone's head
      // line beside the date (#3671); the note is the detail behind the tap.
      header: "Amount",
      slot: "trailing",
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
        </div>
        <OverflowMenu
          itemName={def.label}
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

      {/* The domain's one row control (#4424), also mounted by the quick-log sheet. */}
      <SubstanceUnitControl
        substance={substance}
        weekCount={weekCount}
        capProgress={capProgress}
        capAttention={capAttention}
        testIdPrefix="substance"
      />
      <button
        type="button"
        className="btn-ghost btn-sm self-start"
        data-testid={`substance-history-add-${substance}`}
        onClick={() => setAddOpen(true)}
      >
        Add for another day
      </button>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        {def.unitNote}
      </p>

      <InlineError>{error}</InlineError>

      <div>
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          History
        </h3>
        {history.length > 0 ? (
          // WHERE THE CORRECTION WENT, said once rather than left to be found. The
          // rows below are a day's rollup; each use is its own row in the record, with
          // its own time. Only where there ARE rows: on an empty card the sentence
          // names nothing.
          <p
            className="mt-1 text-xs text-slate-500 dark:text-slate-400"
            data-testid={`substance-history-correct-elsewhere-${substance}`}
          >
            Change a single {def.countSingular} on its own row in the{" "}
            <Link
              className="text-brand-700 hover:underline dark:text-brand-300"
              href={`/history?kind=substance&item=${substance}`}
            >
              record
            </Link>
            .
          </p>
        ) : null}
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
              menuKind={`${def.label} entry`}
              menuItemName={(entry) =>
                formatDateWithYear(entry.date, formatPrefs)
              }
              rowTestId={(entry) =>
                `substance-history-row-${substance}-${entry.id}`
              }
              deleteTestId={(entry) =>
                `substance-history-delete-${substance}-${entry.id}`
              }
              confirmDelete={() => ({
                title: `Delete ${def.label.toLowerCase()} entry?`,
                message: "This changes the weekly count and can be undone.",
                confirmLabel: "Delete entry",
              })}
              deleteFormData={(entry) =>
                withSubstance({ id: String(entry.id) })
              }
              deleteAction={deleteSubstanceDailyTotalAction}
              deletedMessage="Entry deleted."
            />
          </div>
        )}
      </div>

      <Disclosure className="text-sm">
        <summary className="fold-control text-slate-500 dark:text-slate-400">
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
              <div className="h-2 flex-1 rounded-sm bg-black/5 dark:bg-white/5">
                <div
                  className="h-2 rounded-sm bg-brand-400/70"
                  style={{ width: `${(week.count / maxTrend) * 100}%` }}
                />
              </div>
              <span className="w-6 text-right tabular-nums">{week.count}</span>
            </div>
          ))}
        </div>
      </Disclosure>

      {addOpen ? (
        <ModalShell
          title={`Add ${def.label.toLowerCase()} entry`}
          onClose={() => setAddOpen(false)}
          size="sm"
        >
          <SubstanceForm
            substances={[{ key: substance, label: def.label }]}
            date={defaultDate}
            maxDate={defaultDate}
            onSaved={() => setAddOpen(false)}
            onCancel={() => setAddOpen(false)}
            testId={`substance-history-add-form-${substance}`}
          />
        </ModalShell>
      ) : null}

      {capOpen ? (
        <ModalShell
          title={`${capSet ? "Change" : "Set"} ${def.label.toLowerCase()} weekly cap`}
          onClose={() => setCapOpen(false)}
          size="sm"
        >
          <form className="space-y-4" onSubmit={(event) => void saveCap(event)}>
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
              <SubmitButton
                variant="primary"
                disabled={pending || capInput === ""}
                data-testid={`substance-cap-save-${substance}`}
              >
                {pending ? "Saving…" : "Save cap"}
              </SubmitButton>
            </div>
          </form>
        </ModalShell>
      ) : null}
    </section>
  );
}
