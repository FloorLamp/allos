// Outbound notification entrypoint.
//
//   npm run notify                 # HOURLY TICK — run every hour by cron; for
//                                  # EACH profile sends whichever notifications
//                                  # are scheduled for the current hour (and not
//                                  # already sent today).
//   npm run notify -- poll         # LONG-RUNNING: long-poll Telegram getUpdates for
//                                  # button taps (used when the app has no public
//                                  # URL for a webhook). Never exits on its own.
//   npm run notify -- morning      # manual: supplements for a window
//   npm run notify -- midday|evening|bedtime
//   npm run notify -- workout      # manual: workout-target reminder
//   npm run notify -- morning --profile 2   # manual: target a specific profile
//                                            # (default profile 1)
//
// Manual runs bypass the schedule and the per-day dedupe (for testing).
// Exit codes: 0 = sent / nothing due / no channel; 1 = a configured channel failed
// (for any profile); 2 = bad argument.

import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import {
  buildSupplementReminder,
  type ReminderWindow,
} from "../lib/notifications/supplements";
import { buildWorkoutTargetReminder } from "../lib/notifications/workouts";
import { dispatch } from "../lib/notifications";
import {
  prefixMessage,
  profileMessagePrefix,
  type NotificationMessage,
} from "../lib/notifications/types";
import {
  getNotifySchedule,
  getSetting,
  setSetting,
  getProfileSetting,
  setProfileSetting,
  getTimezone,
  getTelegramBotConfig,
} from "../lib/settings";
import { getUpdates } from "../lib/notifications/telegram";
import { handleCallbackQuery } from "../lib/notifications/telegram-callbacks";
import { runEscalations } from "../lib/notifications/escalate";
import { runRefills } from "../lib/notifications/refill";
import { runDigest } from "../lib/notifications/digest-data";
import { runUpcomingDigest } from "../lib/notifications/upcoming-digest-data";
import { runScheduledBackup } from "../lib/backup";
import { pruneAuditEvents } from "../lib/audit";
import { inferWorkoutSchedule } from "../lib/queries";
import { slotDue } from "../lib/notifications/schedule";
import { db, today } from "../lib/db";
import { hourInTz, weekdayInTz } from "../lib/date";
import { createLogger } from "../lib/log";
import { getConnection } from "../lib/integrations/connections";
import { runStravaSync } from "../lib/integrations/strava-sync";

const log = createLogger("notify");

const WINDOWS: Record<string, ReminderWindow> = {
  morning: "Morning",
  midday: "Midday",
  evening: "Evening",
  bedtime: "Bedtime",
};

interface ProfileRow {
  id: number;
  name: string;
}

// Every tracked person. The tick fans out over these; manual mode targets one.
function allProfiles(): ProfileRow[] {
  return db
    .prepare("SELECT id, name FROM profiles ORDER BY id")
    .all() as ProfileRow[];
}

// Send one message on behalf of a profile. `delivered` = at least one configured
// channel succeeded (used to dedupe a slot for the day, so a successful channel
// isn't re-sent next hour just because another channel failed); `failed` = any
// configured channel failed.
async function send(
  profileId: number,
  msg: NotificationMessage
): Promise<{ delivered: boolean; failed: boolean }> {
  const results = await dispatch(profileId, msg);
  if (results.length === 0) {
    // No channel for this profile (e.g. no chat id) — skip it silently, not an error.
    log.info("no channels configured for profile", { profile: profileId });
    return { delivered: false, failed: false };
  }
  return {
    delivered: results.some((r) => r.ok),
    failed: results.some((r) => !r.ok),
  };
}

// --- Manual mode: build the one requested message for one profile, send, exit. ---
async function manual(arg: string, profileId: number) {
  let msg: NotificationMessage | null;
  if (arg === "workout") msg = buildWorkoutTargetReminder(profileId);
  else if (WINDOWS[arg]) msg = buildSupplementReminder(profileId, WINDOWS[arg]);
  else {
    console.error(
      "Usage: npm run notify -- <morning|midday|evening|bedtime|workout> [--profile <id>]"
    );
    process.exit(2);
  }
  if (!msg) {
    log.info("nothing due", { kind: arg, profile: profileId });
    process.exit(0);
  }
  const profiles = allProfiles();
  const name = profiles.find((p) => p.id === profileId)?.name ?? "";
  msg = prefixMessage(msg, profileMessagePrefix(name, profiles.length));
  const { failed } = await send(profileId, msg);
  process.exit(failed ? 1 : 0);
}

