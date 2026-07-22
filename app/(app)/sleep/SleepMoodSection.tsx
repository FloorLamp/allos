"use client";

import { useState } from "react";
import Link from "next/link";
import { IconPencil } from "@tabler/icons-react";
import PaginationControls from "@/components/PaginationControls";
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
  type SleepStageMinutes,
  type SleepMoodHistoryRow,
  type SleepMoodPoint,
} from "@/lib/sleep-summary";
import { describeCorrelation, pearson } from "@/lib/trends-compare";
import SleepMoodEditDialog from "./SleepMoodEditDialog";
import BedtimeSupplementStatus from "./BedtimeSupplementStatus";

// A two- or three-dot scatter plot exaggerates coincidence and produces an
// unstable Pearson coefficient. Five paired nights is the minimum for the plot;
// the factual history table below is always available.
const MIN_SLEEP_MOOD_SCATTER_POINTS = 5;
const HISTORY_PAGE_SIZE = 10;
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
  windowDays,
  formatPrefs,
}: {
  points: SleepMoodPoint[];
  history: SleepMoodHistoryRow[];
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
  const newestFirst = [...history].reverse();
  const pageCount = Math.max(
    1,
    Math.ceil(newestFirst.length / HISTORY_PAGE_SIZE)
  );
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
      data-history-count={history.length}
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
            Sleep and Mood Log
          </h2>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            Past {windowDays} days
          </span>
        </div>
        <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
          All available sleep, stage, and mood entries
          {hasSupplementContext ? ", with bedtime supplement context" : ""},
          newest first. A dash means that value was not logged or did not apply.
          {!canPlot && points.length > 0
            ? ` Add ${MIN_SLEEP_MOOD_SCATTER_POINTS - points.length} more paired days to unlock the relationship plot.`
            : ""}
        </p>
        <div className="card overflow-hidden p-0">
          <ScrollFade data-testid="sleep-history-scroll-fade">
            <table
              className={`w-full min-w-[22rem] text-left text-sm ${
                hasSupplementContext ? "sm:min-w-[60rem]" : "sm:min-w-[52rem]"
              }`}
              data-testid="sleep-mood-history"
            >
              <thead className="bg-slate-50 text-xs text-slate-500 dark:bg-ink-800 dark:text-slate-400">
                <tr>
                  <th scope="col" className="px-2 py-2 font-medium sm:px-3">
                    Date
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium sm:px-3">
                    Sleep
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium sm:px-3">
                    Mood
                  </th>
                  {hasSupplementContext && (
                    <th
                      scope="col"
                      className="hidden whitespace-nowrap px-3 py-2 font-medium sm:table-cell"
                    >
                      Supplements
                    </th>
                  )}
                  {STAGE_COLUMNS.map((column) => (
                    <th
                      key={column.key}
                      scope="col"
                      className={`hidden px-3 py-2 font-medium sm:table-cell ${
                        column.key === "deep"
                          ? "sm:border-l sm:border-slate-200 dark:sm:border-slate-700"
                          : ""
                      }`}
                    >
                      {column.label}
                    </th>
                  ))}
                  <th
                    scope="col"
                    className="px-2 py-2 text-right font-medium sm:px-3"
                  >
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {pageRows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={
                        4 +
                        STAGE_COLUMNS.length +
                        (hasSupplementContext ? 1 : 0)
                      }
                      className="px-3 py-6 text-center text-slate-500 dark:text-slate-400"
                      data-testid="sleep-mood-history-empty"
                    >
                      No sleep, stage, or mood entries in the past {windowDays}
                      days.
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
                      <td className="whitespace-nowrap px-2 py-2 sm:px-3">
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
                      <td className="whitespace-nowrap px-2 py-2 text-slate-700 sm:px-3 dark:text-slate-200">
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
                      <td className="whitespace-nowrap px-2 py-2 text-slate-700 sm:px-3 dark:text-slate-200">
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
                        <td className="hidden whitespace-nowrap px-3 py-2 sm:table-cell">
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
                          className={`hidden whitespace-nowrap px-3 py-2 text-slate-700 sm:table-cell dark:text-slate-200 ${
                            column.key === "deep"
                              ? "sm:border-l sm:border-slate-200 dark:sm:border-slate-700"
                              : ""
                          }`}
                          data-testid={`sleep-stage-${column.key}`}
                        >
                          {row.stages == null
                            ? "—"
                            : formatHm(row.stages[column.key])}
                        </td>
                      ))}
                      <td className="whitespace-nowrap px-2 py-2 text-right sm:px-3">
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
                          onClick={() => setEditing(row)}
                          aria-label={`Edit sleep and mood for ${formatLongDate(row.date, formatPrefs)}`}
                          data-testid="sleep-mood-history-edit"
                        >
                          <IconPencil
                            className="h-3.5 w-3.5"
                            stroke={1.75}
                            aria-hidden
                          />
                          Edit
                        </button>
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
