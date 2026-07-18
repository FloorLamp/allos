"use client";

import { Fragment, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import OverflowMenu, {
  MENU_ITEM,
  MENU_ITEM_DANGER,
} from "@/components/OverflowMenu";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { useUndoableDelete } from "@/components/useUndoableDelete";
import FeverChart from "@/components/illness/FeverChart";
import {
  illnessTimelineEvents,
  relativeEpisodeDateLabel,
  type AssembledEpisode,
  type IllnessTimelineEvent,
} from "@/lib/illness-episode-format";
import {
  groupIllnessTimelineEvents,
  type IllnessTimelineDisplayEvent,
} from "@/lib/illness-timeline-view";
import type { EpisodeInRangeEvents } from "@/lib/illness-episode-events";
import NotesText from "@/components/NotesText";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import ScrollFade from "@/components/ScrollFade";
import {
  deleteEpisodeDoseAction,
  deleteEpisodeTemperatureAction,
  updateEpisodeDoseAction,
  updateEpisodeSymptomAction,
  updateEpisodeTemperatureAction,
} from "@/app/(app)/medical/episodes/actions";
import type { TemperatureUnit } from "@/lib/settings";
import { degFTo, fmtTemp } from "@/lib/units";
import { MAX_SYMPTOM_SEVERITY, severityLabel } from "@/lib/symptoms";
import { medicationHref } from "@/lib/hrefs";
import {
  formatClockValue,
  formatDateShape,
  type DisplayFormatPrefs,
} from "@/lib/format-date";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { useTemperatureUnitDetection } from "@/components/useTemperatureUnitDetection";

function TemperatureEditorField({
  inputId,
  degF,
  preferredUnit,
}: {
  inputId: string;
  degF: number;
  preferredUnit: TemperatureUnit;
}) {
  const initialValue = String(degFTo(degF, preferredUnit));
  const detection = useTemperatureUnitDetection(preferredUnit, initialValue);
  return (
    <div className="min-w-0">
      <label className="label mb-0" htmlFor={`episode-event-value-${inputId}`}>
        Temperature
      </label>
      <div className="mt-1 flex gap-2">
        <input
          id={`episode-event-value-${inputId}`}
          className="input min-w-0 flex-1"
          type="number"
          name="value"
          step="0.1"
          required
          defaultValue={initialValue}
          onChange={(event) => detection.readValue(event.target.value)}
        />
        <select
          name="unit"
          aria-label="Temperature unit"
          value={detection.unit}
          onChange={(event) =>
            detection.chooseUnit(event.target.value === "C" ? "C" : "F")
          }
          className="input w-auto"
        >
          <option value="F">°F</option>
          <option value="C">°C</option>
        </select>
      </div>
      {detection.detectedUnit && (
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Detected °{detection.detectedUnit} from the reading.
        </p>
      )}
    </div>
  );
}

function fmtDate(date: string, prefs: DisplayFormatPrefs): string {
  const parsed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!parsed) return date;
  return formatDateShape(prefs.dateFormat, +parsed[1], +parsed[2], +parsed[3], {
    monthStyle: "short",
    year: true,
  });
}

function keyFor(event: IllnessTimelineDisplayEvent): string {
  return `${event.kind}:${event.id}`;
}

function isEpisodeEvent(
  event: IllnessTimelineDisplayEvent
): event is IllnessTimelineEvent {
  return ["temperature", "medication", "symptom"].includes(event.kind);
}

function dayLabel(
  date: string,
  episode: Pick<AssembledEpisode, "ongoing" | "asOf">,
  prefs: DisplayFormatPrefs
): string {
  const relative = episode.ongoing
    ? relativeEpisodeDateLabel(date, episode.asOf)
    : null;
  return relative
    ? `${relative} · ${fmtDate(date, prefs)}`
    : fmtDate(date, prefs);
}

type TimelineFilter =
  "all" | "symptoms" | "temperature" | "medications" | "care";

const TIMELINE_FILTERS: { value: TimelineFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "symptoms", label: "Symptoms" },
  { value: "temperature", label: "Temperature" },
  { value: "medications", label: "Meds" },
  { value: "care", label: "Care" },
];

