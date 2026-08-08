"use client";

import { useState } from "react";
import type { NotifySchedule } from "@/lib/settings";
import {
  formatNotifyTime,
  tickGridMinutes,
} from "@/lib/notifications/schedule";
import {
  describeDigestSchedule,
  DIGEST_DEFAULT_MINUTE,
  parseDigestMode,
  type ArrivalStatistics,
} from "@/lib/notifications/digest-schedule";
import type { NotificationKind } from "@/lib/notifications/types";
import {
  NOTIFICATION_KIND_REGISTRY,
  isSafetyKind,
  slotRequirementNote,
  unmetSlotRequirement,
  type NotificationKindEntry,
} from "@/lib/notifications/kinds";
import { serializeDisabledKinds } from "@/lib/notifications/home-assistant-core";
import {
  applyColumnBulk,
  columnBulkLabel,
  columnBulkState,
  nextColumnBulkTarget,
  sweepableKinds,
} from "@/lib/notifications/matrix-bulk";
import { isPushDeliverableKind } from "@/lib/notifications/push-core";
import { isEmailDeliverableKind } from "@/lib/notifications/email-core";
import type { DigestTimeSuggestion } from "@/lib/digest-time-suggestion";
import { formatClockMinutes, type TimeFormat } from "@/lib/format-date";
import DigestTimeSuggestionRow from "./DigestTimeSuggestion";
import SaveStatus from "@/components/SaveStatus";
import { useSaveStatus } from "@/components/useSaveStatus";
import {
  saveNotificationPrefs,
  saveHomeAssistantNotifyKinds,
} from "../profile/actions";
import {
  savePushNotifyKinds,
  saveLoginTelegramNotifyKinds,
  saveLoginEmailNotifyKinds,
} from "../actions";

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
//
// THE HA COLUMN IS THE ONE HA EDITOR (#1868 §1). The Home Assistant card above used to
// carry its own per-kind checkbox grid over the SAME `ha_notify_disabled_kinds` key —
// 26 checkboxes for 13 booleans on one page. That grid is gone; this column edits the
// key, exactly as the Telegram and Push columns edit theirs.
//
// COLUMN SELECT-ALL (#1868 §2). Each column header carries a tri-state bulk toggle
// over the keys that already exist. Its decision logic is pure and lives in
// lib/notifications/matrix-bulk.ts, including the rule that matters: SAFETY kinds are
// never swept, so a column "turn off" leaves dose/escalation/redose exactly as the user
// set them, individually. Row-level select-all is deliberately out.

type ChannelId = "telegram" | "push" | "ha" | "email";

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
// The fallback each slot's time input seeds when switched from Off to "At time"
// — the shared defaults (DEFAULT_INTAKE_REMINDER_MINUTES) as "HH:MM".
const SLOT_SEED: Record<string, string> = {
  supp_morning_hour: "08:00",
  supp_midday_hour: "13:00",
  supp_evening_hour: "20:00",
  supp_bedtime_hour: "22:00",
  digest_hour: formatNotifyTime(DIGEST_DEFAULT_MINUTE),
  recap_hour: "09:00",
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

// The stored/form value for a slot: "" (off), "auto", or "HH:MM" (#2121 minute
// grain — the same format the settings tier persists).
function timeValue(minute: number | null, auto: boolean): string {
  if (auto) return "auto";
  return minute == null ? "" : formatNotifyTime(minute);
}

// One schedule time control at minute grain (#2121): a mode select (Off /
// optional Auto / At time) beside a native time input once a concrete time is
// chosen. The single form value stays the persisted vocabulary — "" (off),
// "auto", or "HH:MM" — so the control writes exactly what the settings tier
// stores, through the same autosave-on-change path the old hour selects used.
// Switching to "At time" seeds the previous concrete time (or the slot's shared
// default) so the change saves a real value immediately; a cleared/incomplete
// time input is ignored rather than saved as off — Off is the select's job.
//
// `stepMinutes` is the grid of the scheduler's OBSERVED cadence (#2216,
// tickGridMinutes): it sets the native input's step so the spinner and quick
// options walk the minutes a tick can actually land on. GUIDANCE, NEVER
// VALIDATION: a typed off-grid time still fires onChange and is saved — nothing
// here submits a form or consults validity — and the sub-hourly warning names
// it rather than any control refusing it.
function TimeControl({
  value,
  onChange,
  autoOption,
  seed,
  stepMinutes,
  label,
  testId,
  selectClassName,
}: {
  value: string;
  onChange: (v: string) => void;
  autoOption: string | null;
  seed: string;
  stepMinutes: number;
  label: string;
  testId?: string;
  selectClassName?: string;
}) {
  const mode = value === "" ? "" : value === "auto" ? "auto" : "time";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={mode}
        onChange={(e) => {
          const m = e.target.value;
          if (m === "time") onChange(mode === "time" ? value : seed);
          else onChange(m);
        }}
        className={selectClassName ?? "input flex-1 basis-28"}
        aria-label={`${label} mode`}
        data-testid={testId}
      >
        <option value="">Off</option>
        {autoOption != null && <option value="auto">{autoOption}</option>}
        <option value="time">At time</option>
      </select>
      {mode === "time" && (
        <input
          type="time"
          value={value}
          step={stepMinutes * 60}
          onChange={(e) => {
            // An empty value is a half-edited input (or a cleared picker) — never
            // save it as "off"; the mode select owns Off.
            if (e.target.value !== "") onChange(e.target.value);
          }}
          className="input w-auto"
          aria-label={`${label} time`}
          data-testid={testId ? `${testId}-time` : undefined}
        />
      )}
    </div>
  );
}

