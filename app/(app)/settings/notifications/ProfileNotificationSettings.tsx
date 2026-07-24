"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { NotifySchedule } from "@/lib/settings";
import { saveNotificationPrefs } from "../profile/actions";
import SaveStatus from "@/components/SaveStatus";
import { useSaveStatus } from "@/components/useSaveStatus";

type SuppWindow = "Morning" | "Midday" | "Evening" | "Bedtime";

// The PROFILE-scoped (per-subject) parts of notifications: the send schedule and
// the per-subject content opt-ins (food logging, mood, sleep). These apply to
// EVERY delivery channel this subject rides. The Telegram delivery channel itself
// (chat id + enable) is LOGIN-scoped as of #1072 — see LoginTelegramSettings — and
// the global bot token/mode are admin-managed on Settings → Server.
export default function ProfileNotificationSettings({
  schedule,
  workoutSummary,
  foodTelegramEnabled,
  foodLoggingRelevant,
  moodCheckinEnabled,
  moodRecapEnabled,
  sleepDigestEnabled,
  wakeHour,
}: {
  schedule: NotifySchedule;
  workoutSummary: string;
  foodTelegramEnabled: boolean;
  foodLoggingRelevant: boolean;
  moodCheckinEnabled: boolean;
  moodRecapEnabled: boolean;
  sleepDigestEnabled: boolean;
  // The profile's typical wake hour (0-23) that "Auto" resolves to, or null when
  // there isn't enough sleep data yet (issue #1117) — shown as a hint on the Auto
  // options.
  wakeHour: number | null;
}) {
  const router = useRouter();
  const [foodEnabled, setFoodEnabled] = useState(foodTelegramEnabled);
  const [moodEnabled, setMoodEnabled] = useState(moodCheckinEnabled);
  const [moodRecap, setMoodRecap] = useState(moodRecapEnabled);
  const [suppHours, setSuppHours] = useState(schedule.supplementHours);
  const [morningAuto, setMorningAuto] = useState(schedule.morningAuto);
  const [workoutEnabled, setWorkoutEnabled] = useState(schedule.workoutEnabled);
  const [digestHour, setDigestHour] = useState(schedule.digestHour);
  const [digestAuto, setDigestAuto] = useState(schedule.digestAuto);
  const [sleepDigest, setSleepDigest] = useState(sleepDigestEnabled);
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
  const busy = pending;

  // The label for the wake-aware "Auto" option (#1117), naming the hour it resolves
  // to when there's enough sleep data.
  const autoLabel = `Auto — from your wake time${
    wakeHour == null ? "" : ` (~${String(wakeHour).padStart(2, "0")}:00)`
  }`;

  function buildFormData() {
    const fd = new FormData();
    fd.set("food_telegram_enabled", foodEnabled ? "1" : "0");
    fd.set("mood_checkin_enabled", moodEnabled ? "1" : "0");
    fd.set("mood_recap_enabled", moodRecap ? "1" : "0");
    fd.set("digest_sleep_enabled", sleepDigest ? "1" : "0");
    // Morning intake follows the wake time when Auto is selected (#1117): send the
    // "auto" sentinel, NOT the resolved hour, so the write path records intent.
    fd.set(
      "supp_morning_hour",
      morningAuto
        ? "auto"
        : suppHours.Morning == null
          ? ""
          : String(suppHours.Morning)
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
    fd.set(
      "digest_hour",
      digestAuto ? "auto" : digestHour == null ? "" : String(digestHour)
    );
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
      router.refresh();
    });
  }

  return (
    <div id="notifications" className="card mt-6 max-w-lg space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Reminders &amp; schedule
        </h2>
        <SaveStatus pending={pending} savedAt={savedAt} error={error} />
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-400">
        When this person’s reminders are sent. These times apply to every
        channel they’re delivered on (Telegram, web push, Home Assistant).
        Connect a Telegram chat in your login’s channel above.
      </p>

      <>
        {/* Food logging (#682) — a morning/midday/evening nudge with one-tap
              buttons for your most-eaten foods, on the same schedule as supplement
              reminders. Hidden for a profile too young for food-group logging. */}
        {foodLoggingRelevant && (
          <div className="border-t border-black/5 pt-5 dark:border-white/5">
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
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              A quick nudge at your supplement times with one-tap buttons for
              your most-eaten foods. Tap to log a serving — your full food log
              stays on the Nutrition page.
            </p>
          </div>
        )}

        {/* Daily mood check-in (#992) — opt-in, off by default: a gentle
              once-daily "How are you today?" at the evening supplement hour. It
              auto-pauses after a few ignored days and re-arms the next time a
              check-in is logged; skipping never escalates anything. */}
        <div className="border-t border-black/5 pt-5 dark:border-white/5">
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
            <input
              type="checkbox"
              checked={moodEnabled}
              onChange={(e) => setMoodEnabled(e.target.checked)}
              className="h-4 w-4 accent-brand-600"
              data-testid="mood-checkin-enabled"
            />
            Daily mood check-in
          </label>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            A gentle once-daily &ldquo;How are you today?&rdquo; in the evening
            with one-tap answers. It pauses itself after a few ignored days and
            comes back when you next log a check-in — skipping is always fine.
          </p>
          <label className="mt-3 flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
            <input
              type="checkbox"
              checked={moodRecap}
              onChange={(e) => setMoodRecap(e.target.checked)}
              className="h-4 w-4 accent-brand-600"
              data-testid="mood-recap-enabled"
            />
            Mood line in the weekly recap
          </label>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Adds a one-line summary of the week&rsquo;s check-ins to the weekly
            recap — an average, never a score to beat.
          </p>
        </div>

        {/* Schedule — an hourly cron (npm run notify) sends each slot at its hour. */}
        <div className="border-t border-black/5 pt-5 dark:border-white/5">
          <label className="label">Schedule</label>
          <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
            Run <code>npm run notify</code> hourly (cron); each slot sends at
            its hour (this profile’s timezone).
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-2">
            {(["Morning", "Midday", "Evening", "Bedtime"] as SuppWindow[]).map(
              (w) => (
                <div key={w}>
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {w} supps
                  </span>
                  <select
                    value={
                      w === "Morning" && morningAuto
                        ? "auto"
                        : suppHours[w] == null
                          ? ""
                          : String(suppHours[w])
                    }
                    onChange={(e) => {
                      const v = e.target.value;
                      if (w === "Morning") {
                        setMorningAuto(v === "auto");
                        if (v !== "auto")
                          setSuppHours((h) => ({
                            ...h,
                            Morning: v === "" ? null : Number(v),
                          }));
                      } else {
                        setSuppHours((h) => ({
                          ...h,
                          [w]: v === "" ? null : Number(v),
                        }));
                      }
                    }}
                    className="input mt-1"
                    data-testid={
                      w === "Morning" ? "supp-morning-hour" : undefined
                    }
                  >
                    <option value="">Off</option>
                    {/* The Morning slot can follow the profile's wake time (#1117). */}
                    {w === "Morning" && (
                      <option value="auto">{autoLabel}</option>
                    )}
                    {Array.from({ length: 24 }, (_, i) => (
                      <option key={i} value={i}>
                        {String(i).padStart(2, "0")}:00
                      </option>
                    ))}
                  </select>
                </div>
              )
            )}
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
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Sent on the usual training schedule — {workoutSummary} — when behind
            on the weekly routine.
          </p>
        </div>

        {/* Morning digest — one daily summary at digest hour: anything new
              about an open illness, today's what's-due list (doses, refills,
              appointments, retests, goals & more — the same list your Upcoming
              page shows, so a snooze/dismiss there quiets it here), yesterday's
              activities/adherence/weight, and anything new to look at (#1108). */}
        <div className="border-t border-black/5 pt-5 dark:border-white/5">
          <label className="label">Morning digest</label>
          <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
            A once-a-day summary at the hour below (this profile’s timezone),
            including today’s what’s-due list. Skips sections with nothing to
            report. Pick <em>Auto</em> to have it arrive around when you usually
            wake.
          </p>
          <select
            value={
              digestAuto ? "auto" : digestHour == null ? "" : String(digestHour)
            }
            onChange={(e) => {
              const v = e.target.value;
              setDigestAuto(v === "auto");
              if (v !== "auto") setDigestHour(v === "" ? null : Number(v));
            }}
            className="input sm:w-64"
            aria-label="Morning digest hour"
            data-testid="digest-hour"
          >
            <option value="">Off</option>
            {/* Follow the wake time — the digest lands when you wake (#1117). */}
            <option value="auto">{autoLabel}</option>
            {Array.from({ length: 24 }, (_, i) => (
              <option key={i} value={i}>
                {String(i).padStart(2, "0")}:00
              </option>
            ))}
          </select>

          {/* Sleep summary (#1117) — opt-in, off by default. Adds a calm
                "how'd I sleep" section (last night vs baseline, stages, an SRI
                note, any nap on its own line) to the morning digest. Best around
                the wake-derived hour; the hourly tick means "the hour you usually
                wake", not to-the-minute. */}
          <label className="mt-3 flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
            <input
              type="checkbox"
              checked={sleepDigest}
              onChange={(e) => setSleepDigest(e.target.checked)}
              className="h-4 w-4 accent-brand-600"
              data-testid="digest-sleep-enabled"
            />
            Include a sleep summary
          </label>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            A gentle recap of last night’s sleep vs your baseline — never a
            score to beat. Needs a sleep integration; it’s skipped when there’s
            no recent sleep data. Arrives around your usual wake hour (the
            reminder tick is hourly, so it’s that hour, not to the minute).
          </p>
        </div>

        {/* Weekly recap — a once-a-week summary of the last seven days
              (workouts, volume, PRs, adherence, weight, streak). */}
        <div className="border-t border-black/5 pt-5 dark:border-white/5">
          <label className="label">Weekly recap</label>
          <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
            A once-a-week summary of your last seven days, on the day and hour
            below (this profile’s timezone). Skips weeks with nothing to report.
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
        <div className="border-t border-black/5 pt-5 dark:border-white/5">
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
            <input
              type="checkbox"
              checked={milestonesEnabled}
              onChange={(e) => setMilestonesEnabled(e.target.checked)}
              className="h-4 w-4 accent-brand-600"
            />
            Milestone alerts
          </label>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            A quiet note when you hit a milestone. Milestones always appear on
            your Timeline either way.
          </p>
        </div>

        {/* Preventive-care reminders (#87) — a proactive nudge when a
              preventive visit or screening comes due, plus its lines in the
              "what's due" digest. Due items always stay on the Upcoming page. */}
        <div className="border-t border-black/5 pt-5 dark:border-white/5">
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
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            A nudge (and digest lines) when a recommended checkup or screening
            is due or overdue. Due items still appear on your Upcoming page
            either way.
          </p>
        </div>
      </>

      {/* Quiet hours (#450) — the waking window for non-urgent EPISODE nudges
          (refill, preventive, milestone). Shown regardless of the Telegram toggle
          because it gates those nudges on every channel (web push / Home Assistant
          too). Urgent medication reminders (dose reminders, missed-dose escalation)
          are NEVER held by this — they follow the medication schedule. */}
      <div
        className="border-t border-black/5 pt-5 dark:border-white/5"
        data-testid="quiet-hours"
      >
        <label className="label">Quiet hours</label>
        <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
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
          <span className="text-sm text-slate-500 dark:text-slate-400">to</span>
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
      </div>
    </div>
  );
}
