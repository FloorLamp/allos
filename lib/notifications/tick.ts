// Per-profile notification tick and CLI orchestration.

import {
  buildIntakeReminder,
  buildIntakeReminderForSlots,
  getPreWorkoutSlotMinute,
  type IntakeSendSlot,
  type ReminderWindow,
} from "../notifications/intake";
import {
  buildHouseholdRound,
  householdRoundMarkerKey,
} from "../notifications/household-round";
import { buildWorkoutTargetReminder } from "../notifications/workouts";
import { buildPracticeReminder } from "../notifications/practices";
import { buildFoodNudge } from "../notifications/food";
import { withChatOrigin } from "./chat-origin";
import { attachUsualRoutine } from "../notifications/usual-routine-attach";
import {
  attachUsualForSlots,
  planUsualRoutine,
  type UsualRoutineSlotPlan,
} from "../notifications/usual-routine-plan";
import type { FoodSlot } from "../food-slot";
import { FOOD_NUDGE_WINDOWS } from "../notifications/food-format";
import { standsDownForFast } from "../fasting-standdown";
import { getActiveFastCached } from "../queries/fasting";
// Every per-day send marker this tick writes is minted by a DECLARED builder (#2036),
// never composed from a free-form slot string — see lib/notifications/send-markers.ts.
import {
  DIGEST_MARKER_KEY,
  TICK_SLOT_MARKER_KEYS,
  foodNudgeMarkerKey,
  intakeSlotMarkerKey,
} from "../notifications/send-markers";
import { buildMoodCheckin } from "../notifications/mood";
import {
  recordWearReminderClaim,
  wearReminderSend,
} from "../notifications/wear-reminder";
import { dispatch } from "../notifications";
import { type NotificationMessage } from "../notifications/types";
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
} from "../settings";
import { getUpdates, telegramChannel } from "../notifications/telegram";
import {
  handleCallbackQuery,
  handleIncomingMessage,
} from "../notifications/telegram-callbacks";
import { runEscalations } from "../notifications/escalate";
import { runRedoseNotices } from "../notifications/redose";
import { runPostWorkoutFinish } from "../notifications/workout-presence";
import { runStillGoingSuggest } from "./still-going";
import { flushPostWorkoutDispatches } from "../notifications/post-workout-queue";
import { runPracticeRecaps } from "../notifications/practice-recap-dispatch";
import { expireWorkoutDrafts } from "../workout-finish";
import { runRefills } from "../notifications/refill";
import { runPoolRefills } from "../notifications/supply-pool";
import { runPreventive } from "../notifications/preventive";
import { runIllnessCare } from "../notifications/illness-care";
import { runFollowUpNudges } from "../notifications/followup";
import { runEaseBack } from "../notifications/ease-back";
import { runTempRedFlag } from "../notifications/temp-red-flag";
import {
  planProfileDigestTick,
  recordDigestAttempt,
  refreshDigestOfferTail,
  runDigest,
} from "../notifications/digest-data";
import { reconcileProfileMessages } from "../notifications/reconcile";
import { beginNotifyRun } from "../notify-log";
import { runRecap } from "../notifications/recap-data";
import { runMilestones } from "../milestones-db";
import { runScheduledBackup } from "../backup";
import { pruneAuditEvents } from "../audit";
import { sweepDeletedRows } from "../undo-delete-db";
import { sweepReplayedKeys } from "../offline/writes";
import { purgeExpiredSessions } from "../auth";
import { purgeExpiredTotpChallenges } from "../two-factor";
import { reapStuckExtractions } from "../extraction-reaper";
import {
  inferWorkoutSchedule,
  runCoachingEpisode,
  gatherCoachingInput,
} from "../queries";
import type { CoachingInput } from "../coaching";
import {
  slotDue,
  inWakingWindow,
  observedTickMinutes,
} from "../notifications/schedule";
import { checkpointWal } from "../db";
import {
  dateStrInTz,
  minuteOfDayInTz,
  parseUtcSql,
  weekdayInTz,
} from "../date";
import { createLogger } from "../log";
import { pruneSyncEvents } from "../integrations/connections";
import { syncIntegrations } from "../integrations/pull-tick";
import { evaluateSyncRequests } from "../portal-requests";
import { isReminderSlotExcused } from "../travel-excusal";
import { getTravelSwitches } from "../settings/travel";
import { resolveSwitchHistory } from "../travel-timezone";