// --- Poll mode: long-poll Telegram for button taps; the webhook alternative ---
// for deployments without a public URL. Runs forever (the docker-notify sidecar
// keeps it alive alongside the hourly tick). The bot token and transport mode are
// global (a single bot serves every profile), so the run condition is global too;
// the callback handler resolves the acting profile per tap from the chat id.
// Config is re-read from the DB every iteration, so enabling/disabling in Settings
// applies within a poll cycle without a restart. The confirmed offset is persisted
// so taps survive restarts exactly once.
const POLL_OFFSET_KEY = "telegram_update_offset";
const POLL_WINDOW_SEC = 50;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function poll(): Promise<never> {
  log.info("telegram poller started");
  for (;;) {
    try {
      const { telegramBotToken, telegramMode } = getTelegramBotConfig();
      if (!telegramBotToken || telegramMode !== "poll") {
        // Not in polling mode (unconfigured, or webhook handles taps): idle and
        // recheck, so the sidecar can always run this unconditionally.
        await sleep(60_000);
        continue;
      }
      const offset = Number(getSetting(POLL_OFFSET_KEY)) || undefined;
      const updates = await getUpdates(offset, POLL_WINDOW_SEC);
      for (const u of updates) {
        try {
          if (u.callback_query) await handleCallbackQuery(u.callback_query);
        } catch (e) {
          // One bad tap must not wedge the queue — log, ack via offset, move on.
          log.error("poll: handling update failed", {
            update_id: u.update_id,
            err: e instanceof Error ? e : String(e),
          });
        }
        setSetting(POLL_OFFSET_KEY, String(u.update_id + 1));
      }
    } catch (e) {
      // Typically transient (network, or 409 while a webhook is still registered
      // — switch modes in Settings to clear it). Back off and retry.
      log.error("poll failed", { err: e instanceof Error ? e : String(e) });
      await sleep(15_000);
    }
  }
}

// Pull from a profile's connected pull-integrations once per tick. Best-effort: a
// sync failure must never affect the notification flow or the process exit code.
async function syncIntegrations(profileId: number) {
  try {
    if (getConnection(profileId, "strava")?.status === "connected") {
      const r = await runStravaSync(profileId);
      log.info("strava sync", { profile: profileId, ...(r as object) });
    }
  } catch (e) {
    log.error("strava sync failed", {
      profile: profileId,
      err: e instanceof Error ? e : String(e),
    });
  }
}

// Evaluate + send this hour's due slots for a single profile. Returns true if any
// configured channel failed. Never throws for an ordinary send failure (so one
// profile can't stop the loop); a thrown error is caught by the caller.
async function tickProfile(
  profile: ProfileRow,
  profileCount: number
): Promise<boolean> {
  // Runs every hour regardless of which notification slots are due.
  await syncIntegrations(profile.id);

  // Decide due slots by the profile's configured-TZ hour/weekday so scheduling
  // matches the user's clock regardless of the container's process TZ.
  const tz = getTimezone(profile.id);
  const now = new Date();
  const hour = hourInTz(tz, now);
  const weekday = weekdayInTz(tz, now);
  const date = today(profile.id);
  const sched = getNotifySchedule(profile.id);

  const dueSlots: { slot: string; build: () => NotificationMessage | null }[] =
    [];
  for (const w of ["Morning", "Midday", "Evening", "Bedtime"] as const) {
    const slotHour = sched.supplementHours[w];
    // Due across [slotHour, slotHour+1] so a DST-skipped hour or a failed send
    // still fires the next hour; the per-day dedup below prevents a double send.
    if (slotHour != null && slotDue(slotHour, hour))
      dueSlots.push({
        slot: `supp_${w}`,
        build: () => buildSupplementReminder(profile.id, w),
      });
  }
  if (sched.workoutEnabled) {
    const inf = inferWorkoutSchedule(profile.id);
    if (inf.weekdays.includes(weekday) && slotDue(inf.hour, hour))
      dueSlots.push({
        slot: "workout",
        build: () => buildWorkoutTargetReminder(profile.id),
      });
  }

  const prefix = profileMessagePrefix(profile.name, profileCount);
  let anyFailed = false;
  for (const { slot, build } of dueSlots) {
    const key = `notify_last_${slot}`;
    if (getProfileSetting(profile.id, key) === date) {
      log.info("already sent today", { profile: profile.id, slot });
      continue;
    }
    const built = build();
    if (!built) {
      log.info("nothing due", { profile: profile.id, slot });
      continue;
    }
    const msg = prefixMessage(built, prefix);
    const { delivered, failed } = await send(profile.id, msg);
    if (failed) anyFailed = true;
    // Mark once delivered to a channel so it isn't re-sent later today; if nothing
    // delivered (no channel / all failed) leave it unmarked so a retry can recover.
    if (delivered) setProfileSetting(profile.id, key, date);
  }

  // Missed-dose escalation (#103 Phase A): runs every hour regardless of which
  // slots are due, so a dose whose morning reminder already went out gets chased
  // later the same day. Its own per-dose/day dedup prevents repeat nudges.
  try {
    const esc = await runEscalations(
      profile.id,
      profile.name,
      date,
      hour,
      sched
    );
    if (esc.failed) anyFailed = true;
  } catch (e) {
    log.error("escalation check failed", {
      profile: profile.id,
      err: e instanceof Error ? e : String(e),
    });
    anyFailed = true;
  }

  // Low-supply refill nudge (#103 Phase B): runs every hour; its own per-item
  // "once per low-supply episode" dedup (cleared when an item is refilled) keeps
  // it from re-nagging daily.
  try {
    const rf = await runRefills(profile.id, profile.name, date);
    if (rf.failed) anyFailed = true;
  } catch (e) {
    log.error("refill check failed", {
      profile: profile.id,
      err: e instanceof Error ? e : String(e),
    });
    anyFailed = true;
  }

  // Morning digest (#135): one summary per profile per day at digest_hour (this
  // profile's timezone), hard-deduped so a bug can't spam a family chat at 7am.
  if (
    sched.digestHour != null &&
    slotDue(sched.digestHour, hour) &&
    getProfileSetting(profile.id, "notify_last_digest") !== date
  ) {
    try {
      const dg = await runDigest(profile.id, profile.name, date);
      if (dg.failed) anyFailed = true;
    } catch (e) {
      log.error("digest failed", {
        profile: profile.id,
        err: e instanceof Error ? e : String(e),
      });
      anyFailed = true;
    }
  }

  // "What's due" upcoming digest (#213 Phase 3): shares the digest_hour slot but
  // its own per-profile/day dedup key, so it coexists with the morning digest and
  // can't spam. Reuses collectUpcoming, so snooze/dismiss + training-restriction
  // apply automatically.
  if (
    sched.digestHour != null &&
    slotDue(sched.digestHour, hour) &&
    getProfileSetting(profile.id, "notify_last_upcoming") !== date
  ) {
    try {
      const ud = await runUpcomingDigest(profile.id, profile.name, date);
      if (ud.failed) anyFailed = true;
    } catch (e) {
      log.error("upcoming digest failed", {
        profile: profile.id,
        err: e instanceof Error ? e : String(e),
      });
      anyFailed = true;
    }
  }

  return anyFailed;
}

