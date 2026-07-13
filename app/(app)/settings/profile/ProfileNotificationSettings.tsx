"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { NotifySchedule, ProfileTelegram } from "@/lib/settings";
import { saveNotificationPrefs, sendTestNotification } from "./actions";
import SaveStatus from "@/components/SaveStatus";
import { useSaveStatus } from "@/components/useSaveStatus";

type SuppWindow = "Morning" | "Midday" | "Evening" | "Bedtime";

// The PROFILE-scoped parts of notifications: whether reminders are on for this
// profile, the chat they go to, and the send schedule. The global bot token +
// transport mode are admin-managed on Settings → Server.
export default function ProfileNotificationSettings({
  telegram,
  botConfigured,
  schedule,
  workoutSummary,
  foodTelegramEnabled,
  foodLoggingRelevant,
}: {
  telegram: ProfileTelegram;
  botConfigured: boolean;
  schedule: NotifySchedule;
  workoutSummary: string;
  foodTelegramEnabled: boolean;
  foodLoggingRelevant: boolean;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(telegram.telegramEnabled);
  const [chatId, setChatId] = useState(telegram.telegramChatId);
  const [foodEnabled, setFoodEnabled] = useState(foodTelegramEnabled);
  const [suppHours, setSuppHours] = useState(schedule.supplementHours);
  const [workoutEnabled, setWorkoutEnabled] = useState(schedule.workoutEnabled);
  const [digestHour, setDigestHour] = useState(schedule.digestHour);
  const [recapDay, setRecapDay] = useState(schedule.weeklyRecapDay);
  const [recapHour, setRecapHour] = useState(schedule.weeklyRecapHour ?? 9);
  const [milestonesEnabled, setMilestonesEnabled] = useState(
    schedule.milestonesEnabled
  );
  const [preventiveEnabled, setPreventiveEnabled] = useState(
    schedule.preventiveEnabled
  );
  const [wakingStart, setWakingStart] = useState(schedule.wakingStartHour);
  const [wakingEnd, setWakingEnd] = useState(schedule.wakingEndHour);
  const { pending, savedAt, error, save: runSave } = useSaveStatus();
  // The test send drives the result message, not the "saved" chip, so it keeps its
  // own transition.
  const [testing, startTest] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(
    null
  );
  const busy = pending || testing;

  function buildFormData() {
    const fd = new FormData();
    fd.set("telegram_enabled", enabled ? "1" : "0");
    fd.set("telegram_chat_id", chatId);
    fd.set("food_telegram_enabled", foodEnabled ? "1" : "0");
    fd.set(
      "supp_morning_hour",
      suppHours.Morning == null ? "" : String(suppHours.Morning)
    );
    fd.set(
      "supp_midday_hour",
      suppHours.Midday == null ? "" : String(suppHours.Midday)
    );
    fd.set(
      "supp_evening_hour",
      suppHours.Evening == null ? "" : String(suppHours.Evening)
    );
    fd.set(
      "supp_bedtime_hour",
      suppHours.Bedtime == null ? "" : String(suppHours.Bedtime)
    );
    fd.set("workout_enabled", workoutEnabled ? "1" : "0");
    fd.set("digest_hour", digestHour == null ? "" : String(digestHour));
    fd.set("recap_day", recapDay == null ? "" : String(recapDay));
    fd.set("recap_hour", String(recapHour));
    fd.set("milestones_enabled", milestonesEnabled ? "1" : "0");
    fd.set("preventive_enabled", preventiveEnabled ? "1" : "0");
    fd.set("waking_start_hour", String(wakingStart));
    fd.set("waking_end_hour", String(wakingEnd));
    return fd;
  }

  function save() {
    runSave(async () => {
      await saveNotificationPrefs(buildFormData());
      setResult(null);
      router.refresh();
    });
  }

  // Test acts on *stored* settings, so persist the form first — otherwise unsaved
  // edits are silently ignored and nothing sends. The "Saved" chip stays tied to
  // the explicit Save button: showing it here would read as success even when the
  // test itself fails. The try/catch keeps a transient throw from escalating to
  // the error boundary.
  function test() {
    const fd = buildFormData();
    startTest(async () => {
      try {
        await saveNotificationPrefs(fd);
        setResult(await sendTestNotification());
        router.refresh();
      } catch {
        setResult({
          ok: false,
          message: "Couldn’t send the test. Please try again.",
        });
      }
    });
  }

  return (
    <div className="card mt-6 max-w-lg space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Notifications (Telegram)
        </h2>
        <SaveStatus pending={pending} savedAt={savedAt} error={error} />
      </div>

      <p className="text-xs text-slate-400 dark:text-slate-500">
        Get supplement reminders in Telegram with one-tap “taken” buttons. Find
        your chat id at{" "}
        <code>api.telegram.org/bot&lt;token&gt;/getUpdates</code>.
      </p>

      {!botConfigured && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          No Telegram bot is configured yet. An admin sets the bot token on
          Settings → Server; until then reminders can’t be sent.
        </p>
      )}

      <label className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-4 w-4 accent-brand-600"
        />
        Enable Telegram notifications
      </label>

      {enabled && (
        <>
          <div>
            <label className="label">Chat ID</label>
            <input
              value={chatId}
              onChange={(e) => setChatId(e.target.value)}
              placeholder="e.g. 987654321"
              className="input"
            />
          </div>

          {/* Food logging (#682) — a morning/midday/evening nudge with one-tap
              buttons for your most-eaten foods, on the same schedule as supplement
              reminders. Hidden for a profile too young for food-group logging. */}
          {foodLoggingRelevant && (
            <div className="border-t border-slate-100 pt-5 dark:border-slate-800">
              <label className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
                <input
                  type="checkbox"
                  checked={foodEnabled}
                  onChange={(e) => setFoodEnabled(e.target.checked)}
                  className="h-4 w-4 accent-brand-600"
                  data-testid="food-telegram-enabled"
                />
                Log food from Telegram
              </label>
              <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                A quick nudge at your supplement times with one-tap buttons for
                your most-eaten foods. Tap to log a serving — your full food log
                stays on the Nutrition page.
              </p>
            </div>
          )}

          {/* Schedule — an hourly cron (npm run notify) sends each slot at its hour. */}
          <div className="border-t border-slate-100 pt-5 dark:border-slate-800">
            <label className="label">Schedule</label>
            <p className="mb-2 text-xs text-slate-400 dark:text-slate-500">
              Run <code>npm run notify</code> hourly (cron); each slot sends at
              its hour (this profile’s timezone).
            </p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-2">
              {(
                ["Morning", "Midday", "Evening", "Bedtime"] as SuppWindow[]
              ).map((w) => (
                <div key={w}>
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {w} supps
                  </span>
                  <select
                    value={suppHours[w] == null ? "" : String(suppHours[w])}
                    onChange={(e) =>
                      setSuppHours((h) => ({
                        ...h,
                        [w]:
                          e.target.value === "" ? null : Number(e.target.value),
                      }))
                    }
                    className="input mt-1"
                  >
                    <option value="">Off</option>
                    {Array.from({ length: 24 }, (_, i) => (
                      <option key={i} value={i}>
                        {String(i).padStart(2, "0")}:00
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            <label className="mt-3 flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
              <input
                type="checkbox"
                checked={workoutEnabled}
                onChange={(e) => setWorkoutEnabled(e.target.checked)}
                className="h-4 w-4 accent-brand-600"
              />
              Workout reminder
            </label>
            <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
              Sent on the usual training schedule — {workoutSummary} — when
              behind on the weekly routine.
            </p>
          </div>

          {/* Morning digest — one daily summary (today's doses + goals due,
              yesterday's activities/adherence/weight, anything new to look at). */}
          <div className="border-t border-slate-100 pt-5 dark:border-slate-800">
            <label className="label">Morning digest</label>
            <p className="mb-2 text-xs text-slate-400 dark:text-slate-500">
              A once-a-day summary at the hour below (this profile’s timezone).
              Skips sections with nothing to report.
            </p>
            <select
              value={digestHour == null ? "" : String(digestHour)}
              onChange={(e) =>
                setDigestHour(
                  e.target.value === "" ? null : Number(e.target.value)
                )
              }
              className="input sm:w-40"
              aria-label="Morning digest hour"
            >
              <option value="">Off</option>
              {Array.from({ length: 24 }, (_, i) => (
                <option key={i} value={i}>
                  {String(i).padStart(2, "0")}:00
                </option>
              ))}
            </select>
          </div>

          {/* Weekly recap — a once-a-week summary of the last seven days
              (workouts, volume, PRs, adherence, weight, streak). */}
          <div className="border-t border-slate-100 pt-5 dark:border-slate-800">
            <label className="label">Weekly recap</label>
            <p className="mb-2 text-xs text-slate-400 dark:text-slate-500">
              A once-a-week summary of your last seven days, on the day and hour
              below (this profile’s timezone). Skips weeks with nothing to
              report.
            </p>
            <div className="flex flex-wrap gap-2">
              <select
                value={recapDay == null ? "" : String(recapDay)}
                onChange={(e) =>
                  setRecapDay(
                    e.target.value === "" ? null : Number(e.target.value)
                  )
                }
                className="input sm:w-40"
                aria-label="Weekly recap day"
              >
                <option value="">Off</option>
                {[
                  "Sunday",
                  "Monday",
                  "Tuesday",
                  "Wednesday",
                  "Thursday",
                  "Friday",
                  "Saturday",
                ].map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </select>
              {recapDay != null && (
                <select
                  value={String(recapHour)}
                  onChange={(e) => setRecapHour(Number(e.target.value))}
                  className="input sm:w-32"
                  aria-label="Weekly recap hour"
                >
                  {Array.from({ length: 24 }, (_, i) => (
                    <option key={i} value={i}>
                      {String(i).padStart(2, "0")}:00
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>

          {/* Milestone alerts — a quiet notification when a milestone fires
              (Nth workout, streak length, goal reached, adherence run). They
              are always recorded to the Timeline regardless of this toggle. */}
          <div className="border-t border-slate-100 pt-5 dark:border-slate-800">
            <label className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
              <input
                type="checkbox"
                checked={milestonesEnabled}
                onChange={(e) => setMilestonesEnabled(e.target.checked)}
                className="h-4 w-4 accent-brand-600"
              />
              Milestone alerts
            </label>
            <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
              A quiet note when you hit a milestone. Milestones always appear on
              your Timeline either way.
            </p>
          </div>

          {/* Preventive-care reminders (#87) — a proactive nudge when a
              preventive visit or screening comes due, plus its lines in the
              "what's due" digest. Due items always stay on the Upcoming page. */}
          <div className="border-t border-slate-100 pt-5 dark:border-slate-800">
            <label className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
              <input
                type="checkbox"
                checked={preventiveEnabled}
                onChange={(e) => setPreventiveEnabled(e.target.checked)}
                className="h-4 w-4 accent-brand-600"
                data-testid="preventive-enabled"
              />
              Preventive-care reminders
            </label>
            <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
              A nudge (and digest lines) when a recommended checkup or screening
              is due or overdue. Due items still appear on your Upcoming page
              either way. Informational only — not medical advice.
            </p>
          </div>
        </>
      )}

      {/* Quiet hours (#450) — the waking window for non-urgent EPISODE nudges
          (refill, preventive, milestone). Shown regardless of the Telegram toggle
          because it gates those nudges on every channel (web push / Home Assistant
          too). Urgent medication reminders (dose reminders, missed-dose escalation)
          are NEVER held by this — they follow the medication schedule. */}
      <div
        className="border-t border-slate-100 pt-5 dark:border-slate-800"
        data-testid="quiet-hours"
      >
        <label className="label">Quiet hours</label>
        <p className="mb-2 text-xs text-slate-400 dark:text-slate-500">
          Non-urgent nudges (refill, preventive, milestone) are only sent
          between these hours (this profile’s timezone). Set an overnight span
          like 20:00 → 08:00 for a night-shift rhythm. Urgent medication
          reminders are never held.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={String(wakingStart)}
            onChange={(e) => setWakingStart(Number(e.target.value))}
            className="input sm:w-32"
            aria-label="Quiet hours start (nudges begin)"
            data-testid="waking-start-hour"
          >
            {Array.from({ length: 24 }, (_, i) => (
              <option key={i} value={i}>
                {String(i).padStart(2, "0")}:00
              </option>
            ))}
          </select>
          <span className="text-sm text-slate-400 dark:text-slate-500">to</span>
          <select
            value={String(wakingEnd)}
            onChange={(e) => setWakingEnd(Number(e.target.value))}
            className="input sm:w-32"
            aria-label="Quiet hours end (nudges stop)"
            data-testid="waking-end-hour"
          >
            {Array.from({ length: 24 }, (_, i) => (
              <option key={i} value={i}>
                {String(i).padStart(2, "0")}:59
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={save} disabled={busy} className="btn">
          Save
        </button>
        {enabled && (
          <button
            type="button"
            onClick={test}
            disabled={busy}
            className="btn-ghost"
          >
            Send test notification
          </button>
        )}
      </div>

      {result && (
        <p
          className={`text-sm ${
            result.ok
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-rose-600 dark:text-rose-400"
          }`}
        >
          {result.message}
        </p>
      )}
    </div>
  );
}