// The morning digest's mode + time (#2211). THREE STATES, NO SENTINELS: Off, "Same
// time every day", "As soon as it's ready". Two stored fields — `digest_hour` carries
// "" (off) or "HH:MM", `digest_mode` carries the mode — so no third meaning is
// multiplexed onto the time (#2205).
//
// LABELLED BY INTENT, NOT BY MECHANISM. The earlier design was a wait TOGGLE beside
// `auto`, whose four cells expressed the same outcomes but named the machinery and
// left two of them unreachable without understanding it. And not "Smart": the tone
// contract is numbers not adjectives, and it implies the alternative is dumb.
//
// OFF IS THE ABSENCE OF A TIME, so switching Off writes `digest_hour: ""` and leaves
// `digest_mode` alone — a mode is not contact and there is nothing to be gained by
// clearing it. Switching back ON re-asks for the mode (the select collapses Off and
// mode into one control) and seeds the declared 07:00 pre-fill. A pre-fill, never an
// `auto` binding: it does not move on its own, and #2217 is what proposes moving it.
//
// The summary below the control is `describeDigestSchedule` — the SAME pure result
// any other surface explaining this schedule formats, so a mode and a surface can
// never describe the send time two different ways (#221).
function DigestControl({
  mode,
  time,
  onChange,
  onApplied,
  timeSuggestion,
  sleepSectionEnabled,
  arrivalStats,
  tickMinutes,
  timeFormat,
  label,
  testId,
}: {
  mode: string;
  time: string;
  onChange: (patch: Record<string, string>) => void;
  // Fold a one-field write this control did NOT make into the form's local bag,
  // without re-saving — see NotificationPrefs.mergeLocal.
  onApplied: (patch: Record<string, string>) => void;
  // The live #2217 suggestion, or null when it is not firing (Dynamic, off, no
  // statistic, the configured time already winning, or a dismissed episode).
  timeSuggestion: DigestTimeSuggestion | null;
  sleepSectionEnabled: boolean;
  arrivalStats: ArrivalStatistics;
  tickMinutes: number;
  timeFormat: TimeFormat;
  label: string;
  testId: string;
}) {
  const off = time === "";
  const seed = time === "" ? formatNotifyTime(DIGEST_DEFAULT_MINUTE) : time;
  const summary = off
    ? null
    : describeDigestSchedule({
        mode: parseDigestMode(mode),
        floorMinute: hhmmToMinuteOfDay(time),
        sleepSectionEnabled,
        stats: arrivalStats,
        tickMinutes,
        timeFormat,
      });
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={off ? "" : mode}
          onChange={(e) => {
            const v = e.target.value;
            // Off leaves `digest_mode` alone on purpose — a mode is not contact, and
            // remembering it means turning the digest back on restores the choice.
            if (v === "") onChange({ digest_hour: "" });
            else onChange({ digest_mode: v, digest_hour: seed });
          }}
          className="input sm:w-56"
          aria-label={`${label} mode`}
          data-testid={testId}
        >
          <option value="">Off</option>
          <option value="static">Same time every day</option>
          <option value="dynamic">As soon as it’s ready</option>
        </select>
        {!off && (
          <input
            type="time"
            value={time}
            // The observed-cadence grid steers the picker (#2216); a typed
            // off-grid time still saves — see TimeControl.
            step={tickGridMinutes(tickMinutes) * 60}
            onChange={(e) => {
              // An empty value is a half-edited input — never save it as "off"; the
              // mode select owns Off.
              if (e.target.value !== "")
                onChange({ digest_hour: e.target.value });
            }}
            className="input w-auto"
            aria-label={
              mode === "dynamic" ? `${label} earliest time` : `${label} time`
            }
            data-testid={`${testId}-time`}
          />
        )}
      </div>
      {summary && (
        <p
          className="mt-1.5 text-xs text-slate-600 dark:text-slate-300"
          data-testid={`${testId}-summary`}
        >
          {summary.headline}
          {summary.detail && (
            <span className="mt-0.5 block text-slate-500 dark:text-slate-400">
              {summary.detail}
            </span>
          )}
        </p>
      )}
      {/* The digest time suggestion (#2217), BELOW the schedule summary: the fact
          about the schedule comes first, and the proposal is a response to it. It
          renders only while it is firing — nothing occupies this space on an
          ordinary schedule. */}
      {/* Conditioned on the LIVE checkbox (#2255 §1), not only on the server's
          answer: with the Sleep section off the digest carries no sleep, so there is
          nothing for the send time to miss, and the card's Dynamic exit would move
          the user into a mode whose own caption immediately says "there is nothing
          to wait for". Unticking the box drops it at once, the same reactivity the
          summary above already has; `getDigestTimeSuggestion` gates the same fact
          server-side, so the next render agrees. */}
      {timeSuggestion && sleepSectionEnabled && (
        <DigestTimeSuggestionRow
          suggestion={timeSuggestion}
          timeFormat={timeFormat}
          onApplied={onApplied}
        />
      )}
    </div>
  );
}