function matchesFilter(
  event: IllnessTimelineDisplayEvent,
  filter: TimelineFilter
): boolean {
  if (filter === "all") return true;
  if (filter === "symptoms") return event.kind === "symptom";
  if (filter === "temperature") return event.kind === "temperature";
  if (filter === "medications")
    return event.kind === "medication" || event.kind === "course";
  return ["encounter", "appointment", "document"].includes(event.kind);
}

export default function EpisodeTimeline({
  episode,
  canEdit = false,
  temperatureUnit = "F",
  profileId,
  careEvents,
  actions,
  tools,
  afterHistory,
}: {
  episode: AssembledEpisode;
  canEdit?: boolean;
  temperatureUnit?: TemperatureUnit;
  profileId?: number;
  careEvents?: EpisodeInRangeEvents;
  actions?: ReactNode;
  tools?: ReactNode;
  afterHistory?: ReactNode;
}) {
  const formatPrefs = useFormatPrefs();
  const episodeEvents = illnessTimelineEvents(episode);
  const groups = groupIllnessTimelineEvents(episodeEvents, careEvents);
  const eventCount = groups.reduce(
    (sum, group) => sum + group.events.length,
    0
  );
  const router = useRouter();
  const toast = useToast();
  const undoableDelete = useUndoableDelete();
  const confirm = useConfirm();
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<TimelineFilter>("all");
  const [showEarlierHistory, setShowEarlierHistory] = useState(false);
  const availableFilters = TIMELINE_FILTERS.filter(
    ({ value }) =>
      value === "all" ||
      groups.some((group) =>
        group.events.some((event) => matchesFilter(event, value))
      )
  );
  const filteredGroups = groups
    .map((group) => ({
      ...group,
      events: group.events.filter((event) => matchesFilter(event, filter)),
    }))
    .filter((group) => group.events.length > 0);
  const earlierGroupCount = Math.max(0, filteredGroups.length - 2);

  if (eventCount === 0 && !actions && !tools) return null;

  async function save(event: IllnessTimelineEvent, formData: FormData) {
    if (episode.id == null) return;
    formData.set("episodeId", String(episode.id));
    formData.set("eventId", String(event.id));
    if (profileId != null) formData.set("profileId", String(profileId));
    const result =
      event.kind === "temperature"
        ? await updateEpisodeTemperatureAction(formData)
        : event.kind === "symptom"
          ? await updateEpisodeSymptomAction(formData)
          : await updateEpisodeDoseAction(formData);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setEditing(null);
    toast(
      event.kind === "temperature"
        ? "Temperature updated."
        : event.kind === "symptom"
          ? "Symptom updated."
          : "Dose updated."
    );
    router.refresh();
  }

  async function remove(event: IllnessTimelineEvent) {
    if (event.kind === "symptom") return;
    const fd = new FormData();
    if (episode.id != null) fd.set("episodeId", String(episode.id));
    fd.set("eventId", String(event.id));
    if (profileId != null) fd.set("profileId", String(profileId));
    await undoableDelete(
      event.kind === "temperature"
        ? deleteEpisodeTemperatureAction
        : deleteEpisodeDoseAction,
      fd,
      {
        deletedMessage:
          event.kind === "temperature"
            ? "Temperature deleted."
            : "Dose deleted.",
      }
    );
  }

  function editable(event: IllnessTimelineDisplayEvent): boolean {
    if (!canEdit || episode.id == null || !isEpisodeEvent(event)) return false;
    return event.kind === "symptom" || typeof event.id === "number";
  }

  function eventDetail(event: IllnessTimelineDisplayEvent) {
    if (event.kind === "medication" && !event.amount && editable(event)) {
      return (
        <button
          type="button"
          className="text-xs font-medium text-slate-500 underline decoration-dotted underline-offset-2 hover:text-brand-600 dark:text-slate-400 dark:hover:text-brand-400"
          onClick={() => {
            setError(null);
            setEditing(keyFor(event));
          }}
        >
          Add amount
        </button>
      );
    }
    if (event.kind === "medication") {
      return <span data-testid="illness-medication-dose">{event.detail}</span>;
    }
    const content = (
      <>
        <span>
          {event.kind === "temperature"
            ? fmtTemp(event.degF, temperatureUnit)
            : event.detail}
        </span>
        {event.kind === "symptom" && event.note ? (
          <NotesText
            as="span"
            notes={event.note}
            className="mt-0.5 block text-xs font-normal text-slate-500 dark:text-slate-400"
          />
        ) : null}
      </>
    );
    return "href" in event && event.href ? (
      <Link
        href={event.href}
        className="text-brand-600 hover:underline dark:text-brand-400"
      >
        {content}
      </Link>
    ) : (
      content
    );
  }

  function eventLabel(event: IllnessTimelineDisplayEvent) {
    return event.kind === "medication" ? (
      <Link
        href={medicationHref(event.itemId)}
        className="text-brand-600 hover:underline dark:text-brand-400"
      >
        {event.label}
      </Link>
    ) : (
      event.label
    );
  }

  function eventMenu(event: IllnessTimelineDisplayEvent) {
    if (!editable(event) || !isEpisodeEvent(event)) return null;
    const key = keyFor(event);
    return (
      <OverflowMenu
        label={`Actions for ${event.label} on ${fmtDate(event.date, formatPrefs)}`}
        open={openMenu === key}
        onOpenChange={(open) => setOpenMenu(open ? key : null)}
      >
        {({ close }) => (
          <>
            <button
              type="button"
              className={MENU_ITEM}
              onClick={() => {
                close();
                setError(null);
                setEditing(key);
              }}
            >
              Edit
            </button>
            {event.kind !== "symptom" && (
              <button
                type="button"
                className={MENU_ITEM_DANGER}
                onClick={async () => {
                  close();
                  const noun =
                    event.kind === "temperature"
                      ? "temperature reading"
                      : "dose";
                  const ok = await confirm({
                    title: `Delete ${noun}?`,
                    message:
                      "This removes it from the illness timeline and its original history.",
                    confirmLabel: "Delete",
                    danger: true,
                  });
                  if (ok) await remove(event);
                }}
              >
                Delete
              </button>
            )}
          </>
        )}
      </OverflowMenu>
    );
  }

  function eventEditor(event: IllnessTimelineEvent) {
    const inputId = String(event.id).replace(/[^a-zA-Z0-9_-]/g, "-");
    return (
      <form action={(fd) => save(event, fd)} className="space-y-3">
        {event.kind === "symptom" ? (
          <div className="grid gap-3 sm:grid-cols-[minmax(9rem,0.7fr)_minmax(14rem,1.3fr)]">
            <input type="hidden" name="date" value={event.date} />
            <input type="hidden" name="symptom" value={event.symptom} />
            <div>
              <label
                className="label mb-0"
                htmlFor={`episode-symptom-severity-${inputId}`}
              >
                Severity
              </label>
              <select
                id={`episode-symptom-severity-${inputId}`}
                name="severity"
                defaultValue={event.severity}
                className="input mt-1 w-full"
              >
                {Array.from(
                  { length: MAX_SYMPTOM_SEVERITY },
                  (_, index) => index + 1
                ).map((severity) => (
                  <option key={severity} value={severity}>
                    {severity} — {severityLabel(severity)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                className="label mb-0"
                htmlFor={`episode-symptom-note-${inputId}`}
              >
                Note
              </label>
              <input
                id={`episode-symptom-note-${inputId}`}
                name="note"
                defaultValue={event.note ?? ""}
                maxLength={500}
                placeholder="Optional context"
                className="input mt-1 w-full"
              />
            </div>
          </div>
        ) : (
          <div className="grid items-end gap-3 sm:grid-cols-[minmax(18rem,2fr)_minmax(9rem,1fr)]">
            <div
              className="grid min-w-0 grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] gap-2"
              data-testid="illness-event-date-time"
            >
              <div className="min-w-0">
                <label
                  className="label mb-0"
                  htmlFor={`episode-event-date-${inputId}`}
                >
                  Date
                </label>
                <div className="mt-1">
                  <DateField
                    id={`episode-event-date-${inputId}`}
                    name="date"
                    required
                    defaultValue={event.date}
                    min={episode.firstDay ?? undefined}
                    max={episode.lastActiveDay ?? undefined}
                    inputClassName="w-full min-w-0"
                  />
                </div>
              </div>
              <div className="min-w-0">
                <label
                  className="label mb-0"
                  htmlFor={`episode-event-time-${inputId}`}
                >
                  Time
                </label>
                <input
                  id={`episode-event-time-${inputId}`}
                  className="input mt-1 w-full min-w-0"
                  type="time"
                  name="time"
                  required
                  defaultValue={event.time24 ?? ""}
                />
              </div>
            </div>
            {event.kind === "temperature" ? (
              <TemperatureEditorField
                inputId={inputId}
                degF={event.degF}
                preferredUnit={temperatureUnit}
              />
            ) : (
              <div className="min-w-0">
                <label
                  className="label mb-0"
                  htmlFor={`episode-event-amount-${inputId}`}
                >
                  Amount
                </label>
                <input
                  id={`episode-event-amount-${inputId}`}
                  className="input mt-1 w-full"
                  name="amount"
                  defaultValue={event.amount ?? ""}
                  placeholder="e.g. 200 mg"
                />
              </div>
            )}
          </div>
        )}
        {error && (
          <p className="text-sm text-rose-600" role="alert">
            {error}
          </p>
        )}
        <div
          className="flex items-center justify-end gap-2 border-t border-black/5 pt-3 dark:border-white/5"
          data-testid="illness-event-editor-actions"
        >
          <button
            className="btn-ghost btn-sm"
            type="button"
            onClick={() => {
              setEditing(null);
              setError(null);
            }}
          >
            Cancel
          </button>
          <SubmitButton className="btn btn-sm" pendingLabel="Saving…">
            Save
          </SubmitButton>
        </div>
      </form>
    );
  }

  return (
    <section
      className="card break-inside-avoid print:border print:border-slate-300 print:shadow-none"
      data-testid="episode-illness-timeline"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
            Illness timeline
          </h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Add an update or review symptoms, temperatures, doses, and related
            care by day.
          </p>
        </div>
        {actions ? (
          <div className="shrink-0 print:hidden">{actions}</div>
        ) : null}
      </div>

      {tools ? (
        <div
          className="mt-5 border-t border-black/5 pt-5 dark:border-white/5"
          data-testid="episode-update-workspace"
        >
          {tools}
        </div>
      ) : null}

      {eventCount === 0 ? (
        <p className="mt-5 border-t border-black/5 pt-5 text-sm text-slate-500 dark:border-white/5 dark:text-slate-400">
          No events have been logged for this episode yet.
        </p>
      ) : (
        <div className="mt-5 border-t border-black/5 pt-5 dark:border-white/5">
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
            History
          </h3>
          <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-500 dark:text-slate-400">
            {episode.temperatures.length > 0 && (
              <span
                data-testid="episode-fever"
                className="inline-flex items-center gap-1.5"
              >
                <span
                  aria-hidden="true"
                  className="text-rose-500 dark:text-rose-400"
                >
                  ●
                </span>
                Temperature
              </span>
            )}
            {episode.totalAdministrations > 0 && (
              <span
                data-testid="episode-meds"
                className="inline-flex items-center gap-1.5"
              >
                <span
                  aria-hidden="true"
                  className="text-violet-500 dark:text-violet-400"
                >
                  ◆
                </span>
                Medication
              </span>
            )}
          </div>
          {(episode.temperatures.length > 0 ||
            episode.totalAdministrations > 0) && (
            <div className="mt-3">
              <FeverChart
                temperatures={episode.temperatures}
                medications={episode.medications}
                temperatureUnit={temperatureUnit}
                formatPrefs={formatPrefs}
              />
            </div>
          )}

          {availableFilters.length > 2 && (
            <div
              role="group"
              aria-label="Filter illness history"
              className="mt-3 inline-flex max-w-full flex-wrap rounded-lg border border-black/10 p-0.5 text-xs font-medium dark:border-white/10"
              data-testid="illness-history-filters"
            >
              {availableFilters.map((option) => {
                const active = filter === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setFilter(option.value)}
                    className={`rounded-md px-2.5 py-1 transition ${
                      active
                        ? "bg-slate-100 text-slate-700 dark:bg-ink-800 dark:text-slate-100"
                        : "text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-ink-800"
                    }`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          )}

          {earlierGroupCount > 0 && (
            <button
              type="button"
              className="mt-3 text-xs font-medium text-brand-600 hover:underline sm:hidden print:hidden dark:text-brand-400"
              data-testid="illness-history-earlier-toggle"
              aria-expanded={showEarlierHistory}
              aria-controls="illness-history-events"
              onClick={() => setShowEarlierHistory((shown) => !shown)}
            >
              {showEarlierHistory
                ? "Hide earlier history"
                : `Show ${earlierGroupCount} earlier ${earlierGroupCount === 1 ? "day" : "days"}`}
            </button>
          )}

          {filteredGroups.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
              No {filter} events were recorded during this episode.
            </p>
          ) : (
            <ScrollFade
              className="mt-3 sm:overflow-x-visible"
              hideScrollbar
              data-testid="illness-timeline-table-wrap"
            >
              <table
                id="illness-history-events"
                className="block w-full text-left text-sm sm:table sm:table-fixed"
              >
                <thead className="hidden section-label border-b border-black/10 sm:table-header-group dark:border-white/10">
                  <tr>
                    <th className="w-[15%] pb-1.5 pr-2">Time</th>
                    <th className="w-[32%] pb-1.5 pr-2">Event</th>
                    <th className="pb-1.5 pr-2">Details</th>
                    {canEdit && (
                      <th className="w-10 pb-1.5">
                        <span className="sr-only">Actions</span>
                      </th>
                    )}
                  </tr>
                </thead>
                {filteredGroups.map((group, groupIndex) => {
                  const hiddenEarlierGroup =
                    groupIndex < earlierGroupCount && !showEarlierHistory;
                  return (
                    <tbody
                      key={group.date}
                      className={
                        hiddenEarlierGroup
                          ? "hidden sm:table-row-group print:table-row-group"
                          : "block sm:table-row-group"
                      }
                      data-mobile-earlier={
                        groupIndex < earlierGroupCount ? "true" : "false"
                      }
                    >
                      <tr className="block sm:table-row">
                        <th
                          colSpan={canEdit ? 4 : 3}
                          data-testid="illness-timeline-day"
                          className="block border-b border-black/10 bg-slate-50 px-2 py-1.5 text-left section-label sm:table-cell dark:border-white/10 dark:bg-ink-850"
                        >
                          {dayLabel(group.date, episode, formatPrefs)}
                        </th>
                      </tr>
                      {group.events.map((event) => {
                        const key = keyFor(event);
                        return (
                          <Fragment key={key}>
                            <tr
                              data-testid={`illness-event-${event.kind}`}
                              className="grid grid-cols-[4rem_minmax(0,1fr)_auto] gap-x-1.5 border-b border-black/5 py-2 sm:table-row sm:border-0 sm:py-0 dark:border-white/5"
                            >
                              <td className="row-span-2 block whitespace-nowrap px-2 align-top text-xs text-slate-500 sm:table-cell sm:px-0 sm:py-2 sm:pr-2 dark:text-slate-400">
                                {formatClockValue(
                                  event.time,
                                  formatPrefs.timeFormat,
                                  "—"
                                )}
                              </td>
                              <td className="block min-w-0 pr-1 align-top font-medium break-words text-slate-700 sm:table-cell sm:py-2 sm:pr-2 dark:text-slate-200">
                                {eventLabel(event)}
                              </td>
                              <td
                                className={
                                  event.kind === "temperature" &&
                                  event.flag === "high"
                                    ? "col-start-2 row-start-2 block min-w-0 pr-1 align-top font-semibold break-words text-rose-600 sm:table-cell sm:py-2 sm:pr-2 dark:text-rose-400"
                                    : "col-start-2 row-start-2 block min-w-0 pr-1 align-top break-words text-slate-600 sm:table-cell sm:py-2 sm:pr-2 dark:text-slate-300"
                                }
                              >
                                {eventDetail(event)}
                              </td>
                              {canEdit && (
                                <td className="row-span-2 block py-0 align-top sm:table-cell">
                                  {eventMenu(event)}
                                </td>
                              )}
                            </tr>
                            {editing === key && isEpisodeEvent(event) && (
                              <tr data-testid="illness-event-editor">
                                <td
                                  colSpan={canEdit ? 4 : 3}
                                  className="block bg-slate-50 px-3 py-3 sm:table-cell dark:bg-ink-950/40"
                                >
                                  {eventEditor(event)}
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  );
                })}
              </table>
            </ScrollFade>
          )}
        </div>
      )}

      {afterHistory ? (
        <div className="mt-5 border-t border-black/5 pt-5 dark:border-white/5">
          {afterHistory}
        </div>
      ) : null}
    </section>
  );
}
