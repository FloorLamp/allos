"use client";

import { useState } from "react";
import Link from "next/link";
import OverflowMenu, {
  MENU_ITEM,
  MENU_ITEM_DANGER,
} from "@/components/OverflowMenu";
import { useConfirm } from "@/components/ConfirmDialog";
import { useUndoableDelete } from "@/components/useUndoableDelete";
import PaginationControls from "@/components/PaginationControls";
import { HISTORY_PAGE_SIZE, pageCount as countPages } from "@/lib/pagination";
import ScatterChartCard from "@/components/ScatterChartCard";
import ScrollFade from "@/components/ScrollFade";
import { chartSeries } from "@/lib/chart-colors";
import {
  formatLongDate,
  formatMonthDay,
  type DisplayFormatPrefs,
} from "@/lib/format-date";
import { timelineDayHref } from "@/lib/hrefs";
import { moodFace, moodLabel } from "@/lib/mood";
import {
  formatHm,
  formatSleepWindow,
  type SleepStageMinutes,
  type SleepMoodHistoryRow,
  type SleepMoodPoint,
} from "@/lib/sleep-summary";
import { describeCorrelation, pearson } from "@/lib/trends-compare";
import { readingTargetToken } from "@/lib/reading-placement";
import SleepMoodEditDialog from "./SleepMoodEditDialog";
import BedtimeSupplementStatus from "./BedtimeSupplementStatus";
import { deleteSleepMoodRow } from "./actions";
import type { NapHistoryRow } from "@/lib/queries/sleep";

// A two- or three-dot scatter plot exaggerates coincidence and produces an
// unstable Pearson coefficient. Five paired nights is the minimum for the plot;
// the factual history table below is always available.
const MIN_SLEEP_MOOD_SCATTER_POINTS = 5;
const STAGE_COLUMNS: {
  key: keyof SleepStageMinutes;
  label: string;
}[] = [
  { key: "deep", label: "Deep" },
  { key: "rem", label: "REM" },
  { key: "light", label: "Light" },
  { key: "awake", label: "Awake" },
];

