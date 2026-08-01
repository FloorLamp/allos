"use client";

import { useState } from "react";
import type { NotifySchedule } from "@/lib/settings";
import type { NotificationKind } from "@/lib/notifications/types";
import {
  NOTIFICATION_KIND_REGISTRY,
  isSafetyKind,
  type NotificationKindEntry,
} from "@/lib/notifications/kinds";
import { serializeDisabledKinds } from "@/lib/notifications/home-assistant-core";
import { isPushDeliverableKind } from "@/lib/notifications/push-core";
import SaveStatus from "@/components/SaveStatus";
import { useSaveStatus } from "@/components/useSaveStatus";
import {
  saveNotificationPrefs,
  saveHomeAssistantNotifyKinds,
} from "../profile/actions";
import { savePushNotifyKinds, saveLoginTelegramNotifyKinds } from "../actions";

// The Schedule + Message kinds sections of the Notifications group page (#1462 §6).
//
// WHY ONE COMPONENT FOR TWO SECTIONS. Every per-kind enable and every slot time is
// one row of the profile's notify schedule, written by ONE action
// (saveNotificationPrefs → setNotifySchedule) that rewrites the whole schedule. Two
// independently-saving cards would each have to carry the other's values or wipe
// them, so the state lives here once and the two cards are two renderings of it.
//
// WHAT THIS REPLACED. A "Reminders & schedule" mega-card that carried per-kind
// toggles and times, PLUS a separate matrix that repeated the same kinds as rows —
// the same question answered by two controls. Now each kind is ONE row carrying its
// enable, its kind-specific config, and its channel routing, all driven by the shared
// kind registry.
//
// SEMANTICS ARE UNCHANGED. Safety kinds (dose, missed-dose escalation) keep exactly
// what they had: channel routing with a warning — never a block — when every
// configured channel is off. Nothing that was un-configurable became configurable.
//
// Saving follows the Settings convention (#794): profile-tier prefs autosave on
// change, and each channel cell writes to ITS channel's tier store through its own
// tier-correct action (#319) exactly as the old matrix did — Telegram and Web Push
// follow the LOGIN, Home Assistant follows the PROFILE.

type ChannelId = "telegram" | "push" | "ha";

type Column = {
  id: ChannelId;
  short: string;
  label: string;
  owner: string;
  configured: boolean;
};

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const SLOTS = ["Morning", "Midday", "Evening", "Bedtime"] as const;
const SLOT_FIELD: Record<(typeof SLOTS)[number], string> = {
  Morning: "supp_morning_hour",
  Midday: "supp_midday_hour",
  Evening: "supp_evening_hour",
  Bedtime: "supp_bedtime_hour",
};
const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function hourValue(h: number | null, auto: boolean): string {
  if (auto) return "auto";
  return h == null ? "" : String(h);
}