const log = createLogger("notify");

const WINDOWS: Record<string, ReminderWindow> = {
  morning: "Morning",
  midday: "Midday",
  evening: "Evening",
  bedtime: "Bedtime",
};

export interface NotifyTickProfile {
  id: number;
  name: string;
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

export type TickSlotOutcome =
  "already-sent" | "nothing-due" | "sent" | "failed";

export async function runTickSlot(
  profileId: number,
  slot: string,
  markerKey: string,
  date: string,
  build: () => NotificationMessage | null,
  onDelivered?: () => void
): Promise<TickSlotOutcome> {
  if (getProfileSetting(profileId, markerKey) === date) {
    log.info("already sent today", { profile: profileId, slot });
    return "already-sent";
  }
  const built = build();
  if (!built) {
    log.info("nothing due", { profile: profileId, slot });
    return "nothing-due";
  }
  const { delivered, failed } = await send(profileId, built);
  if (delivered) {
    setProfileSetting(profileId, markerKey, date);
    onDelivered?.();
  }
  return failed ? "failed" : delivered ? "sent" : "nothing-due";
}

export type DigestTickOutcome =
  "already-sent" | "idle" | "declined" | "sent" | "failed";

export async function runDigestTick(
  profileId: number,
  profileName: string,
  sched: ReturnType<typeof getNotifySchedule>,
  minute: number,
  tickMinutes: number,
  date: string,
  coachingInput?: () => CoachingInput
): Promise<DigestTickOutcome> {
  if (getProfileSetting(profileId, DIGEST_MARKER_KEY) === date)
    return "already-sent";
  const action = planProfileDigestTick(
    profileId,
    sched,
    minute,
    tickMinutes,
    date
  );
  if (action === "wait") return "declined";
  if (action === "idle") return "idle";
  const result = await runDigest(
    profileId,
    profileName,
    date,
    coachingInput?.()
  );
  if (!result.failed) return "sent";
  if (sched.digestMode === "dynamic")
    recordDigestAttempt(profileId, date, minute);
  return "failed";
}

export function recordNotifyTickStart(nowMs: number): number {
  // parseUtcSql: a settings value carries no brand; the shape expected is the ISO
  // instant this function writes below (#5338).
  const prevTickMs =
    parseUtcSql(getSetting("notify_tick_last_run_at"))?.getTime() ?? NaN;
  const tickMinutes = observedTickMinutes(
    Number.isFinite(prevTickMs) ? prevTickMs : null,
    nowMs
  );
  setSetting("notify_tick_last_run_at", new Date(nowMs).toISOString());
  setSetting("notify_tick_interval_min", String(tickMinutes));
  return tickMinutes;
}

// --- Manual mode: build and send the one requested message for one profile. ---
export async function runManualNotification(
  profileId: number,
  arg: string
): Promise<number> {
  let msg: NotificationMessage | null;
  if (arg === "workout") msg = buildWorkoutTargetReminder(profileId);
  else if (arg === "practice") msg = buildPracticeReminder(profileId);
  else if (WINDOWS[arg]) msg = buildIntakeReminder(profileId, WINDOWS[arg]);
  else {
    console.error(
      "Usage: npm run notify -- <morning|midday|evening|bedtime|workout|practice> [--profile <id>]"
    );
    return 2;
  }
  if (!msg) {
    log.info("nothing due", { kind: arg, profile: profileId });
    return 0;
  }
  const { failed } = await send(profileId, msg);
  return failed ? 1 : 0;
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

export async function pollTelegramUpdates(): Promise<never> {
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
export async function tickProfile(
  profileId: number,
  profileName: string,
  tickMinutes: number,
  nowMs: number
): Promise<boolean> {
  const now = new Date(nowMs);

  // THE PULL PASS, ON ITS OWN CADENCE (#2121 step 1). Runs on every tick regardless
  // of which notification slots are due — but a source is POLLED only once per its
  // registry-declared cadence window (hourly for all four today). That is the whole
  // decoupling: everything below this line is "what is due to send", bounded only by
  // this process's ~0.5 s boot and free to be evaluated as often as the scheduler
  // fires; the line itself is "call someone else's API", bounded by their quota. A
  // finer tick multiplies the former and not the latter. The loop and its guard live
  // in lib/integrations/pull-tick.ts so both halves are testable.
  await syncIntegrations(profileId, now);

  // Decide due slots by the profile's configured-TZ minute-of-day/weekday so
  // scheduling matches the user's clock regardless of the container's process TZ.
  const tz = getTimezone(profileId);
  const minute = minuteOfDayInTz(tz, now);
  const weekday = weekdayInTz(tz, now);
  const date = dateStrInTz(tz, now);
  const sched = getNotifySchedule(profileId);
  // Travel (#3685): a retry band must not resurrect a wall-clock slot an
  // eastward switch skipped. Resolve the profile-owned history once per tick and
  // keep the overwhelmingly common empty-history case free of switch arithmetic
  // and per-day work at every slot below.
  const travelSwitches = resolveSwitchHistory(getTravelSwitches(profileId), tz);
  const reminderSlotExcused =
    travelSwitches.length === 0
      ? (_slotMinute: number) => false
      : (slotMinute: number) =>
          isReminderSlotExcused(travelSwitches, date, slotMinute);

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
    (coachingInputCache ??= gatherCoachingInput(profileId, "kg", "km"));

  let anyFailed = false;

  // ── THE COMPOSED ONE-TAP'S PLACEMENT (#2460) ──────────────────────────────
  //
  // One button, the whole morning — the habitual food groups AND the doses declared for
  // the window and still owed today. It is not a send of its own and never will be
  // (contact-consent, findings.md §2): it DECORATES whichever of the window's messages
  // is already going out, and never both.
  //
  // Deciding that is cross-message knowledge, which is why it lives HERE rather than in
  // either builder: `buildFoodNudge` has five callers and none of them knows anything
  // about the dose reminder, and the reverse is just as true. The plan computes the
  // candidate ONCE per window and hands the already-decided attachment to whichever
  // message takes it; the builders are untouched and ask nothing.
  //
  // The gate is the food opt-in, exactly as the nudge's is: the bundle always contains
  // food writes, and food-buttons-in-chat is an expressed opt-in. Its dose confirms
  // need no additional consent — those writes are already one tap away on the same
  // message.
  const usualPlans = new Map<FoodSlot, UsualRoutineSlotPlan>();
  if (
    getProfileFoodTelegram(profileId) &&
    telegramChannel.isConfigured(profileId)
  ) {
    for (const w of FOOD_NUDGE_WINDOWS) {
      const slotMinute = sched.supplementMinutes[w];
      if (
        slotMinute == null ||
        !slotDue(slotMinute, minute, tickMinutes) ||
        reminderSlotExcused(slotMinute)
      )
        continue;
      const plan = planUsualRoutine(profileId, w, date, true);
      if (plan) usualPlans.set(w, plan);
    }
  }

  // ── IntakeItem dose reminders: ONE merged send per tick (#1154) ────────────
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
      !reminderSlotExcused(slotMinute) &&
      getProfileSetting(profileId, intakeSlotMarkerKey(w)) !== date
    )
      intakeSlotsDue.push(w);
  }
  // The PreWorkout pseudo-slot (#1154 Fix A): `anytime` + `pre_workout` doses
  // fire ~an hour before the inferred training hour instead of folding into the
  // Morning window. Gated on intake reminders being on at all (any window
  // configured) — turning every window off silences this too.
  if (
    Object.values(sched.supplementMinutes).some((m) => m != null) &&
    getProfileSetting(profileId, intakeSlotMarkerKey("PreWorkout")) !== date
  ) {
    const preMinute = getPreWorkoutSlotMinute(profileId);
    if (
      preMinute != null &&
      slotDue(preMinute, minute, tickMinutes) &&
      !reminderSlotExcused(preMinute)
    )
      intakeSlotsDue.push("PreWorkout");
  }
  if (intakeSlotsDue.length > 0) {
    const built = buildIntakeReminderForSlots(profileId, intakeSlotsDue);
    if (!built) {
      log.info("nothing due", {
        profile: profileId,
        slots: intakeSlotsDue.join(","),
      });
    } else {
      // PRIORITY 1 (#2460): the dose reminder IS sending, and it covers the bundle's
      // window, so it takes the bundle — it is the message already carrying the stack's
      // one-taps, and this is the upgrade of its `All` row. Claimed only now, when the
      // message exists: a slot whose reminder had nothing to say leaves the bundle for
      // the food nudge instead of spending it on a message that never went out.
      const message = attachUsualForSlots(
        built.message,
        built.slots,
        usualPlans
      );
      const { delivered, failed } = await send(profileId, message);
      if (failed) anyFailed = true;
      // Mark each contributing slot once delivered so none re-sends later today;
      // if nothing delivered (no channel / all failed) leave unmarked so a retry
      // can recover.
      if (delivered) {
        for (const s of built.slots)
          setProfileSetting(profileId, intakeSlotMarkerKey(s), date);
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
      !reminderSlotExcused(slotMinute) &&
      getProfileSetting(profileId, householdRoundMarkerKey(w)) !== date
    )
      householdSlotsDue.push(w);
  }
  if (householdSlotsDue.length > 0) {
    // Returns null for an empty round (nothing due for any subscribed member) — a
    // caregiver is never pinged just to be told there is nothing to do.
    const round = buildHouseholdRound(profileId, householdSlotsDue);
    if (round) {
      const { delivered, failed } = await send(profileId, round);
      if (failed) anyFailed = true;
      if (delivered) {
        for (const s of householdSlotsDue)
          setProfileSetting(profileId, householdRoundMarkerKey(s), date);
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
  //
  // AND STOOD DOWN WHILE A FAST IS ACTIVE (#2757). The system may REDUCE its contact
  // unilaterally — never increase it — so this needs no consent and stores nothing: it
  // is derived from the active-fast row, self-heals the moment the fast ends, and
  // leaves no marker to sweep. The slot is simply never PUSHED, so the day's marker is
  // never written either and the nudge resumes at the next slot after the fast ends
  // rather than finding the day spent.
  //
  // `standsDownForFast` takes the KIND and consults a closed one-member allowlist
  // (lib/fasting-standdown.ts), so this code path cannot reach a dose reminder, a
  // missed-dose escalation, a PRN redose notice or any other safety-class send — that
  // disjointness is proven over the whole `NotificationKind` union in
  // lib/__tests__/fasting-standdown.test.ts rather than assumed here. The read is
  // memoized for the profile's tick.
  //
  // BOUNDED BY PLAUSIBILITY, not merely by the row existing: past the fast kind's stale
  // bound (#5142) an active fast reads as abandoned rather than as "not eating", and the
  // nudge resumes.
  // A suppression whose only exit is the user opening the app would be silencing the
  // very channel that would have brought them there.
  if (
    getProfileFoodTelegram(profileId) &&
    telegramChannel.isConfigured(profileId) &&
    !standsDownForFast(getActiveFastCached(profileId), "food", now)
  ) {
    for (const w of FOOD_NUDGE_WINDOWS) {
      const slotMinute = sched.supplementMinutes[w];
      if (
        slotMinute != null &&
        slotDue(slotMinute, minute, tickMinutes) &&
        !reminderSlotExcused(slotMinute)
      )
        dueSlots.push({
          slot: `food_${w}`,
          markerKey: foodNudgeMarkerKey(w),
          // PRIORITY 2 (#2460): a habitual window whose dose reminder did NOT send —
          // no pending doses, or none due this slot — still gets the bundle, which
          // degrades to the food half. The claim happens inside the build, after
          // `runTickSlot`'s per-day marker check and only when the nudge itself
          // exists, so the same "never spent on a message that never went out" rule
          // holds on this side too. If the dose reminder already took it, `claim`
          // answers null and this is the plain nudge.
          build: () => {
            // THE PROACTIVE SEND declares itself (#3087): every `food:` button on this
            // keyboard is marked as a nudge, so a tap on it — today, or after a
            // rebuild, or after a "Show more" — still says so. `/food` re-renders this
            // exact builder and marks the opposite, which is why neither relies on
            // being the default.
            const nudge = withChatOrigin(
              buildFoodNudge(profileId, w, date),
              "telegram-nudge"
            );
            return nudge
              ? attachUsualRoutine(
                  nudge,
                  usualPlans.get(w)?.claim("food") ?? null
                )
              : null;
          },
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
  if (getProfileMoodCheckin(profileId)) {
    const slotMinute = sched.supplementMinutes.Evening;
    if (
      slotMinute != null &&
      slotDue(slotMinute, minute, tickMinutes) &&
      !reminderSlotExcused(slotMinute)
    )
      dueSlots.push({
        slot: "mood_checkin",
        markerKey: TICK_SLOT_MARKER_KEYS.mood_checkin,
        build: () => buildMoodCheckin(profileId, date),
        onDelivered: () => bumpMoodCheckinIgnored(profileId),
      });
  }
  // Bedtime wear reminder (#2161): OPT-IN per profile, off by default, riding the
  // BEDTIME supplement slot minute — no schedule of its own, exactly as the mood
  // check-in rides Evening.
  //
  // The gate here is only "is the slot due"; every other condition — the consent flag
  // itself, the expected-active gate, the source-health deference, and the quiet-
  // stream predicate — lives in wearReminderSend, which returns null for all of them.
  // That is deliberate: null is what the dueSlots loop calls "nothing due", and a
  // "nothing due" night leaves the per-day marker UNSET, so a skipped evaluation never
  // spends the night's single send.
  //
  // Cadence is the tick's own per-day marker discipline, NOT planNudgeCadence: there
  // is one profile-fixed key with no subject to strand, so there is no candidate set
  // to freeze and no self-healing sweep to run — the date rollover is the whole
  // lifecycle. Reaching for the episode planner here would add a vocabulary the
  // signal does not have.
  {
    const slotMinute = sched.supplementMinutes.Bedtime;
    if (
      slotMinute != null &&
      slotDue(slotMinute, minute, tickMinutes) &&
      !reminderSlotExcused(slotMinute)
    ) {
      // The instant the message's factual clause names, captured by the build and written
      // only ON DELIVERY (#3027). The sweep cannot re-derive it later: what falsifies the
      // message is data ARRIVING with timestamps EARLIER than now, so re-reading the
      // stream gives the frontier as it is, never as it was when the sentence was written.
      let claimedAt: string | null = null;
      dueSlots.push({
        slot: "wear_reminder",
        markerKey: TICK_SLOT_MARKER_KEYS.wear_reminder,
        build: () => {
          const send = wearReminderSend(profileId);
          claimedAt = send?.claimedAt ?? null;
          return send?.message ?? null;
        },
        onDelivered: () => {
          if (claimedAt) recordWearReminderClaim(profileId, date, claimedAt);
        },
      });
    }
  }
  if (sched.workoutEnabled) {
    const inf = inferWorkoutSchedule(profileId);
    // The inferred training hour joins the minute vocabulary at :00 — the
    // inference itself is hour-grain (the mode over start hours).
    if (
      inf.weekdays.includes(weekday) &&
      slotDue(inf.hour * 60, minute, tickMinutes) &&
      !reminderSlotExcused(inf.hour * 60)
    )
      dueSlots.push({
        slot: "workout",
        markerKey: TICK_SLOT_MARKER_KEYS.workout,
        build: () =>
          buildWorkoutTargetReminder(profileId, coachingInput(), now),
      });
  }

  for (const { slot, markerKey, build, onDelivered } of dueSlots) {
    const outcome = await runTickSlot(
      profileId,
      slot,
      markerKey,
      date,
      build,
      onDelivered
    );
    if (outcome === "failed") anyFailed = true;
  }

  // Missed-dose escalation: runs every tick regardless of which
  // slots are due, so a dose whose morning reminder already went out gets chased
  // later the same day. Its own per-dose/day dedup prevents repeat nudges; a
  // finer tick only shrinks how long past the wait the chase lands.
  try {
    const esc = await runEscalations(
      profileId,
      profileName,
      date,
      minute,
      sched
    );
    if (esc.failed) anyFailed = true;
  } catch (e) {
    log.error("escalation check failed", {
      profile: profileId,
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
    const rd = await runRedoseNotices(
      profileId,
      profileName,
      date,
      now,
      tickMinutes
    );
    if (rd.failed) anyFailed = true;
  } catch (e) {
    log.error("redose notice check failed", {
      profile: profileId,
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
    const pw = await runPostWorkoutFinish(profileId, now);
    if (pw.failed) anyFailed = true;
  } catch (e) {
    log.error("post-workout finish nudge failed", {
      profile: profileId,
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
      const rf = await runRefills(profileId, profileName, date);
      if (rf.failed) anyFailed = true;
    } catch (e) {
      log.error("refill check failed", {
        profile: profileId,
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
    getProfileSetting(profileId, "notify_preventive_assessed") !== date
  ) {
    try {
      const pv = await runPreventive(profileId, profileName, date);
      if (pv.failed) anyFailed = true;
      else setProfileSetting(profileId, "notify_preventive_assessed", date);
    } catch (e) {
      log.error("preventive check failed", {
        profile: profileId,
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
    getProfileSetting(profileId, "notify_illnesscare_assessed") !== date
  ) {
    try {
      const ic = await runIllnessCare(profileId, date);
      if (ic.failed) anyFailed = true;
      else setProfileSetting(profileId, "notify_illnesscare_assessed", date);
    } catch (e) {
      log.error("illness-care check failed", {
        profile: profileId,
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
    getProfileSetting(profileId, "notify_followup_assessed") !== date
  ) {
    try {
      const fu = await runFollowUpNudges(profileId, profileName, date);
      if (fu.failed) anyFailed = true;
      else setProfileSetting(profileId, "notify_followup_assessed", date);
    } catch (e) {
      log.error("followup escalation check failed", {
        profile: profileId,
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
      const trf = await runTempRedFlag(profileId, date);
      if (trf.failed) anyFailed = true;
    } catch (e) {
      log.error("temp-red-flag check failed", {
        profile: profileId,
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
    getProfileSetting(profileId, TICK_SLOT_MARKER_KEYS.practice) !== date
  ) {
    try {
      const built = buildPracticeReminder(
        profileId,
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
        const { delivered, failed } = await send(profileId, built);
        if (failed) anyFailed = true;
        if (delivered)
          setProfileSetting(profileId, TICK_SLOT_MARKER_KEYS.practice, date);
      }
    } catch (e) {
      log.error("practice nudge failed", {
        profile: profileId,
        err: e instanceof Error ? e : String(e),
      });
      anyFailed = true;
    }
  }

  // The practice finish note (#4775 §3). NOT slot-gated and not waking-gated: it is
  // timed to a real event the person just performed, exactly like the post-workout
  // finish above, and its own two-hour bound is what keeps it from firing at an
  // unwelcome hour — a practice finished at 23:00 is eligible until 01:00 and the
  // person who tapped it is awake. It sends only when the minute stream has covered
  // the session, so on most passes it does one bounded query and stops.
  try {
    const pr = await runPracticeRecaps(
      profileId,
      (msg) => send(profileId, msg),
      now
    );
    if (pr.failed) anyFailed = true;
  } catch (e) {
    log.error("practice finish note failed", {
      profile: profileId,
      err: e instanceof Error ? e : String(e),
    });
    anyFailed = true;
  }

  // Coaching rest-episode continuity (#44 item 3b): advance/clear the persisted
  // rest-nudge marker each hour so a multi-day easy stretch reads as a persisting
  // recommendation ("Rest or take it easy — Nth day", #752) on the
  // dashboard/Training surfaces instead of a fresh alert. No send —
  // it only maintains the marker (mirrors the refill nudge's episode dedup) so the
  // condition is tracked daily even when the user doesn't open a coaching surface.
  try {
    runCoachingEpisode(profileId, coachingInput());
  } catch (e) {
    log.error("coaching episode reconcile failed", {
      profile: profileId,
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
        profileId,
        profileName,
        coachingInput(),
        date
      );
      if (eb.failed) anyFailed = true;
    } catch (e) {
      log.error("ease-back nudge failed", {
        profile: profileId,
        err: e instanceof Error ? e : String(e),
      });
      anyFailed = true;
    }
  }

  // "Still going?" suggest (#921/#560, one family at #5142): any open episode gone
  // quiet past its own kind's stale bound — a workout draft, a live practice — gets
  // ONE gentle "Finish or discard" nudge. Suggest-only, deep-links back to the
  // surface, NEVER auto-ends. One-shot per row id; waking-gated (a soft coaching
  // suggest, not a safety signal).
  // Draft expiry (#2870 step 3): abandoned zero-content session husks age out
  // after DRAFT_EXPIRE_HOURS. Housekeeping, not a notification — every tick,
  // not waking-gated; the core skips anything with content.
  try {
    expireWorkoutDrafts(profileId, now);
  } catch (e) {
    log.error("draft expiry failed", {
      profile: profileId,
      err: e instanceof Error ? e : String(e),
    });
  }

  if (waking) {
    try {
      const sw = await runStillGoingSuggest(profileId, profileName, now);
      if (sw.failed) anyFailed = true;
    } catch (e) {
      log.error("still-going suggest failed", {
        profile: profileId,
        err: e instanceof Error ? e : String(e),
      });
      anyFailed = true;
    }
  }

  // Morning digest: ONE merged summary per profile per day, hard-deduped so a bug
  // can't spam a family chat at 7am. As of #1108 the "what's due" list is the
  // digest's Today section — one message, one due-today computation
  // (collectUpcoming), one per-day marker (notify_last_digest); the old separate
  // upcoming digest + its notify_last_upcoming marker are retired.
  //
  // TWO MODES (#2211), and the whole decision is one call. STATIC is unchanged, to
  // the minute: `slotAttempt`'s two slot-anchored bands, send on either, sleep
  // pending or not. DYNAMIC re-checks from its floor onward, sends the moment last
  // night lands, and sends unconditionally at a deadline derived from the arrival
  // distribution (#2214) rather than from `floor + SLOT_RETRY_DELAY_MIN`.
  //
  // A DECLINE ("wait") WRITES NOTHING — the condition is simply re-asked next tick.
  // A FAILED SEND writes `notify_digest_attempt`, which is both the Dynamic retry's
  // anchor (attempt + SLOT_RETRY_DELAY_MIN, not a floor-anchored band already in the
  // past) and, by its presence, what tells the two apart. Attempts stay at two per
  // profile per day in either mode: re-checks re-evaluate a CONDITION, they never
  // re-attempt a delivery (#2121 item 3).
  // Deliberately not travel-gated (#3685), like the weekly recap below: this is a
  // summary of the day, not a claim that its configured minute was missed. Dynamic
  // mode also has a floor and arrival deadline rather than one authoritative slot,
  // so both modes keep their shared digest contract instead of forking on travel.
  if (getProfileSetting(profileId, DIGEST_MARKER_KEY) !== date) {
    try {
      const outcome = await runDigestTick(
        profileId,
        profileName,
        sched,
        minute,
        tickMinutes,
        date,
        coachingInput
      );
      if (outcome === "failed") anyFailed = true;
    } catch (e) {
      log.error("digest failed", {
        profile: profileId,
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
  //
  // THE TICK IS NO LONGER THE ONLY TRIGGER (#3933). A chat TAP now runs the same sweep
  // as it returns, so the hour above is the wait an APP write still pays, not a chat
  // one. The failure isolation is what the tap copied; the cadence here is unchanged.
  try {
    const rc = await reconcileProfileMessages(profileId);
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
      log.info("messages reconciled", { profile: profileId, ...rc });
    }
  } catch (e) {
    log.info("message reconcile failed (ignored)", {
      profile: profileId,
      err: e instanceof Error ? e.message : String(e),
    });
  }

  // Keep today's digest offer tail (#1505) labelled for the slot we are ACTUALLY in.
  // Runs every tick, outside the digest's own hour gate, and is silent by
  // construction: at most one keyboard EDIT, which Telegram does not notify on. It
  // no-ops entirely when the slot hasn't turned over, so the ordinary tick pays
  // nothing for it. Never allowed to fail the tick — a stale label is cosmetic.
  try {
    await refreshDigestOfferTail(profileId);
  } catch (e) {
    log.info("digest tail refresh failed (ignored)", {
      profile: profileId,
      err: e instanceof Error ? e.message : String(e),
    });
  }

  // Periodic recap (#32, #2178): the profile's ONE recap slot — the chosen weekday at
  // weeklyRecapMinute, in this profile's timezone. The weekday+time pair needs no
  // cross-midnight care: slotDue never wraps, so both attempts share the weekday.
  //
  // The tick decides only that the SLOT is open. WHICH scale speaks — weekly, monthly
  // or quarterly — is `planRecapSend` inside runRecap, over the profile's cadence and
  // the three period-anchored markers. That is deliberate: a longer period REPLACES the
  // shorter one's send in this slot, so there is exactly one recap per slot and this
  // gate must not fork per scale.
  // Deliberately not travel-gated (#3685): a recap summarizes a period and makes no
  // claim that this wall-clock slot was missed. Arriving on the retry band after a
  // switch is late but still truthful, unlike a slot-anchored dose or food ask.
  if (
    sched.weeklyRecapDay != null &&
    weekday === sched.weeklyRecapDay &&
    slotDue(sched.weeklyRecapMinute ?? 9 * 60, minute, tickMinutes)
  ) {
    try {
      const wr = await runRecap(profileId, profileName, date);
      if (wr.failed) anyFailed = true;
    } catch (e) {
      log.error("recap failed", {
        profile: profileId,
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
      const ms = await runMilestones(profileId, profileName, date);
      if (ms.failed) anyFailed = true;
    } catch (e) {
      log.error("milestone check failed", {
        profile: profileId,
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
export type NotifyTickFanOut = (
  profiles: NotifyTickProfile[],
  tickMinutes: number,
  nowMs: number
) => Promise<boolean>;

export async function runNotifyTick(
  profiles: NotifyTickProfile[],
  nowMs: number,
  fanOut: NotifyTickFanOut
): Promise<number> {
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
  const tickMinutes = recordNotifyTickStart(nowMs);

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
    const raised = evaluateSyncRequests((profileId) =>
      dateStrInTz(getTimezone(profileId), new Date(nowMs))
    );
    if (raised.staleness > 0 || raised.postVisit > 0) {
      log.info("portal sync requests raised", raised);
    }
  } catch (e) {
    log.error("portal sync-request evaluation failed", {
      err: e instanceof Error ? e : String(e),
    });
  }

  if (await fanOut(profiles, tickMinutes, nowMs)) anyFailed = true;

  // Shared supply pools (#1374): GLOBAL, once per tick — deliberately NOT inside the
  // per-profile loop. A pooled bottle is ONE subject with ONE episode marker, so a
  // per-profile pass would nudge the same bottle once per linked member (the exact bug
  // pools exist to fix). Delivery still rides the login-scoped fan-out: the pass picks
  // the minimum set of linked profiles that reaches every managing login. Waking-window
  // and profile-local-date decisions stay per-profile-composed (the callbacks below),
  // never evaluated in another member's context.
  try {
    const pr = await runPoolRefills(
      (profileId) => dateStrInTz(getTimezone(profileId), new Date(nowMs)),
      (profileId) => {
        const s = getNotifySchedule(profileId);
        return inWakingWindow(
          minuteOfDayInTz(getTimezone(profileId), new Date(nowMs)),
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
  // gains a row per source per hourly tick and was the one tick sibling nothing
  // pruned. Keeps the last 90 days plus the newest event per (profile, source).
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

  // Expired-session + TOTP-challenge sweep (#1843): global, once per tick. Both
  // purges existed but were called ONLY from the login action, so "somebody signs
  // in" was the sole trigger — and with 30-day SLIDING sessions, a family instance
  // where nobody signs in for months accumulated dead `sessions` and
  // `login_totp_challenges` rows unbounded. Purely a bookkeeping sweep: an expired
  // row is already refused by every read path, so this deletes nothing a live
  // session depends on. Best-effort, like its siblings; never affects the
  // notification flow/exit code.
  try {
    const sweptSessions = purgeExpiredSessions();
    if (sweptSessions > 0)
      log.info("swept expired sessions", { sweptSessions });
    const sweptChallenges = purgeExpiredTotpChallenges();
    if (sweptChallenges > 0)
      log.info("swept expired 2FA challenges", { sweptChallenges });
  } catch (e) {
    log.error("session sweep failed", {
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

  return anyFailed ? 1 : 0;
}
