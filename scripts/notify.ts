// Outbound notification entrypoint.
//
//   npm run notify                 # THE TICK — run on a fixed cadence (the docker
//                                  # sidecar every 15 min; an hourly host cron also
//                                  # works); for EACH profile sends whichever
//                                  # notifications are scheduled for the current
//                                  # profile-local minute (and not already sent
//                                  # today). The tick observes its own cadence and
//                                  # sizes the slot windows from it.
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
  buildIntakeReminderForSlots,
  getPreWorkoutSlotMinute,
  type IntakeSendSlot,
  type ReminderWindow,
} from "../lib/notifications/supplements";
import {
  buildHouseholdRound,
  householdRoundMarkerKey,
} from "../lib/notifications/household-round";
import { buildWorkoutTargetReminder } from "../lib/notifications/workouts";
import { buildPracticeReminder } from "../lib/notifications/practices";
import { buildFoodNudge } from "../lib/notifications/food";
import { FOOD_NUDGE_WINDOWS } from "../lib/notifications/food-format";
// Every per-day send marker this tick writes is minted by a DECLARED builder (#2036),
// never composed from a free-form slot string — see lib/notifications/send-markers.ts.
import {
  DIGEST_MARKER_KEY,
  TICK_SLOT_MARKER_KEYS,
  WEEKLY_RECAP_MARKER_KEY,
  foodNudgeMarkerKey,
  intakeSlotMarkerKey,
} from "../lib/notifications/send-markers";
import { buildMoodCheckin } from "../lib/notifications/mood";
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
  getProfileMoodCheckin,
  bumpMoodCheckinIgnored,
  getTimezone,
  getTelegramBotConfig,
  getAuditRetentionMonths,
  getTrashRetentionDays,
  getPublicUrl,
} from "../lib/settings";
import { getUpdates, telegramChannel } from "../lib/notifications/telegram";
import {
  handleCallbackQuery,
  handleIncomingMessage,
} from "../lib/notifications/telegram-callbacks";
import { runEscalations } from "../lib/notifications/escalate";
import { runRedoseNotices } from "../lib/notifications/redose";
import {
  runPostWorkoutFinish,
  runStaleWorkoutSuggest,
} from "../lib/notifications/workout-presence";
import { flushPostWorkoutDispatches } from "../lib/notifications/post-workout-queue";
import { runRefills } from "../lib/notifications/refill";
import { runPoolRefills } from "../lib/notifications/supply-pool";
import { runPreventive } from "../lib/notifications/preventive";
import { runIllnessCare } from "../lib/notifications/illness-care";
import { runFollowUpNudges } from "../lib/notifications/followup";
import { runEaseBack } from "../lib/notifications/ease-back";
import { runTempRedFlag } from "../lib/notifications/temp-red-flag";
import {
  deferDigestForSleep,
  refreshDigestOfferTail,
  runDigest,
} from "../lib/notifications/digest-data";
import { reconcileProfileMessages } from "../lib/notifications/reconcile";
import { runInTickScope } from "../lib/tick-cache";
import { beginNotifyRun } from "../lib/notify-log";
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
import {
  slotDue,
  inWakingWindow,
  observedTickMinutes,
} from "../lib/notifications/schedule";
import { db, today, checkpointWal } from "../lib/db";
import { minuteOfDayInTz, weekdayInTz } from "../lib/date";
import { createLogger } from "../lib/log";
import { pruneSyncEvents } from "../lib/integrations/connections";
import { syncIntegrations } from "../lib/integrations/pull-tick";
import { evaluateSyncRequests } from "../lib/portal-requests";

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
  else if (arg === "practice") msg = buildPracticeReminder(profileId);
  else if (WINDOWS[arg]) msg = buildSupplementReminder(profileId, WINDOWS[arg]);
  else {
    console.error(
      "Usage: npm run notify -- <morning|midday|evening|bedtime|workout|practice> [--profile <id>]"
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
          else if (u.message) await handleIncomingMessage(u.message);
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

// Evaluate + send this tick's due slots for a single profile. Returns true if any
// configured channel failed. Never throws for an ordinary send failure (so one
// profile can't stop the loop); a thrown error is caught by the caller.
// `tickMinutes` is the observed scheduler cadence — it sizes slotDue's attempt
// bands so every slot gets exactly two attempts, an hour apart, at any tick rate
// (the decided #2121 retry budget; see lib/notifications/schedule.ts).
async function tickProfile(
  profile: ProfileRow,
  tickMinutes: number
): Promise<boolean> {
  // THE PULL PASS, ON ITS OWN CADENCE (#2121 step 1). Runs on every tick regardless
  // of which notification slots are due — but a provider is POLLED only once per its
  // registry-declared cadence window (hourly for all four today). That is the whole
  // decoupling: everything below this line is "what is due to send", bounded only by
  // this process's ~0.5 s boot and free to be evaluated as often as the scheduler
  // fires; the line itself is "call someone else's API", bounded by their quota. A
  // finer tick multiplies the former and not the latter. The loop and its guard live
  // in lib/integrations/pull-tick.ts so both halves are testable.
  await syncIntegrations(profile.id);

  // Decide due slots by the profile's configured-TZ minute-of-day/weekday so
  // scheduling matches the user's clock regardless of the container's process TZ.
  const tz = getTimezone(profile.id);
  const now = new Date();
  const minute = minuteOfDayInTz(tz, now);
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

  const prefix = prefixForProfile(profile.id);
  let anyFailed = false;

  // ── Supplement dose reminders: ONE merged send per tick (#1154) ────────────
  // Every slot due (and unsent) this tick — the four fixed windows plus the
  // workout-relative PreWorkout pseudo-slot — coalesces into ONE message, so two
  // windows configured at the same time (or the pseudo-slot colliding with a
  // window) can never double-notify. Each slot keeps its own per-day marker
  // (notify_last_supp_<slot>); every slot that contributed entries to a
  // delivered merged send is marked, so none re-fires today. A slot whose gather
  // is empty stays unmarked and re-evaluates on its retry attempt (the classic
  // retry).
  const intakeSlotsDue: IntakeSendSlot[] = [];
  for (const w of ["Morning", "Midday", "Evening", "Bedtime"] as const) {
    const slotMinute = sched.supplementMinutes[w];
    // Due on the slot's two attempt bands (first tick at/after the time, first
    // tick an hour later) so a DST-skipped hour or a failed send still fires on
    // the retry attempt; the per-day dedup prevents a double send.
    if (
      slotMinute != null &&
      slotDue(slotMinute, minute, tickMinutes) &&
      getProfileSetting(profile.id, intakeSlotMarkerKey(w)) !== date
    )
      intakeSlotsDue.push(w);
  }
  // The PreWorkout pseudo-slot (#1154 Fix A): `anytime` + `pre_workout` doses
  // fire ~an hour before the inferred training hour instead of folding into the
  // Morning window. Gated on intake reminders being on at all (any window
  // configured) — turning every window off silences this too.
  if (
    Object.values(sched.supplementMinutes).some((m) => m != null) &&
    getProfileSetting(profile.id, intakeSlotMarkerKey("PreWorkout")) !== date
  ) {
    const preMinute = getPreWorkoutSlotMinute(profile.id);
    if (preMinute != null && slotDue(preMinute, minute, tickMinutes))
      intakeSlotsDue.push("PreWorkout");
  }
  if (intakeSlotsDue.length > 0) {
    const built = buildIntakeReminderForSlots(profile.id, intakeSlotsDue);
    if (!built) {
      log.info("nothing due", {
        profile: profile.id,
        slots: intakeSlotsDue.join(","),
      });
    } else {
      const { delivered, failed } = await send(
        profile.id,
        prefixMessage(built.message, prefix)
      );
      if (failed) anyFailed = true;
      // Mark each contributing slot once delivered so none re-sends later today;
      // if nothing delivered (no channel / all failed) leave unmarked so a retry
      // can recover.
      if (delivered) {
        for (const s of built.slots)
          setProfileSetting(profile.id, intakeSlotMarkerKey(s), date);
      }
    }
  }

  // ── Household dose round (#1459) ──────────────────────────────────────────
  // The caregiver-subscribed CROSS-PROFILE twin of the reminder above: at THIS
  // profile's slots, the doses due for the OTHER household members they explicitly
  // subscribed to, each with an inline confirm. It rides the same tick and the same
  // schedule slots but keeps its OWN per-day markers, so a receiver whose personal
  // reminder already fired this slot still gets the round (and vice versa).
  //
  // Each member's due set is computed in THAT member's own context — their timezone's
  // today(), their situations, their dueness — never in the receiver's (#1095). The
  // members' own reminders and their missed-dose escalation are completely untouched:
  // this is additive, and escalation is deliberately NOT aggregated here (§4).
  //
  // The PreWorkout pseudo-slot is deliberately excluded: it is workout-relative to the
  // RECEIVER, which says nothing about when another member's doses are due.
  const householdSlotsDue: IntakeSendSlot[] = [];
  for (const w of ["Morning", "Midday", "Evening", "Bedtime"] as const) {
    const slotMinute = sched.supplementMinutes[w];
    if (
      slotMinute != null &&
      slotDue(slotMinute, minute, tickMinutes) &&
      getProfileSetting(profile.id, householdRoundMarkerKey(w)) !== date
    )
      householdSlotsDue.push(w);
  }
  if (householdSlotsDue.length > 0) {
    // Returns null for an empty round (nothing due for any subscribed member) — a
    // caregiver is never pinged just to be told there is nothing to do.
    const round = buildHouseholdRound(profile.id, householdSlotsDue);
    if (round) {
      const { delivered, failed } = await send(
        profile.id,
        prefixMessage(round, prefix)
      );
      if (failed) anyFailed = true;
      if (delivered) {
        for (const s of householdSlotsDue)
          setProfileSetting(profile.id, householdRoundMarkerKey(s), date);
      }
    }
  }

  const dueSlots: {
    // The label used for logging only. The MARKER is `markerKey`, minted by a declared
    // builder (#2036) — the key used to be composed as `notify_last_${slot}` from this
    // free-form string, which made it invisible to the send-marker scan.
    slot: string;
    markerKey: string;
    build: () => NotificationMessage | null;
    // Optional post-delivery hook (e.g. the mood check-in's ignored-days bump).
    onDelivered?: () => void;
  }[] = [];
  // Food-log nudge (#682): opt-in per profile, riding the SAME morning/midday/evening
  // supplement slot hours (no separate schedule — "same times as supplements"). Its
  // own per-day dedup marker (notify_last_food_<Window>) and its own build, so it
  // coexists with the supplement reminder in the same slot. Bedtime is deliberately
  // excluded. buildFoodNudge returns null for a life stage where food logging is
  // hidden (infant), which the dueSlots loop treats as "nothing due".
  //
  // Gated on Telegram actually being deliverable, not just the opt-in flag: the nudge
  // is a button-driven Telegram feature (the buttons do nothing on a channel that
  // can't render them), and the flag can linger "on" after Telegram is disabled (the
  // Settings toggle is hidden once Telegram is off). This keeps a profile with the
  // stale flag but no Telegram from building a food nudge at all. The push channel
  // ALSO self-gates food-kind messages (isPushDeliverableKind, #692), which is what
  // stops the both-channels case — Telegram AND Web Push on — from fanning the nudge
  // out to a content-less "tap what you've eaten" push alongside the real Telegram one.
  if (
    getProfileFoodTelegram(profile.id) &&
    telegramChannel.isConfigured(profile.id)
  ) {
    for (const w of FOOD_NUDGE_WINDOWS) {
      const slotMinute = sched.supplementMinutes[w];
      if (slotMinute != null && slotDue(slotMinute, minute, tickMinutes))
        dueSlots.push({
          slot: `food_${w}`,
          markerKey: foodNudgeMarkerKey(w),
          build: () => buildFoodNudge(profile.id, w, date),
        });
    }
  }
  // Daily mood check-in (#992): opt-in per profile (off by default), riding the
  // EVENING supplement slot hour — a gentle end-of-day ask, no schedule of its
  // own. buildMoodCheckin returns null when the day is already logged or the
  // check-in has AUTO-PAUSED after MOOD_CHECKIN_AUTOPAUSE_DAYS ignored sends
  // (shouldSendMoodCheckin, lib/mood.ts) — the dueSlots loop treats null as
  // "nothing due". A DELIVERED send bumps the ignored counter; every submitted
  // check-in (card / offline replay / Telegram tap) resets it via upsertMoodLog,
  // re-arming the reminder. Ignoring it never escalates anything.
  if (getProfileMoodCheckin(profile.id)) {
    const slotMinute = sched.supplementMinutes.Evening;
    if (slotMinute != null && slotDue(slotMinute, minute, tickMinutes))
      dueSlots.push({
        slot: "mood_checkin",
        markerKey: TICK_SLOT_MARKER_KEYS.mood_checkin,
        build: () => buildMoodCheckin(profile.id, date),
        onDelivered: () => bumpMoodCheckinIgnored(profile.id),
      });
  }
  if (sched.workoutEnabled) {
    const inf = inferWorkoutSchedule(profile.id);
    // The inferred training hour joins the minute vocabulary at :00 — the
    // inference itself is hour-grain (the mode over start hours).
    if (
      inf.weekdays.includes(weekday) &&
      slotDue(inf.hour * 60, minute, tickMinutes)
    )
      dueSlots.push({
        slot: "workout",
        markerKey: TICK_SLOT_MARKER_KEYS.workout,
        build: () =>
          buildWorkoutTargetReminder(profile.id, coachingInput(), now),
      });
  }

  for (const { slot, markerKey, build, onDelivered } of dueSlots) {
    if (getProfileSetting(profile.id, markerKey) === date) {
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
    if (delivered) {
      setProfileSetting(profile.id, markerKey, date);
      onDelivered?.();
    }
  }

  // Missed-dose escalation: runs every tick regardless of which
  // slots are due, so a dose whose morning reminder already went out gets chased
  // later the same day. Its own per-dose/day dedup prevents repeat nudges; a
  // finer tick only shrinks how long past the wait the chase lands.
  try {
    const esc = await runEscalations(
      profile.id,
      profile.name,
      date,
      minute,
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

  // PRN redose notice (#798): safety-tier, armed by an actual administration, one-shot
  // per administration. Like escalation it runs every tick regardless of slots AND —
  // deliberately — regardless of the waking window (a redose due at 3am is the
  // overnight fever case; the notice can only fire from a dose the user logged). Its
  // own per-item/administration marker (notify_last_redose_<itemId>) dedups.
  try {
    const rd = await runRedoseNotices(profile.id, profile.name, date, now);
    if (rd.failed) anyFailed = true;
  } catch (e) {
    log.error("redose notice check failed", {
      profile: profile.id,
      err: e instanceof Error ? e : String(e),
    });
    anyFailed = true;
  }

  // Finish-triggered post-workout dose reminder (#921): the moment a session
  // transitions to `finished` (derived workout presence), deliver its due,
  // unresolved post_workout doses immediately instead of waiting for the next
  // scheduled supplement slot. Safety tier like the dose reminders above —
  // ungated by the waking window (timed to a real event) and never bus-gated. The
  // 60-min finished window guarantees an hourly tick observes every finish; the
  // per-activity one-shot marker keeps it from repeating, and the scheduled slot
  // remains the fallback when a finish was never observed.
  try {
    const pw = await runPostWorkoutFinish(profile.id, now);
    if (pw.failed) anyFailed = true;
  } catch (e) {
    log.error("post-workout finish nudge failed", {
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
    minute,
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

  // Illness-care nudge (#805): a logged symptom in the current open illness episode
  // that has crossed a CITED duration/trajectory care line. Care-tier + bus-gated
  // (a page dismissal silences the push), its own per-finding "once per episode"
  // dedup, and — like preventive — assessed once per profile-local DAY (the episode
  // assembly answers "as of today", which only changes at the date rollover, and
  // #378 already windows the sends to the waking hours). Mark assessed only after a
  // clean run so a failed send retries next waking hour. The safety-tier senders
  // (dose reminders, escalation, PRN redose) above stay ungated.
  if (
    waking &&
    getProfileSetting(profile.id, "notify_illnesscare_assessed") !== date
  ) {
    try {
      const ic = await runIllnessCare(profile.id, profile.name, date);
      if (ic.failed) anyFailed = true;
      else setProfileSetting(profile.id, "notify_illnesscare_assessed", date);
    } catch (e) {
      log.error("illness-care check failed", {
        profile: profile.id,
        err: e instanceof Error ? e : String(e),
      });
      anyFailed = true;
    }
  }

  // Overdue safety-follow-up escalation (#1866): a tracked finding follow-up (#700)
  // past its planned date. Care-tier SAFETY posture with ZERO settings: the tracked
  // due date is the consent (the dose-reminder structure), delivery rides only the
  // channels already enabled, and the ONLY permanent off-switch is the per-item
  // resolve/decline terminator. NOT bus-gated by a dismiss — the send honors the
  // item's own "snooze-only" policy through isHiddenUnderPolicy (a live snooze
  // freezes it; a dismiss is resisted, exactly as on the page). Conservative
  // two-send cadence owned by the pure planner (crossing + one repeat, then
  // silence). Overdue-ness is day-granular, so like preventive/illness-care it is
  // assessed once per profile-local day, inside the waking window (#378 — this is
  // an escalation about something already months late; 3am urgency would be
  // manufactured). Mark assessed only after a clean run so a failed send retries
  // next waking hour.
  if (
    waking &&
    getProfileSetting(profile.id, "notify_followup_assessed") !== date
  ) {
    try {
      const fu = await runFollowUpNudges(profile.id, profile.name, date);
      if (fu.failed) anyFailed = true;
      else setProfileSetting(profile.id, "notify_followup_assessed", date);
    } catch (e) {
      log.error("followup escalation check failed", {
        profile: profile.id,
        err: e instanceof Error ? e : String(e),
      });
      anyFailed = true;
    }
  }

  // Single-reading temperature red flags (#859 item 3) — a sibling care-tier,
  // bus-gated nudge. Assessed EVERY waking tick (#1025): the once-per-day gate the
  // illness-care/preventive jobs use was over-copied here — their inputs are
  // day-granular, but this one's input is the episode's LATEST reading, which
  // changes intra-day exactly during the fever days that matter (a 2 PM 104 °F
  // reading used to wait for tomorrow's first tick). The run is cheap (the open
  // episode's latest reading + one dataset lookup), and dedup is owned by the
  // per-finding marker inside runTempRedFlag (the dedupeKey embeds the reading's
  // date + rule) plus the shared suppression bus — so re-running never re-nags.
  // The tick is now the FALLBACK for readings that arrive without an event; the
  // write paths dispatch immediately (dispatchTempRedFlagForReading, quiet-hours
  // exempt like redose — the overnight logging caregiver is awake by definition).
  if (waking) {
    try {
      const trf = await runTempRedFlag(profile.id, profile.name, date);
      if (trf.failed) anyFailed = true;
    } catch (e) {
      log.error("temp-red-flag check failed", {
        profile: profile.id,
        err: e instanceof Error ? e : String(e),
      });
      anyFailed = true;
    }
  }

  // Pace-aware wellness-practice nudge (#1259): waking-window, once per profile-local
  // day, BUS-GATED coaching-tier. buildPracticeReminder returns null when nothing is
  // behind OR every behind target's `practice:<id>` Upcoming twin is dismissed/snoozed
  // (the frozen state — no marker set, so un-dismissing resumes the lifecycle). A
  // practice target only exists once the user created a practice protocol (that IS the
  // opt-in). NEVER safety-tier — a missed session is not a missed medication.
  //
  // No longer gated on Telegram (#1718): the message now carries a deep link and copy
  // that names no affordance a channel strips, so it is honest on every channel. The
  // old gate also failed at the both-channels case it was written for — it let a
  // Telegram+push profile through and then dispatched a buttonless push telling the
  // user to "tap when you've done a session".
  //
  // RHYTHM-RETIMED (#2188): the passed moment lets a behind practice with an
  // inferred weekly rhythm hold for its next predicted day and typical hour
  // (practiceNudgeReleased, lib/practice.ts) — only ever LATER than this gate
  // within the week, with the flip-day rule back the moment the week's last
  // predicted day has passed. A practice with no pattern is released
  // unconditionally, so this block's own gates ARE its behavior, unchanged. The
  // waking gate and per-day marker here stay exactly as they were: a held
  // practice simply isn't in the gather, so an empty build leaves the marker
  // unset and the slot re-evaluates next waking tick.
  if (
    waking &&
    getProfileSetting(profile.id, TICK_SLOT_MARKER_KEYS.practice) !== date
  ) {
    try {
      const built = buildPracticeReminder(
        profile.id,
        undefined,
        getPublicUrl(),
        {
          weekday,
          minuteOfDay: minute,
          wakingStartHour: sched.wakingStartHour,
          wakingEndHour: sched.wakingEndHour,
        }
      );
      if (built) {
        const msg = prefixMessage(built, prefix);
        const { delivered, failed } = await send(profile.id, msg);
        if (failed) anyFailed = true;
        if (delivered)
          setProfileSetting(profile.id, TICK_SLOT_MARKER_KEYS.practice, date);
      }
    } catch (e) {
      log.error("practice nudge failed", {
        profile: profile.id,
        err: e instanceof Error ? e : String(e),
      });
      anyFailed = true;
    }
  }

  // Coaching rest-episode continuity (#44 item 3b): advance/clear the persisted
  // rest-nudge marker each hour so a multi-day easy stretch reads as a persisting
  // recommendation ("Rest or take it easy — Nth day", #752) on the
  // dashboard/Training surfaces instead of a fresh alert. No send —
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

  // Post-illness ease-back (#837): the one-shot re-entry nudge the first waking tick
  // after a flagged-illness episode closes. Reuses the shared coaching gather (its
  // illness context knows the just-closed episode); one-shot per episode via a
  // per-id marker, so it never re-fires. Waking-gated like the other coaching-adjacent
  // sends. The workout slot itself stays quiet through the ramp (recommendWorkout).
  if (waking) {
    try {
      const eb = await runEaseBack(
        profile.id,
        profile.name,
        coachingInput(),
        date
      );
      if (eb.failed) anyFailed = true;
    } catch (e) {
      log.error("ease-back nudge failed", {
        profile: profile.id,
        err: e instanceof Error ? e : String(e),
      });
      anyFailed = true;
    }
  }

  // Stale-session suggest (#921/#560): an `active` workout draft that's gone quiet
  // past STALE_MIN gets ONE gentle "Still working out? Finish or discard" nudge —
  // suggest-only, deep-links back to the session, NEVER auto-ends. One-shot per
  // activity id; waking-gated (a soft coaching suggest, not a safety signal).
  if (waking) {
    try {
      const sw = await runStaleWorkoutSuggest(profile.id, profile.name, now);
      if (sw.failed) anyFailed = true;
    } catch (e) {
      log.error("stale-workout suggest failed", {
        profile: profile.id,
        err: e instanceof Error ? e : String(e),
      });
      anyFailed = true;
    }
  }

  // Morning digest: ONE merged summary per profile per day at digest_hour (this
  // profile's timezone), hard-deduped so a bug can't spam a family chat at 7am. As
  // of #1108 the "what's due" list is the digest's Today section — one message, one
  // due-today computation (collectUpcoming), one per-day marker (notify_last_digest);
  // the old separate upcoming digest + its notify_last_upcoming marker are retired.
  //
  // ONE DEFERRAL (#2102). `slotDue` is already two attempt bands paired with a hard
  // per-day marker, so the FIRST attempt is free to decline: when last night's
  // sleep is pending but expected, this tick is skipped and the retry attempt —
  // an hour later, at every tick rate — sends the digest with the Sleep section in
  // it. It can only ever happen once — deferDigestForSleep returns false the moment
  // this tick is not the slot's "first" band — so the retry attempt sends whether
  // or not the sleep ever landed, and the digest's other sections are never held
  // hostage. Nothing is written by the decline: the marker is still set only by a
  // real send, so a deferred-then-sent digest records its pointer, stamp and cursor
  // exactly as an on-time one does.
  if (
    sched.digestMinute != null &&
    slotDue(sched.digestMinute, minute, tickMinutes) &&
    getProfileSetting(profile.id, DIGEST_MARKER_KEY) !== date &&
    !deferDigestForSleep(
      profile.id,
      sched.digestMinute,
      minute,
      tickMinutes,
      sched.digestAuto
    )
  ) {
    try {
      const dg = await runDigest(
        profile.id,
        profile.name,
        date,
        coachingInput()
      );
      if (dg.failed) anyFailed = true;
    } catch (e) {
      log.error("digest failed", {
        profile: profile.id,
        err: e instanceof Error ? e : String(e),
      });
      anyFailed = true;
    }
  }

  // LIVE-MESSAGE RECONCILIATION (#1779). Every inline keyboard still sitting in a chat
  // is checked against what the ledger actually says, and anything it claims that is no
  // longer true is removed. This is the outbound half of "the safety tier stops lying":
  // a dose taken in the app used to leave a live "✅ Taken" button presenting it as
  // outstanding for the rest of the day, which is precisely the prompt that invites a
  // double dose.
  //
  // It only ever REDUCES what a chat claims, and it does so with EDITS — Telegram does
  // not notify on an edit, so no new interruption is spent. A steady state performs zero
  // API calls. Never allowed to fail the tick: a message that keeps a stale button for
  // another hour is bad, but a reconcile error that stops a medication reminder is worse.
  try {
    const rc = await reconcileProfileMessages(profile.id);
    if (
      rc.edited > 0 ||
      rc.closed > 0 ||
      rc.dropped > 0 ||
      rc.deferred > 0 ||
      // A pointer whose own reconciliation threw (#2070). The sweep carried on past it,
      // which is exactly why it has to be visible here: without this the failure would
      // be a silent per-profile regression in stale-keyboard cleanup.
      rc.failed > 0
    ) {
      log.info("messages reconciled", { profile: profile.id, ...rc });
    }
  } catch (e) {
    log.info("message reconcile failed (ignored)", {
      profile: profile.id,
      err: e instanceof Error ? e.message : String(e),
    });
  }

  // Keep today's digest offer tail (#1505) labelled for the slot we are ACTUALLY in.
  // Runs every tick, outside the digest's own hour gate, and is silent by
  // construction: at most one keyboard EDIT, which Telegram does not notify on. It
  // no-ops entirely when the slot hasn't turned over, so the ordinary tick pays
  // nothing for it. Never allowed to fail the tick — a stale label is cosmetic.
  try {
    await refreshDigestOfferTail(profile.id);
  } catch (e) {
    log.info("digest tail refresh failed (ignored)", {
      profile: profile.id,
      err: e instanceof Error ? e.message : String(e),
    });
  }

  // Weekly recap (#32): once a week, on the chosen weekday at weeklyRecapMinute
  // (this profile's timezone). Own per-profile/day dedup key — the recap only
  // triggers on its weekday, and the same-day marker prevents a double send, so
  // next week's same weekday (a new date) fires again. The weekday+time pair
  // needs no cross-midnight care: slotDue never wraps, so both attempts share
  // the weekday.
  if (
    sched.weeklyRecapDay != null &&
    weekday === sched.weeklyRecapDay &&
    slotDue(sched.weeklyRecapMinute ?? 9 * 60, minute, tickMinutes) &&
    getProfileSetting(profile.id, WEEKLY_RECAP_MARKER_KEY) !== date
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

// --- The tick: for every profile, decide which slots are due, dedupe, send. ---
// One profile's failure (a throw or a send failure) must not stop the others; the
// exit code aggregates failures across all profiles.
async function tick() {
  const profiles = allProfiles();
  let anyFailed = false;

  // THE RUN (#2209). One id for this whole invocation, stamped onto every line the
  // persisted tick log keeps, so the admin viewer can group by (run, profile)
  // instead of guessing from timestamps — a fan-out over several profiles routinely
  // straddles a minute, and a bucketing heuristic splits exactly those runs.
  //
  // The line below is the run's own marker and the ONE new global line this issue
  // adds. It earns its place by being the thing that makes a QUIET tick visible: a
  // run that decided nothing must still render as a row, or "silence because nothing
  // was due" stays indistinguishable from "silence because the sidecar is wedged" —
  // which is the ambiguity the log exists to kill.
  const run = beginNotifyRun();
  log.info("tick started", { run, profiles: profiles.length });

  // THE OBSERVED TICK CADENCE (#2121). The attempt bands in slotDue are one tick
  // wide, so the tick must know how often it really runs — not how often a config
  // claims it runs, because a mismatch in either direction mis-sizes the bands
  // (too wide: duplicate attempts; too narrow: slots that never fire). The
  // previous tick's start instant is a global watermark
  // (`notify_tick_last_run_at`); the derived interval is clamped to [1, 60] so an
  // outage cannot widen the window past the hourly behavior, and is stored
  // (`notify_tick_interval_min`) for the Settings sub-hourly warning. First tick
  // ever reads as hourly — the widest, safest bands.
  const tickStartMs = Date.now();
  const prevTickMs = Date.parse(getSetting("notify_tick_last_run_at") ?? "");
  const tickMinutes = observedTickMinutes(
    Number.isFinite(prevTickMs) ? prevTickMs : null,
    tickStartMs
  );
  setSetting("notify_tick_last_run_at", new Date(tickStartMs).toISOString());
  setSetting("notify_tick_interval_min", String(tickMinutes));

  // Portal sync requests (#1757): GLOBAL, once per tick, and deliberately BEFORE the
  // per-profile loop so an ask raised this hour is already visible to today's digest
  // rather than waiting a day.
  //
  // Not inside the loop, because a request is about a portal LOGIN, not a person: one
  // login covering three people would otherwise be evaluated three times and the
  // supersession rule would be asked to sort out a race it should never have seen. It
  // writes ROWS ONLY — no send, ever. The nudge itself is the Upcoming item the request
  // produces and the digest line that item's own banding yields, which is the whole
  // reach this feature is allowed (coaching tier: portal hygiene is never a safety
  // signal). Best-effort: raising an ask must never fail a tick that has medication
  // reminders to deliver.
  try {
    const raised = evaluateSyncRequests((profileId) => today(profileId));
    if (raised.staleness > 0 || raised.postVisit > 0) {
      log.info("portal sync requests raised", raised);
    }
  } catch (e) {
    log.error("portal sync-request evaluation failed", {
      err: e instanceof Error ? e : String(e),
    });
  }

  for (const p of profiles) {
    try {
      // One tick-scoped memo per profile (#2118, #2111): request-scoped cache() is
      // identity here, so the tick's repeated heavy gathers — the preventive
      // assessment and the medication-family state — each collapse to ONE
      // evaluation for this profile. The scope closes with the profile, and nothing
      // inside it writes what those gathers read (lib/tick-cache.ts states the rule).
      //
      // The scope also DECLARES its subject (#2209), which is what lets the persisted
      // tick log attribute a line to a profile without threading an id through every
      // log call site in lib/notifications/**.
      const failed = await runInTickScope(() => tickProfile(p, tickMinutes), {
        profileId: p.id,
      });
      if (failed) anyFailed = true;
      // The per-profile run marker — the second and last new line this issue adds.
      // One row per profile per run is exactly the viewer's unit, and without it a
      // profile the tick evaluated and had nothing to say about would leave no trace
      // at all: the quiet-tick ambiguity again, one level down.
      log.info("profile evaluated", { profile: p.id, failed });
    } catch (e) {
      log.error("profile tick failed", {
        profile: p.id,
        err: e instanceof Error ? e : String(e),
      });
      anyFailed = true;
    }
  }

  // Shared supply pools (#1374): GLOBAL, once per tick — deliberately NOT inside the
  // per-profile loop. A pooled bottle is ONE subject with ONE episode marker, so a
  // per-profile pass would nudge the same bottle once per linked member (the exact bug
  // pools exist to fix). Delivery still rides the login-scoped fan-out: the pass picks
  // the minimum set of linked profiles that reaches every managing login. Waking-window
  // and profile-local-date decisions stay per-profile-composed (the callbacks below),
  // never evaluated in another member's context.
  try {
    const pr = await runPoolRefills(
      (profileId) => today(profileId),
      (profileId) => {
        const s = getNotifySchedule(profileId);
        return inWakingWindow(
          minuteOfDayInTz(getTimezone(profileId), new Date()),
          s.wakingStartHour,
          s.wakingEndHour
        );
      }
    );
    if (pr.failed) anyFailed = true;
  } catch (e) {
    log.error("shared supply pool check failed", {
      err: e instanceof Error ? e : String(e),
    });
    anyFailed = true;
  }

  // Nightly SQLite backup (#131): global, so it runs once per tick (not per
  // profile) at the configured instance-timezone hour. A backup failure is
  // surfaced via the exit code but never stops the notification flow.
  try {
    const bk = runScheduledBackup(tickMinutes);
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

  // Undo/Trash retention sweep (#30, window configurable per #2013): global, once per
  // tick. Purges holding rows past the admin-configured window (Settings → Server;
  // 30-day default) — and unlinks the video clips they captured — so a deleted row is
  // genuinely gone once the window runs out. Best-effort (sweepDeletedRows never
  // throws); never affects the notification flow/exit code.
  const swept = sweepDeletedRows(getTrashRetentionDays());
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

  // Delayed post-workout dispatches (#1154 §B): a sync inside THIS tick may have
  // armed the ~60s dispatch timer for a just-imported completed session, and the
  // tick process is about to exit — run any pending dispatch NOW instead of
  // dropping it with the process (the web process keeps its timers; only the
  // short-lived tick needs the flush). Best-effort: the shared one-shot marker +
  // the next tick's backstop cover a failure.
  try {
    await flushPostWorkoutDispatches();
  } catch (e) {
    log.error("post-workout dispatch flush failed", {
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