export default function NotificationPrefs({
  schedule,
  workoutSummary,
  foodTelegramEnabled,
  foodLoggingRelevant,
  moodCheckinEnabled,
  moodRecapEnabled,
  sleepDigestEnabled,
  wakeHour,
  telegramDisabled,
  pushDisabled,
  haDisabled,
  telegramConfigured,
  pushConfigured,
  haConfigured,
}: {
  schedule: NotifySchedule;
  workoutSummary: string;
  foodTelegramEnabled: boolean;
  foodLoggingRelevant: boolean;
  moodCheckinEnabled: boolean;
  moodRecapEnabled: boolean;
  sleepDigestEnabled: boolean;
  // The profile's typical wake hour (0-23) that "Auto" resolves to, or null when
  // there isn't enough sleep data yet (#1117).
  wakeHour: number | null;
  telegramDisabled: NotificationKind[];
  pushDisabled: NotificationKind[];
  haDisabled: NotificationKind[];
  telegramConfigured: boolean;
  pushConfigured: boolean;
  haConfigured: boolean;
}) {
  // ONE bag of form-field values keyed by the saveNotificationPrefs field name, so a
  // registry row renders and writes generically — adding a kind is a registry entry,
  // not a new piece of hand-wired state.
  const [values, setValues] = useState<Record<string, string>>(() => ({
    food_telegram_enabled: foodTelegramEnabled ? "1" : "0",
    mood_checkin_enabled: moodCheckinEnabled ? "1" : "0",
    mood_recap_enabled: moodRecapEnabled ? "1" : "0",
    digest_sleep_enabled: sleepDigestEnabled ? "1" : "0",
    supp_morning_hour: hourValue(
      schedule.supplementHours.Morning,
      schedule.morningAuto
    ),
    supp_midday_hour: hourValue(schedule.supplementHours.Midday, false),
    supp_evening_hour: hourValue(schedule.supplementHours.Evening, false),
    supp_bedtime_hour: hourValue(schedule.supplementHours.Bedtime, false),
    workout_enabled: schedule.workoutEnabled ? "1" : "0",
    digest_hour: hourValue(schedule.digestHour, schedule.digestAuto),
    recap_day:
      schedule.weeklyRecapDay == null ? "" : String(schedule.weeklyRecapDay),
    recap_hour: String(schedule.weeklyRecapHour ?? 9),
    milestones_enabled: schedule.milestonesEnabled ? "1" : "0",
    preventive_enabled: schedule.preventiveEnabled ? "1" : "0",
    waking_start_hour: String(schedule.wakingStartHour),
    waking_end_hour: String(schedule.wakingEndHour),
  }));

  const [disabled, setDisabled] = useState<
    Record<ChannelId, Set<NotificationKind>>
  >(() => ({
    telegram: new Set(telegramDisabled),
    push: new Set(pushDisabled),
    ha: new Set(haDisabled),
  }));
  const [routing, setRouting] = useState(false);
  const { pending, savedAt, error, save: runSave } = useSaveStatus();

  const autoLabel =
    wakeHour == null
      ? "Auto (wake time)"
      : `Auto (~${String(wakeHour).padStart(2, "0")}:00)`;

  function set(field: string, v: string) {
    const next = { ...values, [field]: v };
    setValues(next);
    runSave(async () => {
      const fd = new FormData();
      for (const [k, val] of Object.entries(next)) fd.set(k, val);
      await saveNotificationPrefs(fd);
    });
  }

  const columns: Column[] = [
    {
      id: "telegram",
      short: "Telegram",
      label: "Telegram",
      owner: "this login",
      configured: telegramConfigured,
    },
    {
      id: "push",
      short: "Push",
      label: "Web Push",
      owner: "this login",
      configured: pushConfigured,
    },
    {
      id: "ha",
      short: "HA",
      label: "Home Assistant",
      owner: "this profile",
      configured: haConfigured,
    },
  ];

  const saver: Record<ChannelId, (fd: FormData) => Promise<unknown>> = {
    telegram: saveLoginTelegramNotifyKinds,
    push: savePushNotifyKinds,
    ha: saveHomeAssistantNotifyKinds,
  };

  // A cell is a real toggle unless the channel inherently can't deliver the kind
  // (only push × food today). An unavailable cell is neither "on" nor a checkbox.
  function cellAvailable(channel: ChannelId, kind: NotificationKind): boolean {
    if (channel === "push") return isPushDeliverableKind(kind);
    return true;
  }

  function routes(channel: ChannelId, kind: NotificationKind): boolean {
    return !disabled[channel].has(kind);
  }

  async function toggleRoute(channel: ChannelId, kind: NotificationKind) {
    const next = new Set(disabled[channel]);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    setDisabled({ ...disabled, [channel]: next });
    setRouting(true);
    try {
      const fd = new FormData();
      fd.set("disabled_kinds", serializeDisabledKinds([...next]));
      await saver[channel](fd);
    } finally {
      setRouting(false);
    }
  }

  // Whether a safety kind will reach NO configured channel — the warn-never-block
  // case. A channel that can't deliver the kind or isn't configured doesn't count.
  function safetyUncovered(kind: NotificationKind): boolean {
    if (!isSafetyKind(kind)) return false;
    if (!columns.some((c) => c.configured)) return false;
    return !columns.some(
      (c) => c.configured && cellAvailable(c.id, kind) && routes(c.id, kind)
    );
  }

  // Whether the kind itself is on, which decides if its extras are offered.
  function kindEnabled(e: NotificationKindEntry): boolean {
    switch (e.control.type) {
      case "always":
        return true;
      case "toggle":
        return values[e.control.field] === "1";
      case "hour":
        return values[e.control.field] !== "";
      case "day-hour":
        return values[e.control.dayField] !== "";
    }
  }

  const rows = NOTIFICATION_KIND_REGISTRY.filter(
    (e) => !e.requiresFoodLogging || foodLoggingRelevant
  );

  return (
    <div className="space-y-6">
      {/* ---- Schedule: the slot times + quiet hours, nothing else. ---- */}
      <div className="card space-y-5" data-testid="notify-schedule">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-semibold text-slate-800 dark:text-slate-100">
            Schedule
          </h3>
          <SaveStatus pending={pending} savedAt={savedAt} error={error} />
        </div>
        <div>
          <label className="label">Reminder slots</label>
          <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
            Reminders go out on the hour, in this profile&rsquo;s timezone.
          </p>
          <div className="grid grid-cols-2 gap-3">
            {SLOTS.map((w) => {
              const field = SLOT_FIELD[w];
              return (
                <div key={w}>
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {w}
                  </span>
                  <select
                    value={values[field]}
                    onChange={(e) => set(field, e.target.value)}
                    className="input mt-1"
                    aria-label={`${w} reminder hour`}
                    data-testid={
                      w === "Morning" ? "supp-morning-hour" : undefined
                    }
                  >
                    <option value="">Off</option>
                    {/* The Morning slot can follow the profile's wake time (#1117). */}
                    {w === "Morning" && (
                      <option value="auto">{autoLabel}</option>
                    )}
                    {HOURS.map((i) => (
                      <option key={i} value={i}>
                        {String(i).padStart(2, "0")}:00
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
        </div>

        {/* Quiet hours (#450) — the waking window for non-urgent nudges on EVERY
            channel. Urgent medication reminders are never held by it. */}
        <div
          className="border-t border-black/5 pt-5 dark:border-white/5"
          data-testid="quiet-hours"
        >
          <label className="label">Quiet hours</label>
          <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
            Non-urgent nudges are only sent between these hours; urgent
            medication reminders are never held.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={values.waking_start_hour}
              onChange={(e) => set("waking_start_hour", e.target.value)}
              className="input sm:w-32"
              aria-label="Quiet hours start (nudges begin)"
              data-testid="waking-start-hour"
            >
              {HOURS.map((i) => (
                <option key={i} value={i}>
                  {String(i).padStart(2, "0")}:00
                </option>
              ))}
            </select>
            <span className="text-sm text-slate-500 dark:text-slate-400">
              to
            </span>
            <select
              value={values.waking_end_hour}
              onChange={(e) => set("waking_end_hour", e.target.value)}
              className="input sm:w-32"
              aria-label="Quiet hours end (nudges stop)"
              data-testid="waking-end-hour"
            >
              {HOURS.map((i) => (
                <option key={i} value={i}>
                  {String(i).padStart(2, "0")}:59
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* ---- Message kinds: ONE row per kind — enable, config, routing. ---- */}
      <div className="card space-y-4" data-testid="notification-kinds">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-semibold text-slate-800 dark:text-slate-100">
            Message kinds
          </h3>
          <SaveStatus pending={pending} savedAt={savedAt} error={error} />
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Turn a kind off, or keep it and choose which channels carry it.
        </p>

        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 border-b border-black/10 pb-2 text-xs font-medium text-slate-500 dark:border-white/10 dark:text-slate-400">
          <span>Kind</span>
          <span className="grid w-[7.5rem] grid-cols-3 gap-1 text-center sm:w-40">
            {columns.map((c) => (
              <span key={c.id} title={`${c.label} — ${c.owner}`}>
                {c.short}
                {!c.configured && (
                  <span className="block text-xs font-normal text-slate-500 dark:text-slate-400">
                    not set up
                  </span>
                )}
              </span>
            ))}
          </span>
        </div>

        <ul className="divide-y divide-black/5 dark:divide-white/5">
          {rows.map((e) => {
            const on = kindEnabled(e);
            const uncovered = safetyUncovered(e.kind);
            return (
              <li
                key={e.kind}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 py-3"
                data-testid={`kind-row-${e.kind}`}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    {e.control.type === "toggle" && (
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-brand-600"
                        checked={values[e.control.field] === "1"}
                        onChange={(ev) =>
                          set(
                            (e.control as { field: string }).field,
                            ev.target.checked ? "1" : "0"
                          )
                        }
                        aria-label={e.label}
                        data-testid={e.controlTestId ?? `kind-enable-${e.kind}`}
                      />
                    )}
                    <span className="text-sm font-medium text-slate-800 dark:text-slate-100">
                      {e.label}
                    </span>
                    {e.safety && (
                      <span className="badge bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                        Safety
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                    {e.kind === "workout"
                      ? `Sent on the usual training schedule — ${workoutSummary} — when behind on the weekly routine.`
                      : e.blurb}
                  </p>

                  {e.control.type === "hour" && (
                    <select
                      value={values[e.control.field]}
                      onChange={(ev) =>
                        set(
                          (e.control as { field: string }).field,
                          ev.target.value
                        )
                      }
                      className="input mt-2 sm:w-56"
                      aria-label={`${e.label} hour`}
                      data-testid={e.controlTestId ?? `kind-hour-${e.kind}`}
                    >
                      <option value="">Off</option>
                      {e.control.auto && (
                        <option value="auto">{autoLabel}</option>
                      )}
                      {HOURS.map((i) => (
                        <option key={i} value={i}>
                          {String(i).padStart(2, "0")}:00
                        </option>
                      ))}
                    </select>
                  )}

                  {e.control.type === "day-hour" && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <select
                        value={values[e.control.dayField]}
                        onChange={(ev) =>
                          set(
                            (e.control as { dayField: string }).dayField,
                            ev.target.value
                          )
                        }
                        className="input sm:w-40"
                        aria-label={`${e.label} day`}
                        data-testid={e.controlTestId ?? `kind-day-${e.kind}`}
                      >
                        <option value="">Off</option>
                        {WEEKDAYS.map((d, i) => (
                          <option key={d} value={i}>
                            {d}
                          </option>
                        ))}
                      </select>
                      {on && (
                        <select
                          value={values[e.control.hourField]}
                          onChange={(ev) =>
                            set(
                              (e.control as { hourField: string }).hourField,
                              ev.target.value
                            )
                          }
                          className="input sm:w-32"
                          aria-label={`${e.label} hour`}
                        >
                          {HOURS.map((i) => (
                            <option key={i} value={i}>
                              {String(i).padStart(2, "0")}:00
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  )}

                  {on &&
                    e.extras?.map((x) => (
                      <label
                        key={x.field}
                        className="mt-2 flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300"
                      >
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-brand-600"
                          checked={values[x.field] === "1"}
                          onChange={(ev) =>
                            set(x.field, ev.target.checked ? "1" : "0")
                          }
                          data-testid={x.testId}
                        />
                        {x.label}
                      </label>
                    ))}

                  {/* §7: the long explanation lives behind a compact disclosure
                      instead of a 2–4 line paragraph under the control. */}
                  {e.more && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200">
                        More
                      </summary>
                      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                        {e.more}
                      </p>
                    </details>
                  )}

                  {uncovered && (
                    <p
                      className="mt-1 text-xs text-rose-600 dark:text-rose-400"
                      data-testid={`kind-safety-warning-${e.kind}`}
                    >
                      No channel will deliver this &mdash; it&rsquo;s a safety
                      reminder.
                    </p>
                  )}
                </div>

                <div className="grid w-[7.5rem] shrink-0 grid-cols-3 gap-1 pt-1 text-center sm:w-40">
                  {columns.map((c) => {
                    const available = cellAvailable(c.id, e.kind);
                    return available ? (
                      <input
                        key={c.id}
                        type="checkbox"
                        className="mx-auto h-4 w-4 accent-brand-600"
                        checked={routes(c.id, e.kind)}
                        disabled={routing}
                        onChange={() => toggleRoute(c.id, e.kind)}
                        data-testid={`matrix-cell-${c.id}-${e.kind}`}
                        aria-label={`${e.label} to ${c.label}`}
                      />
                    ) : (
                      <span
                        key={c.id}
                        className="text-slate-300 dark:text-slate-600"
                        title="Web Push can’t deliver this button-only reminder."
                        data-testid={`matrix-unavailable-${c.id}-${e.kind}`}
                      >
                        &mdash;
                      </span>
                    );
                  })}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
