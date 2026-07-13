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

import "./load-env";

import {
  buildSupplementReminder,
  type ReminderWindow,
} from "../lib/notifications/supplements";
import { buildWorkoutTargetReminder } from "../lib/notifications/workouts";
import { buildFoodNudge } from "../lib/notifications/food";
import { FOOD_NUDGE_WINDOWS } from "../lib/notifications/food-format";
import { dispatch, prefixForProfile } from "../lib/notifications";
import {
  prefixMessage,
  type NotificationMessage,
} from "../lib/notifications/types";
import {
  getNotifySchedule,
  getSetting,
  setSetting,
  getProfileSetting,
  setProfileSetting,
  getProfileFoodTelegram,
  getTimezone,
  getTelegramBotConfig,
  getAuditRetentionMonths,
} from "../lib/settings";
import { getUpdates } from "../lib/notifications/telegram";
import { handleCallbackQuery } from "../lib/notifications/telegram-callbacks";
import { runEscalations } from "../lib/notifications/escalate";
import { runRefills } from "../lib/notifications/refill";
import { runPreventive } from "../lib/notifications/preventive";
import { runDigest } from "../lib/notifications/digest-data";
import { runUpcomingDigest } from "../lib/notifications/upcoming-digest-data";
import { runWeeklyRecap } from "../lib/notifications/weekly-recap-data";
import { runMilestones } from "../lib/milestones-db";
import { runScheduledBackup } from "../lib/backup";
import { pruneAuditEvents } from "../lib/audit";
import { sweepDeletedRows } from "../lib/undo-delete-db";
import { sweepReplayedKeys } from "../lib/offline/writes";
import { reapStuckExtractions } from "../lib/extraction-reaper";
import {
  inferWorkoutSchedule,
  runCoachingEpisode,
  gatherCoachingInput,
} from "../lib/queries";
import type { CoachingInput } from "../lib/coaching";
import { slotDue, inWakingWindow } from "../lib/notifications/schedule";
import { db, today, checkpointWal } from "../lib/db";
import { hourInTz, weekdayInTz } from "../lib/date";
import { createLogger } from "../lib/log";
import {
  getConnection,
  pruneSyncEvents,
} from "../lib/integrations/connections";
import { runStravaSync } from "../lib/integrations/strava-sync";
import { runOuraSync } from "../lib/integrations/oura-sync";
import { runWithingsSync } from "../lib/integrations/withings-sync";

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
  msg = prefixMessage(msg, prefixForProfile(profileId));
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
  try {
    if (getConnection(profileId, "oura")?.status === "connected") {
      const r = await runOuraSync(profileId);
      log.info("oura sync", { profile: profileId, ...(r as object) });
    }
  } catch (e) {
    log.error("oura sync failed", {
      profile: profileId,
      err: e instanceof Error ? e : String(e),
    });
  }
  try {
    if (getConnection(profileId, "withings")?.status === "connected") {
      const r = await runWithingsSync(profileId);
      log.info("withings sync", { profile: profileId, ...(r as object) });
    }
  } catch (e) {
    log.error("withings sync failed", {
      profile: profileId,
      err: e instanceof Error ? e : String(e),
    });
  }
}