// Sleep↔mood pairing (issue #1066, the #992 observation rendered inline): nightly
// sleep and same-day mood are correlated through the existing Trends compare
// math. The relationship header sits outside its single chart surface, and the
// log header likewise sits outside the single table surface — no nested cards.
export default function SleepMoodSection({
  points,
  history,
  naps,
  windowDays,
  formatPrefs,
}: {
  points: SleepMoodPoint[];
  history: SleepMoodHistoryRow[];
  naps: NapHistoryRow[];
  windowDays: number;
  formatPrefs: DisplayFormatPrefs;
}) {
  const [requestedPage, setRequestedPage] = useState(1);
  const [editing, setEditing] = useState<SleepMoodHistoryRow | null>(null);
  const canPlot = points.length >= MIN_SLEEP_MOOD_SCATTER_POINTS;
  const hasSupplementContext = history.some(
    (row) => row.bedtimeSupplements != null
  );
  const scatter = points.map((point) => ({
    date: point.date,
    x: point.sleepHours,
    y: point.valence,
  }));
  const r = canPlot
    ? pearson(
        points.map((point) => ({
          date: point.date,
          a: point.sleepHours,
          b: point.valence,
        }))
      )
    : null;
  const correlation = describeCorrelation(r);
  const napsByDate = new Map<string, NapHistoryRow[]>();
  for (const nap of naps) {
    const day = napsByDate.get(nap.date);
    if (day) day.push(nap);
    else napsByDate.set(nap.date, [nap]);
  }
  const historyByDate = new Map(history.map((row) => [row.date, row]));
  for (const date of napsByDate.keys()) {
    if (historyByDate.has(date)) continue;
    historyByDate.set(date, {
      date,
      sleepHours: null,
      valence: null,
      moodDetails: null,
      stages: null,
      bedtimeSupplements: null,
      sleepEditable: true,
      sleepEditHours: null,
      sleepSampleId: null,
      moodLogId: null,
    });
  }
  const newestFirst = [...historyByDate.values()].sort((a, b) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : 0
  );
  // The record-history page size and its arithmetic are shared (lib/pagination.ts):
  // this table, the Trends body history and the dose ledger page the same way.
  const pageCount = countPages(newestFirst.length, HISTORY_PAGE_SIZE);
  const page = Math.min(requestedPage, pageCount);
  const pageRows = newestFirst.slice(
    (page - 1) * HISTORY_PAGE_SIZE,
    page * HISTORY_PAGE_SIZE
  );

  return (
    <div
      className="min-w-0 space-y-6"
      data-testid="sleep-mood-section"
      data-points={points.length}
      data-history-count={newestFirst.length}
    >
      {canPlot && (
        <section data-testid="sleep-mood">
          <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-semibold text-slate-800 dark:text-slate-100">
              Sleep and mood relationship
            </h2>
            <span
              className="text-xs text-slate-500 dark:text-slate-400"
              data-testid="sleep-mood-correlation"
            >
              {correlation && r != null
                ? `${correlation.label} · r = ${r.toFixed(2)}`
                : "No measurable correlation"}
            </span>
          </div>
          <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
            Each dot is one of {points.length} days with both readings. The
            correlation summarizes the relationship; it does not imply
            causation.
          </p>
          <div className="card">
            <ScatterChartCard
              data={scatter}
              xLabel="Sleep duration"
              yLabel="Mood"
              xUnit=" h"
              xDecimals={1}
              yDecimals={0}
              yDomain={[1, 5]}
              color={chartSeries.brand}
              heightClass="h-56"
            />
          </div>
        </section>
      )}

      <section data-testid="sleep-mood-log">
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-semibold text-slate-800 dark:text-slate-100">
            Sleep and mood log
          </h2>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            Past {windowDays} days
          </span>
        </div>
        <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
          All available main sleep, nap, stage, and mood entries
          {hasSupplementContext ? ", with bedtime supplement context" : ""},
          newest first. A dash means that value was not logged or did not apply.
          {!canPlot && points.length > 0
            ? ` Add ${MIN_SLEEP_MOOD_SCATTER_POINTS - points.length} more paired days to unlock the relationship plot.`
            : ""}
        </p>
        <div className="card overflow-hidden p-0">
          <ScrollFade data-testid="sleep-history-scroll-fade">
            <table
              className={`w-full min-w-120 text-left text-sm ${
                hasSupplementContext ? "sm:min-w-272" : "sm:min-w-240"
              }`}
              data-testid="sleep-mood-history"
            >
              <thead className="bg-slate-50 text-xs text-slate-500 dark:bg-ink-800 dark:text-slate-400">
                <tr>
                  <th scope="col" className="th">
                    Date
                  </th>
                  <th scope="col" className="th">
                    Sleep
                  </th>
                  <th scope="col" className="th">
                    Naps
                  </th>
                  <th scope="col" className="th">
                    Mood
                  </th>
                  {hasSupplementContext && (
                    <th
                      scope="col"
                      className="th hidden whitespace-nowrap sm:table-cell"
                    >
                      Supplements
                    </th>
                  )}
                  {STAGE_COLUMNS.map((column) => (
                    <th
                      key={column.key}
                      scope="col"
                      className={`th hidden sm:table-cell ${
                        column.key === "deep"
                          ? "sm:border-l sm:border-black/10 dark:sm:border-white/10"
                          : ""
                      }`}
                    >
                      {column.label}
                    </th>
                  ))}
                  <th scope="col" className="th text-right">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {pageRows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={
                        5 +
                        STAGE_COLUMNS.length +
                        (hasSupplementContext ? 1 : 0)
                      }
                      className="td py-6 text-center text-slate-500 dark:text-slate-400"
                      data-testid="sleep-mood-history-empty"
                    >
                      No sleep, nap, stage, or mood entries in the past{" "}
                      {windowDays} days.
                    </td>
                  </tr>
                ) : (
                  pageRows.map((row) => (
                    <tr
                      key={row.date}
                      data-testid="sleep-mood-history-row"
                      data-date={row.date}
                      data-sleep-editable={row.sleepEditable ? "true" : "false"}
                      className="tabular-nums"
                    >
                      <td className="td whitespace-nowrap">
                        <Link
                          href={timelineDayHref(row.date)}
                          className="font-medium text-brand-600 hover:underline dark:text-brand-400"
                        >
                          <span
                            className="sm:hidden"
                            data-testid="sleep-history-date-short"
                          >
                            {formatMonthDay(row.date, formatPrefs)}
                          </span>
                          <span
                            className="hidden sm:inline"
                            data-testid="sleep-history-date-long"
                          >
                            {formatLongDate(row.date, formatPrefs)}
                          </span>
                        </Link>
                      </td>
                      <td className="td whitespace-nowrap text-slate-700 dark:text-slate-200">
                        <span>
                          {row.sleepHours == null
                            ? "—"
                            : formatHm(Math.round(row.sleepHours * 60))}
                        </span>
                        {row.bedtimeSupplements && (
                          <div className="mt-0.5 sm:hidden">
                            <BedtimeSupplementStatus
                              summary={row.bedtimeSupplements}
                              prefix="Bedtime"
                              compact
                              labelMode="fraction"
                            />
                          </div>
                        )}
                      </td>
                      <td
                        className="td whitespace-nowrap text-slate-700 dark:text-slate-200"
                        data-testid="sleep-history-naps"
                      >
                        {(napsByDate.get(row.date) ?? []).length === 0
                          ? "—"
                          : (napsByDate.get(row.date) ?? []).map((nap) => (
                              <div
                                key={`${nap.startMinutes}:${nap.endMinutes}`}
                              >
                                {formatSleepWindow(
                                  formatPrefs.timeFormat,
                                  nap.startMinutes,
                                  nap.endMinutes
                                )}{" "}
                                · {formatHm(nap.durationMin)}
                              </div>
                            ))}
                      </td>
                      <td className="td whitespace-nowrap text-slate-700 dark:text-slate-200">
                        {row.valence == null ? (
                          "—"
                        ) : (
                          <>
                            <span aria-hidden>{moodFace(row.valence)}</span>{" "}
                            {moodLabel(row.valence)} ({row.valence}/5)
                          </>
                        )}
                      </td>
                      {hasSupplementContext && (
                        <td className="td hidden whitespace-nowrap sm:table-cell">
                          {row.bedtimeSupplements ? (
                            <BedtimeSupplementStatus
                              summary={row.bedtimeSupplements}
                              compact
                              labelMode="fraction"
                            />
                          ) : (
                            <span className="text-slate-500 dark:text-slate-400">
                              —
                            </span>
                          )}
                        </td>
                      )}
                      {STAGE_COLUMNS.map((column) => (
                        <td
                          key={column.key}
                          className={`td hidden whitespace-nowrap text-slate-700 sm:table-cell dark:text-slate-200 ${
                            column.key === "deep"
                              ? "sm:border-l sm:border-black/10 dark:sm:border-white/10"
                              : ""
                          }`}
                          data-testid={`sleep-stage-${column.key}`}
                        >
                          {row.stages == null
                            ? "—"
                            : formatHm(row.stages[column.key])}
                        </td>
                      ))}
                      <td className="td whitespace-nowrap text-right">
                        {/* Edit AND delete on the shared ⋯ menu (#2556). The row is
                            a UNION of up to two physical records, so each delete
                            names the one it removes — and each is offered only when
                            that record exists and this surface is allowed to remove
                            it. */}
                        <SleepMoodRowMenu
                          row={row}
                          dateLabel={formatLongDate(row.date, formatPrefs)}
                          onEdit={() => setEditing(row)}
                        />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </ScrollFade>
          <PaginationControls
            page={page}
            pageCount={pageCount}
            pageSize={HISTORY_PAGE_SIZE}
            total={newestFirst.length}
            visibleCount={pageRows.length}
            onPageChange={setRequestedPage}
            testId="sleep-mood-pagination"
          />
        </div>
      </section>
      {editing && (
        <SleepMoodEditDialog
          key={editing.date}
          mode="edit"
          row={editing}
          dateLabel={formatLongDate(editing.date, formatPrefs)}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

// One log line's row actions. Edit opens the existing dialog; each Delete names the
// physical record it removes and posts that row's own target token to the ONE
// per-reading delete contract (#2032) through the sleep action's gate.
//
// RENDERED FROM STATE, per the stateful-affordance rule: a night with no manual
// duration-only sample offers no sleep delete (an imported or windowed night is
// read-only here exactly as it is in the edit dialog), and a day with no check-in
// offers no mood delete. The menu therefore never presents a write that would refuse.
function SleepMoodRowMenu({
  row,
  dateLabel,
  onEdit,
}: {
  row: SleepMoodHistoryRow;
  dateLabel: string;
  onEdit: () => void;
}) {
  const confirm = useConfirm();
  const undoable = useUndoableDelete();
  const [open, setOpen] = useState(false);

  async function remove(
    target: string,
    prompt: { title: string; message: string; deleted: string }
  ) {
    const ok = await confirm({
      title: prompt.title,
      message: prompt.message,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    const fd = new FormData();
    fd.set("target", target);
    await undoable(deleteSleepMoodRow, fd, { deletedMessage: prompt.deleted });
  }

  return (
    <div className="flex items-center justify-end">
      <OverflowMenu
        label={`Actions for ${dateLabel}`}
        open={open}
        onOpenChange={setOpen}
      >
        {({ close }) => (
          <>
            <button
              type="button"
              role="menuitem"
              className={MENU_ITEM}
              data-testid="sleep-mood-history-edit"
              onClick={() => {
                onEdit();
                close();
              }}
            >
              Edit
            </button>
            {/* Close the menu BEFORE the confirm in every branch: a handler that
                returns without close() leaves the click-away backdrop shielding the
                whole page. */}
            {row.sleepSampleId != null && (
              <button
                type="button"
                role="menuitem"
                className={MENU_ITEM_DANGER}
                data-testid="sleep-history-delete-sleep"
                onClick={() => {
                  close();
                  void remove(
                    readingTargetToken({
                      store: "metric_samples",
                      id: row.sleepSampleId!,
                      metric: "sleep_min",
                    }),
                    {
                      title: "Delete sleep duration",
                      message: `Delete the manual sleep duration logged for ${dateLabel}? You can undo this.`,
                      deleted: "Sleep duration deleted.",
                    }
                  );
                }}
              >
                Delete sleep duration
              </button>
            )}
            {row.moodLogId != null && (
              <button
                type="button"
                role="menuitem"
                className={MENU_ITEM_DANGER}
                data-testid="sleep-history-delete-mood"
                onClick={() => {
                  close();
                  void remove(
                    readingTargetToken({
                      store: "mood",
                      id: row.moodLogId!,
                      series: "valence",
                    }),
                    {
                      title: "Delete mood check-in",
                      message: `Delete the mood check-in for ${dateLabel}? Its note and factors go with it. You can undo this.`,
                      deleted: "Mood check-in deleted.",
                    }
                  );
                }}
              >
                Delete mood check-in
              </button>
            )}
          </>
        )}
      </OverflowMenu>
    </div>
  );
}
