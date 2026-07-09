"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { NotifySchedule, ProfileTelegram } from "@/lib/settings";
import { saveNotificationPrefs, sendTestNotification } from "../actions";
import SaveStatus from "@/components/SaveStatus";

type SuppWindow = "Morning" | "Midday" | "Evening" | "Bedtime";

// The PROFILE-scoped parts of notifications: whether reminders are on for this
// profile, the chat they go to, and the send schedule. The global bot token +
// transport mode are admin-managed on Settings → Server.
export default function ProfileNotificationSettings({
  telegram,
  botConfigured,
  schedule,
  workoutSummary,
}: {
  telegram: ProfileTelegram;
  botConfigured: boolean;
  schedule: NotifySchedule;
  workoutSummary: string;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(telegram.telegramEnabled);
  const [chatId, setChatId] = useState(telegram.telegramChatId);
  const [suppHours, setSuppHours] = useState(schedule.supplementHours);
  const [workoutEnabled, setWorkoutEnabled] = useState(schedule.workoutEnabled);
  const [digestHour, setDigestHour] = useState(schedule.digestHour);
  const [pending, startTransition] = useTransition();
  const [savedAt, setSavedAt] = useState(0);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(
    null
  );

  function buildFormData() {
    const fd = new FormData();
    fd.set("telegram_enabled", enabled ? "1" : "0");
    fd.set("telegram_chat_id", chatId);
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
    return fd;
  }

  function save() {
    startTransition(async () => {
      await saveNotificationPrefs(buildFormData());
      setSavedAt(Date.now());
      setResult(null);
      router.refresh();
    });
  }

  // Test acts on *stored* settings, so persist the form first — otherwise unsaved
  // edits are silently ignored and nothing sends. The "Saved" chip stays tied to
  // the explicit Save button: showing it here would read as success even when the
  // test itself fails.
  function test() {
    const fd = buildFormData();
    startTransition(async () => {
      await saveNotificationPrefs(fd);
      setResult(await sendTestNotification());
      router.refresh();
    });
  }

  return (
    <div className="card mt-6 max-w-lg space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Notifications (Telegram)
        </h2>
        <SaveStatus pending={pending} savedAt={savedAt} />
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
        </>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={save} disabled={pending} className="btn">
          Save
        </button>
        {enabled && (
          <button
            type="button"
            onClick={test}
            disabled={pending}
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