// Evaluate + send this hour's due slots for a single profile. Returns true if any
// configured channel failed. Never throws for an ordinary send failure (so one
// profile can't stop the loop); a thrown error is caught by the caller.
async function tickProfile(profile: ProfileRow): Promise<boolean> {
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

  // The full coaching gather (complete strength/cardio scan + 42×1440 HR-minute
  // rows) is this profile's heaviest per-tick read, and BOTH the workout-reminder
  // slot (recommendWorkout) and the rest-episode reconcile (runCoachingEpisode)
  // consume it. Request-scoped caching is identity outside Next (#386), so the tick
  // used to run it twice. Gather it at most ONCE per profile per tick, lazily (only
  // if a consumer actually runs), and thread it to both (#447). Units don't affect
  // the rest/workout decisions, so the canonical "kg"/"km" both consumers already
  // pass is used here too.
  let coachingInputCache: CoachingInput | undefined;
  const coachingInput = (): CoachingInput =>
    (coachingInputCache ??= gatherCoachingInput(profile.id, "kg", "km"));

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
  // Food-log nudge (#682): opt-in per profile, riding the SAME morning/midday/evening
  // supplement slot hours (no separate schedule — "same times as supplements"). Its
  // own per-day dedup marker (notify_last_food_<Window>) and its own build, so it
  // coexists with the supplement reminder in the same slot. Bedtime is deliberately
  // excluded. buildFoodNudge returns null for a life stage where food logging is
  // hidden (infant), which the dueSlots loop treats as "nothing due".
  if (getProfileFoodTelegram(profile.id)) {
    for (const w of FOOD_NUDGE_WINDOWS) {
      const slotHour = sched.supplementHours[w];
      if (slotHour != null && slotDue(slotHour, hour))
        dueSlots.push({
          slot: `food_${w}`,
          build: () => buildFoodNudge(profile.id, w, date),
        });
    }
  }
  if (sched.workoutEnabled) {
    const inf = inferWorkoutSchedule(profile.id);
    if (inf.weekdays.includes(weekday) && slotDue(inf.hour, hour))
      dueSlots.push({
        slot: "workout",
        build: () => buildWorkoutTargetReminder(profile.id, coachingInput()),
      });
  }

  const prefix = prefixForProfile(profile.id);
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

  // Missed-dose escalation: runs every hour regardless of which
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

  // The non-time-critical episode nudges (refill, preventive, milestone) have no
  // slot of their own and would otherwise fire the instant an episode becomes due
  // — commonly the local-midnight date rollover, or 1-3am after a late sync / a
  // late button-tap that crosses a threshold (#378). Hold them to a humane
  // profile-local waking window; their once-per-episode dedup is unchanged (a held
  // nudge simply isn't sent yet, and re-evaluates on the next in-window tick). The
  // window is the profile's own quiet-hours setting (#450, defaulting to 8→21), so a
  // night-shift rhythm can shift it. The safety-tier senders above (dose reminders,
  // escalation) stay ungated — they must never consult quiet hours.
  const waking = inWakingWindow(
    hour,
    sched.wakingStartHour,
    sched.wakingEndHour
  );

  // Low-supply refill nudge: runs every waking-hour tick; its own per-item
  // "once per low-supply episode" dedup (cleared when an item is refilled) keeps
  // it from re-nagging daily.
  if (waking) {
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
  }

  // Preventive-care nudge (#87): its own per-rule "once per due episode" dedup
  // (cleared when an item is satisfied / no longer due) keeps it from re-nagging
  // daily. Gated by the per-profile preventive toggle. Also gated to once per
  // profile-local DAY (#447): the full medical-records inference it runs answers
  // "what's due as of today", which only changes at the date rollover, and #378
  // already windows the sends — so re-running it every waking hour is pure
  // duplicated work. Mark it assessed only after a clean run so a failed send still
  // retries next waking hour; a newly-due item that crosses its threshold mid-day is
  // then picked up on the next date's first waking tick (a day-granularity tradeoff
  // the episode question already accepts). The safety-tier senders (dose reminders,
  // escalation) above stay ungated.
  if (
    waking &&
    getProfileSetting(profile.id, "notify_preventive_assessed") !== date
  ) {
    try {
      const pv = await runPreventive(profile.id, profile.name, date);
      if (pv.failed) anyFailed = true;
      else setProfileSetting(profile.id, "notify_preventive_assessed", date);
    } catch (e) {
      log.error("preventive check failed", {
        profile: profile.id,
        err: e instanceof Error ? e : String(e),
      });
      anyFailed = true;
    }
  }

  // Coaching rest-episode continuity (#44 item 3b): advance/clear the persisted
  // rest-nudge marker each hour so a multi-day easy stretch reads as "second easy
  // day" on the dashboard/Training surfaces instead of a fresh alert. No send —
  // it only maintains the marker (mirrors the refill nudge's episode dedup) so the
  // condition is tracked daily even when the user doesn't open a coaching surface.
  try {
    runCoachingEpisode(profile.id, coachingInput());
  } catch (e) {
    log.error("coaching episode reconcile failed", {
      profile: profile.id,
      err: e instanceof Error ? e : String(e),
    });
  }

  // Morning digest: one summary per profile per day at digest_hour (this
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

  // "What's due" upcoming digest: shares the digest_hour slot but
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

  // Weekly recap (#32): once a week, on the chosen weekday at weeklyRecapHour
  // (this profile's timezone). Own per-profile/day dedup key — the recap only
  // triggers on its weekday, and the same-day marker prevents a double send, so
  // next week's same weekday (a new date) fires again.
  if (
    sched.weeklyRecapDay != null &&
    weekday === sched.weeklyRecapDay &&
    slotDue(sched.weeklyRecapHour ?? 9, hour) &&
    getProfileSetting(profile.id, "notify_last_weekly_recap") !== date
  ) {
    try {
      const wr = await runWeeklyRecap(profile.id, profile.name, date);
      if (wr.failed) anyFailed = true;
    } catch (e) {
      log.error("weekly recap failed", {
        profile: profile.id,
        err: e instanceof Error ? e : String(e),
      });
      anyFailed = true;
    }
  }

  // Milestones (#32): runs every waking-hour tick (#378). The milestones table IS
  // the once-only fired marker, so re-running is idempotent — an already-recorded
  // milestone never re-fires; a newly-crossed one is recorded to the timeline and
  // (unless the profile opted out) announced once. Recording + announcing are
  // gated together on the waking window rather than announcing-only: the table is
  // the fired marker, so recording a crossing at 3am then skipping the send would
  // permanently suppress the announcement (it'd read as "already fired" next
  // tick). Cumulative milestones can't regress within a day, so deferring the
  // record to a waking hour never loses one.
  if (waking) {
    try {
      const ms = await runMilestones(profile.id, profile.name, date);
      if (ms.failed) anyFailed = true;
    } catch (e) {
      log.error("milestone check failed", {
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
      if (await tickProfile(p)) anyFailed = true;
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

  // Audit-log retention (#22, window configurable per #98): global, once per tick.
  // Deletes events past the admin-configured window (Settings → Server; generous
  // 24-month default). Best-effort (pruneAuditEvents never throws); a failure here
  // must never affect the notification flow or the exit code.
  const pruned = pruneAuditEvents({ maxMonths: getAuditRetentionMonths() });
  if (pruned > 0) log.info("pruned audit events", { pruned });

  // Undo-window sweep (#30): global, once per tick. Purges undo holding rows older
  // than 24h so a deleted row is genuinely gone after the window. Best-effort
  // (sweepDeletedRows never throws); never affects the notification flow/exit code.
  const swept = sweepDeletedRows();
  if (swept > 0) log.info("swept expired undo rows", { swept });

  // Offline-replay ledger sweep (#98): global, once per tick. Prunes replayed_keys
  // rows older than the replay-race window (~7 days) so the idempotency ledger
  // doesn't grow forever. Best-effort (sweepReplayedKeys never throws); never
  // affects the notification flow/exit code.
  try {
    const sweptKeys = sweepReplayedKeys();
    if (sweptKeys > 0) log.info("swept expired replay keys", { sweptKeys });
  } catch (e) {
    log.error("replay-key sweep failed", {
      err: e instanceof Error ? e : String(e),
    });
  }

  // Sync-event retention sweep (#388): global, once per tick. integration_sync_events
  // gains a row per provider per hourly tick and was the one tick sibling nothing
  // pruned. Keeps the last 90 days plus the newest event per (profile, provider).
  // Best-effort (pruneSyncEvents never throws); never affects the notification
  // flow/exit code.
  try {
    const prunedSync = pruneSyncEvents();
    if (prunedSync > 0) log.info("pruned sync events", { prunedSync });
  } catch (e) {
    log.error("sync-event prune failed", {
      err: e instanceof Error ? e : String(e),
    });
  }

  // Stuck-extraction lease reap (#135 item 4): global, once per tick. Boot already
  // clears extractions a crash left mid-flight, but a process that stays up with a
  // hung extraction leaves the row spinning on 'processing' forever — this fails any
  // whose lease ran past the timeout. Best-effort; a failure must never affect the
  // notification flow or exit code.
  try {
    const reaped = reapStuckExtractions();
    if (reaped > 0) log.info("reaped stuck extractions", { reaped });
  } catch (e) {
    log.error("stuck-extraction reap failed", {
      err: e instanceof Error ? e : String(e),
    });
  }

  // WAL checkpoint (#135 item 6): global, once per tick. Three processes share the
  // DB file and nothing else forces a checkpoint, so the write-ahead log can grow
  // unbounded on the shared mount. TRUNCATE flushes it back into the main DB and
  // shrinks the -wal file. Best-effort — a busy checkpoint just does less and is
  // retried next tick; a failure must never affect the notification flow/exit code.
  try {
    checkpointWal();
  } catch (e) {
    log.error("wal checkpoint failed", {
      err: e instanceof Error ? e : String(e),
    });
  }

  // NOTE (#135 item 7 — notification at-least-once duplicate window): dedup markers
  // (notify_last_*) are written AFTER a successful send, so a crash in the send→mark
  // gap re-sends that slot once on the next tick. This is WONTFIX BY DESIGN: for
  // health reminders a rare duplicate ("take your medication") is strictly safer
  // than a silently missed one, and closing the window fully would need a
  // send-intent/outbox record with its own failure modes. Running two schedulers
  // concurrently (the compose poll sidecar AND a host crontab tick) widens this
  // window — operators should run exactly ONE tick scheduler; the poll sidecar is
  // only for inbound button taps and does not itself send scheduled reminders.

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