// --- Hourly tick: for every profile, decide which slots are due, dedupe, send. ---
// One profile's failure (a throw or a send failure) must not stop the others; the
// exit code aggregates failures across all profiles.
async function tick() {
  const profiles = allProfiles();
  let anyFailed = false;
  for (const p of profiles) {
    try {
      if (await tickProfile(p, profiles.length)) anyFailed = true;
    } catch (e) {
      log.error("profile tick failed", {
        profile: p.id,
        err: e instanceof Error ? e : String(e),
      });
      anyFailed = true;
    }
  }

  // Nightly SQLite backup (#131): global, so it runs once per tick (not per
  // profile) at the configured instance-timezone hour. A backup failure is
  // surfaced via the exit code but never stops the notification flow.
  try {
    const bk = runScheduledBackup();
    if (bk.ran) log.info("scheduled backup", { failed: bk.failed });
    if (bk.failed) anyFailed = true;
  } catch (e) {
    log.error("backup tick failed", {
      err: e instanceof Error ? e : String(e),
    });
    anyFailed = true;
  }

  // Audit-log retention (#22): global, once per tick. Deletes events past the
  // 90-day default. Best-effort (pruneAuditEvents never throws); a failure here
  // must never affect the notification flow or the exit code.
  const pruned = pruneAuditEvents();
  if (pruned > 0) log.info("pruned audit events", { pruned });

  process.exit(anyFailed ? 1 : 0);
}

// Parse the CLI: a positional slot ("poll"/"morning"/…) plus an optional
// `--profile <id>` (or `--profile=<id>`) that manual mode targets (default 1).
function parseArgs(argv: string[]): { slot?: string; profileId: number } {
  let profileId = 1;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--profile") {
      const v = Number(argv[++i]);
      if (Number.isInteger(v) && v > 0) profileId = v;
    } else if (a.startsWith("--profile=")) {
      const v = Number(a.slice("--profile=".length));
      if (Number.isInteger(v) && v > 0) profileId = v;
    } else {
      positional.push(a);
    }
  }
  return { slot: positional[0]?.toLowerCase(), profileId };
}

async function main() {
  const { slot, profileId } = parseArgs(process.argv.slice(2));
  if (slot === "poll") await poll();
  else if (slot) await manual(slot, profileId);
  else await tick();
}

main().catch((e) => {
  log.error("notify failed", { err: e instanceof Error ? e : String(e) });
  process.exit(1);
});