// "HH:MM" → minute of day. The control only ever holds a value the time input or the
// seed produced, so a malformed string is not reachable; 0 is the honest degenerate.
function hhmmToMinuteOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return Number.isInteger(h) && Number.isInteger(m) ? h * 60 + m : 0;
}

export default function NotificationPrefs({
  schedule,
  workoutSummary,
  foodTelegramEnabled,
  foodLoggingRelevant,
  moodCheckinEnabled,
  moodRecapEnabled,
  sleepDigestEnabled,
  wearReminderEnabled,
  wakeMinute,
  arrivalStats,
  timeSuggestion,
  tickMinutes,
  timeFormat,
  subHourlyAtRisk,
  telegramDisabled,
  pushDisabled,
  haDisabled,
  emailDisabled,
  telegramConfigured,
  pushConfigured,
  haConfigured,
  emailConfigured,
}: {
  schedule: NotifySchedule;
  workoutSummary: string;
  foodTelegramEnabled: boolean;
  foodLoggingRelevant: boolean;
  moodCheckinEnabled: boolean;
  moodRecapEnabled: boolean;
  sleepDigestEnabled: boolean;
  // #2161: the user-owned consent for the bedtime wear reminder. Profile tier — it is
  // a fact about the data subject's habits, not about a device — and off by default,
  // so an absent setting renders unchecked and sends nothing.
  wearReminderEnabled: boolean;
  // The profile's typical wake minute of day that the Morning slot's "Auto"
  // resolves to, or null when there isn't enough sleep data yet (#1117). The DIGEST
  // no longer reads it — #2211 removed `auto` from the digest entirely.
  wakeMinute: number | null;
  // The measured sleep-arrival distribution (#2214), or its stated no-answer. Passed
  // whole rather than pre-formatted so the Dynamic summary re-renders as the user
  // moves the floor, with no round trip — and still through the one pure
  // `describeDigestSchedule`, so there is no second copy of the copy.
  arrivalStats: ArrivalStatistics;
  // The live digest time suggestion (#2217), or null when it is not firing. Resolved
  // ONCE on the server, by the same function the digest line reads, so the two
  // surfaces are one finding with one episode key.
  timeSuggestion: DigestTimeSuggestion | null;
  // The scheduler's OBSERVED tick cadence — the same figure the sub-hourly warning
  // reads. The Dynamic deadline is floored at one tick past the floor.
  tickMinutes: number;
  // The reader's clock convention (#964/#1163), resolved once on the server from the
  // LOGIN-tier `time_format` pref. DISPLAY only: every stored value, form field value
  // and wire token on this surface stays "HH:MM" 24-h through `formatNotifyTime`.
  timeFormat: TimeFormat;
  // Sub-hourly times the scheduler's OBSERVED tick cadence cannot land on time
  // (#2121 constraint 4), or null when everything configured is honoured.
  subHourlyAtRisk: { times: string[]; intervalMin: number } | null;
  telegramDisabled: NotificationKind[];
  pushDisabled: NotificationKind[];
  haDisabled: NotificationKind[];
  emailDisabled: NotificationKind[];
  telegramConfigured: boolean;
  pushConfigured: boolean;
  haConfigured: boolean;
  emailConfigured: boolean;
}) {
  // ONE bag of form-field values keyed by the saveNotificationPrefs field name, so a
  // registry row renders and writes generically — adding a kind is a registry entry,
  // not a new piece of hand-wired state.
  const [values, setValues] = useState<Record<string, string>>(() => ({
    food_telegram_enabled: foodTelegramEnabled ? "1" : "0",
    mood_checkin_enabled: moodCheckinEnabled ? "1" : "0",
    mood_recap_enabled: moodRecapEnabled ? "1" : "0",
    digest_sleep_enabled: sleepDigestEnabled ? "1" : "0",
    wear_reminder_enabled: wearReminderEnabled ? "1" : "0",
    supp_morning_hour: timeValue(
      schedule.supplementMinutes.Morning,
      schedule.morningAuto
    ),
    supp_midday_hour: timeValue(schedule.supplementMinutes.Midday, false),
    supp_evening_hour: timeValue(schedule.supplementMinutes.Evening, false),
    supp_bedtime_hour: timeValue(schedule.supplementMinutes.Bedtime, false),
    workout_enabled: schedule.workoutEnabled ? "1" : "0",
    digest_hour:
      schedule.digestMinute == null
        ? ""
        : formatNotifyTime(schedule.digestMinute),
    digest_mode: schedule.digestMode,
    recap_day:
      schedule.weeklyRecapDay == null ? "" : String(schedule.weeklyRecapDay),
    recap_hour: formatNotifyTime(schedule.weeklyRecapMinute ?? 9 * 60),
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
    email: new Set(emailDisabled),
  }));
  const [routing, setRouting] = useState(false);
  const { pending, savedAt, error, save: runSave } = useSaveStatus();

  const autoLabel =
    wakeMinute == null
      ? "Auto (wake time)"
      : `Auto (~${formatClockMinutes(timeFormat, wakeMinute)})`;

  // The minute grid of the scheduler's OBSERVED cadence (#2216) — what every time
  // input's step walks, so the picker offers the minutes a tick can actually land
  // on. Derived from the observed figure, never from TICK_SECONDS: a sidecar
  // configured for 5 minutes but wedged at 20 must not imply a 5-minute grid.
  const gridMinutes = tickGridMinutes(tickMinutes);

  function set(field: string, v: string) {
    setMany({ [field]: v });
  }

  // The whole values bag is posted on every save, so a control that owns two fields
  // (the digest's mode + time) writes both in ONE save rather than two racing ones.
  // A field the FORM did not write: one of the #2217 exits already stored it through
  // its own single-field action, so the bag is reconciled to what is now on the server
  // without posting the whole schedule back. Saving here would be a second write the
  // user never asked for — and would turn a deliberate one-field action into a
  // whole-schedule rewrite, which is the thing it exists to avoid.
  function mergeLocal(patch: Record<string, string>) {
    setValues((prev) => ({ ...prev, ...patch }));
  }

  function setMany(patch: Record<string, string>) {
    const next = { ...values, ...patch };
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
    {
      id: "email",
      short: "Email",
      label: "Email",
      owner: "this login",
      configured: emailConfigured,
    },
  ];

  const saver: Record<ChannelId, (fd: FormData) => Promise<unknown>> = {
    telegram: saveLoginTelegramNotifyKinds,
    push: savePushNotifyKinds,
    ha: saveHomeAssistantNotifyKinds,
    email: saveLoginEmailNotifyKinds,
  };

  // The rendered rows. A kind with no registry entry (the NON_CONFIGURABLE set, e.g.
  // `followup` since #1873) never reaches this list, so it is invisible to the matrix
  // AND to the column sweep below — both read this one filtered set.
  const rows = NOTIFICATION_KIND_REGISTRY.filter(
    (e) => !e.requiresFoodLogging || foodLoggingRelevant
  );

  // A cell is a real toggle unless the channel inherently can't deliver the kind
  // (push/email × the button-only kinds). An unavailable cell is neither "on" nor
  // a checkbox.
  function cellAvailable(channel: ChannelId, kind: NotificationKind): boolean {
    if (channel === "push") return isPushDeliverableKind(kind);
    if (channel === "email") return isEmailDeliverableKind(kind);
    return true;
  }

  // The kinds this column may sweep: rendered rows that have a real cell here, minus
  // the safety tier (the exclusion lives in the pure module, not in this component).
  function columnSweep(channel: ChannelId): NotificationKind[] {
    return sweepableKinds(
      rows.map((e) => e.kind).filter((k) => cellAvailable(channel, k))
    );
  }

  function routes(channel: ChannelId, kind: NotificationKind): boolean {
    return !disabled[channel].has(kind);
  }

  async function writeColumn(channel: ChannelId, next: Set<NotificationKind>) {
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

  async function toggleRoute(channel: ChannelId, kind: NotificationKind) {
    const next = new Set(disabled[channel]);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    await writeColumn(channel, next);
  }

  // The column select-all: one write of the FULL disabled set for this column through
  // the same tier-correct action a single cell uses. Safety kinds are not in
  // `columnSweep`, so they survive the sweep untouched.
  async function sweepColumn(channel: ChannelId) {
    const sweep = columnSweep(channel);
    const on = nextColumnBulkTarget(columnBulkState(sweep, disabled[channel]));
    const next = applyColumnBulk([...disabled[channel]], sweep, on);
    await writeColumn(channel, new Set(next));
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

  // The slot precondition this kind's send rides, when NONE of the slots it needs is
  // configured (#2161 review). A kind with no schedule of its own fires at an intake
  // slot minute, and turning that slot off silences it however its own checkbox reads
  // — a checkbox that says "on" and does nothing is the worst thing a settings page
  // can show. So the row NAMES the missing precondition and points at the Schedule
  // card above it. Deliberately not a disable: the checkbox stays editable, because a
  // user must always be able to turn a consent OFF, and turning one ON ahead of
  // setting a time is a legitimate order to do things in. And deliberately not a
  // fallback hour in the tick: guessing a bedtime for a send the user consented to at
  // THEIR bedtime is a worse answer than saying what is missing.
  function slotGap(e: NotificationKindEntry): string | null {
    const missing = unmetSlotRequirement(
      e,
      (slot) => values[SLOT_FIELD[slot]] !== ""
    );
    return missing ? slotRequirementNote(missing) : null;
  }

  // Whether the kind itself is on, which decides if its extras are offered.
  function kindEnabled(e: NotificationKindEntry): boolean {
    switch (e.control.type) {
      case "always":
        return true;
      case "toggle":
        return values[e.control.field] === "1";
      case "time":
        return values[e.control.field] !== "";
      // The digest is on when it has a time; the MODE is remembered across an Off
      // and never decides on/off by itself.
      case "digest-mode":
        return values[e.control.timeField] !== "";
      case "day-time":
        return values[e.control.dayField] !== "";
    }
  }

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
            Reminders go out at these times, in this profile&rsquo;s timezone.
          </p>
          {/* Sub-hourly honesty (#2121/#2216): the scheduler reports its
              observed cadence; a time it cannot land on exactly is named rather
              than delivered late silently — and only named, never refused. */}
          {subHourlyAtRisk && (
            <p
              className="mb-2 text-xs text-amber-700 dark:text-amber-400"
              data-testid="sub-hourly-tick-warning"
            >
              This server&rsquo;s notification scheduler runs about every{" "}
              {subHourlyAtRisk.intervalMin} minutes, so{" "}
              {subHourlyAtRisk.times.join(", ")} may be delivered late (or, in
              the last hour of the day, not at all).{" "}
              {gridMinutes === 60
                ? "Use on-the-hour times"
                : `Use times in ${gridMinutes}-minute steps`}
              , or run the scheduler more often.
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            {SLOTS.map((w) => {
              const field = SLOT_FIELD[w];
              return (
                <div key={w}>
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {w}
                  </span>
                  <div className="mt-1">
                    <TimeControl
                      value={values[field]}
                      onChange={(v) => set(field, v)}
                      /* The Morning slot can follow the profile's wake time (#1117). */
                      autoOption={w === "Morning" ? autoLabel : null}
                      seed={SLOT_SEED[field]}
                      stepMinutes={gridMinutes}
                      label={`${w} reminder`}
                      testId={w === "Morning" ? "supp-morning-hour" : undefined}
                    />
                  </div>
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
                  {formatClockMinutes(timeFormat, i * 60)}
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
                  {/* The inclusive :59 end stays — the window ends when that
                      minute does, and rounding it to the next hour would widen it. */}
                  {formatClockMinutes(timeFormat, i * 60 + 59)}
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
          Turn a kind off, or keep it and choose which channels carry it. The
          box under a channel name edits that whole column at once — it turns
          off everything except safety reminders, which keep their own boxes.
        </p>

        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-x-3 border-b border-black/10 pb-2 text-xs font-medium text-slate-500 dark:border-white/10 dark:text-slate-400">
          <span>Kind</span>
          <span className="grid w-[10rem] grid-cols-4 gap-1 text-center sm:w-52">
            {columns.map((c) => {
              const sweep = columnSweep(c.id);
              const state = columnBulkState(sweep, disabled[c.id]);
              const label = columnBulkLabel(c.label, state);
              return (
                <span key={c.id} className="block">
                  <span title={`${c.label} — ${c.owner}`}>{c.short}</span>
                  {!c.configured && (
                    <span className="block text-xs font-normal text-slate-500 dark:text-slate-400">
                      not set up
                    </span>
                  )}
                  {/* The tri-state column sweep (#1868 §2). `indeterminate` is a DOM
                      property with no React attribute, so it is set through a ref. */}
                  <input
                    type="checkbox"
                    className="mx-auto mt-1 block h-4 w-4 accent-brand-600"
                    ref={(el) => {
                      if (el) el.indeterminate = state === "mixed";
                    }}
                    checked={state === "all"}
                    disabled={routing || sweep.length === 0}
                    onChange={() => sweepColumn(c.id)}
                    data-testid={`matrix-column-all-${c.id}`}
                    aria-label={label}
                    title={label}
                  />
                </span>
              );
            })}
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
                  {slotGap(e) && (
                    <p
                      className="mt-1 text-xs text-amber-700 dark:text-amber-400"
                      data-testid={`kind-slot-gap-${e.kind}`}
                    >
                      {slotGap(e)}
                    </p>
                  )}

                  {e.control.type === "time" && (
                    <div className="mt-2">
                      <TimeControl
                        value={values[e.control.field]}
                        onChange={(v) =>
                          set((e.control as { field: string }).field, v)
                        }
                        autoOption={e.control.auto ? autoLabel : null}
                        seed={SLOT_SEED[e.control.field] ?? "08:00"}
                        stepMinutes={gridMinutes}
                        label={e.label}
                        testId={e.controlTestId ?? `kind-time-${e.kind}`}
                        selectClassName="input sm:w-40"
                      />
                    </div>
                  )}

                  {e.control.type === "digest-mode" && (
                    <div className="mt-2">
                      <DigestControl
                        mode={values[e.control.modeField]}
                        time={values[e.control.timeField]}
                        onChange={setMany}
                        onApplied={mergeLocal}
                        timeSuggestion={timeSuggestion}
                        sleepSectionEnabled={
                          values["digest_sleep_enabled"] === "1"
                        }
                        arrivalStats={arrivalStats}
                        tickMinutes={tickMinutes}
                        timeFormat={timeFormat}
                        label={e.label}
                        testId={e.controlTestId ?? `kind-time-${e.kind}`}
                      />
                    </div>
                  )}

                  {e.control.type === "day-time" && (
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
                      {/* The weekday owns Off; the time input is always a
                          concrete "HH:MM" (defaulting to 09:00). */}
                      {on && (
                        <input
                          type="time"
                          value={values[e.control.timeField]}
                          step={gridMinutes * 60}
                          onChange={(ev) => {
                            if (ev.target.value !== "")
                              set(
                                (e.control as { timeField: string }).timeField,
                                ev.target.value
                              );
                          }}
                          className="input w-auto"
                          aria-label={`${e.label} time`}
                        />
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

                <div className="grid w-[10rem] shrink-0 grid-cols-4 gap-1 pt-1 text-center sm:w-52">
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
                        title={`${c.label} can’t deliver this button-only reminder.`}
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
