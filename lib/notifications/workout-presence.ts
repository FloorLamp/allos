// Presence-driven notification nudges (issue #921). Both read the ONE derived
// workout presence (getWorkoutPresence → computeWorkoutPresence) so they can't
// drift from the dock / household chip that render the same state (#221).
//
//   1. runPostWorkoutFinish — the flagship. The moment a session transitions to
//      `finished`, deliver the due, unresolved post_workout supplement doses
//      immediately instead of waiting for the next scheduled supplement slot. A
//      dose reminder = SAFETY tier: NOT bus-gated and NOT waking-gated (it's timed
//      to a real event, exactly like the scheduled slot is timed to a real hour).
//      One-shot per activity id; the slot delivery remains the fallback when the
//      finish was never observed. `isPostWorkoutReady` stays the dueness truth —
//      this only changes DELIVERY timing.
//
//   2. runStaleWorkoutSuggest — an `active` session gone quiet past STALE_MIN gets
//      ONE gentle "Still working out? Finish or discard" suggest (#560). Never
//      auto-ends; suggest-only, deep-links back to the session. Waking-gated (a
//      workout is a waking activity and this is a soft coaching suggest, not a
//      safety signal).
//
// Both use the id-keyed one-shot marker discipline (notify_last_* / notify_stale_*
// keyed by the activity id — #203-safe: AUTOINCREMENT ids never recycle, so a
// stale marker is a harmless dead row needing no rename cleanup).

import { today } from "../db";
import { getWorkoutPresence } from "../queries/presence";
import { getSessionRecap } from "../queries/session-recap";
import {
  getProfileSetting,
  setProfileSetting,
  getPublicUrl,
  getProfileTelegramDisabledKinds,
  getProfileHomeAssistant,
} from "../settings";
import { isKindEnabled } from "./home-assistant-core";
import {
  composeFinishNudge,
  recapNudgeLine,
  weeklyRemainingLine,
} from "./workout-recap-format";
import { getFrequencyTargetProgress } from "../queries";
import { collectWindowDoses } from "./supplements";
import type { ReminderWindow, WindowDose } from "./supplement-format";
import { PRIORITY_ORDER } from "../supplement-schedule";
import { dispatch } from "./index";
import type { NotificationAction, NotificationMessage } from "./types";
import { createLogger } from "../log";

const log = createLogger("notify");

const ALL_WINDOWS: ReminderWindow[] = [
  "Morning",
  "Midday",
  "Evening",
  "Bedtime",
];

// --- Finish-triggered post-workout dose reminder ---

export const POST_WORKOUT_MARKER_PREFIX = "notify_last_post_workout_";
export function postWorkoutFinishMarkerKey(activityId: number): string {
  return `${POST_WORKOUT_MARKER_PREFIX}${activityId}`;
}

// Every post_workout-conditioned dose due today, across every time-of-day window,
// tagged with taken/skipped state. Reuses collectWindowDoses so the dueness +
// adherence computation is the SAME one the scheduled slot uses (each dose maps to
// exactly one window bucket, so the flat-map can't double-count).
function collectPostWorkoutDoses(
  profileId: number,
  date: string
): WindowDose[] {
  return ALL_WINDOWS.flatMap((w) =>
    collectWindowDoses(profileId, w, date)
  ).filter((e) => e.supp.condition === "post_workout");
}

// The finish message: the pending post_workout doses with per-dose take/skip
// buttons (the SAME callback tokens the scheduled reminder uses, resolved by dose
// id — window-independent). Null when nothing is pending, so a finish with every
// post_workout dose already logged sends no dose section. The recap-led composition
// (#924, composeFinishNudge) prepends the session recap line over this result.
export function renderPostWorkoutFinishMessage(
  profileId: number,
  date: string,
  entries: WindowDose[]
): NotificationMessage | null {
  const pending = entries
    .filter((e) => !e.taken && !e.skipped)
    .sort(
      (a, b) =>
        PRIORITY_ORDER[a.supp.priority] - PRIORITY_ORDER[b.supp.priority] ||
        a.supp.name.localeCompare(b.supp.name)
    );
  if (pending.length === 0) return null;

  const body = pending
    .map((e) => {
      const amt = e.dose.amount ? ` — ${e.dose.amount}` : "";
      const mark = e.supp.priority === "mandatory" ? "🔴 " : "• ";
      return `${mark}${e.supp.name}${amt}`;
    })
    .join("\n");

  const actions: NotificationAction[] = [];
  for (const { dose, supp } of pending) {
    const row = `dose:${dose.id}`;
    actions.push({
      label: `✅ ${supp.name}`,
      data: `take:${profileId}:${dose.id}:${supp.id}:${date}`,
      row,
    });
    actions.push({
      label: "⏭ Skip",
      data: `skip:${profileId}:${dose.id}:${supp.id}:${date}`,
      row,
    });
  }
  const noun = pending.length === 1 ? "dose" : "doses";
  return {
    title: `🏋️ Post-workout — ${pending.length} ${noun}`,
    body,
    actions,
    kind: "dose",
  };
}

export function buildPostWorkoutFinishReminder(
  profileId: number,
  date: string
): NotificationMessage | null {
  return renderPostWorkoutFinishMessage(
    profileId,
    date,
    collectPostWorkoutDoses(profileId, date)
  );
}

// Deliver the post-workout reminder once, at the moment the session is `finished`.
// One-shot per activity id; only-when-pending; the marker is stamped only on
// delivery so a no-channel run retries next tick (within the finished window).
export async function runPostWorkoutFinish(
  profileId: number,
  now: Date = new Date()
): Promise<{ failed: boolean }> {
  const presence = getWorkoutPresence(profileId, now);
  if (presence.state !== "finished" || presence.activityId == null)
    return { failed: false };

  const markerKey = postWorkoutFinishMarkerKey(presence.activityId);
  if (getProfileSetting(profileId, markerKey) != null) return { failed: false };

  const date = today(profileId);
  // The recap-led composition (#924): the session recap line LEADS, then the due
  // post-workout supplement section. The recap line is gated by the workout-recap
  // kind (below); the dose section by dueness. Either alone still sends; both
  // absent ⇒ no send (and the one-shot is not burned).
  const doseMsg = buildPostWorkoutFinishReminder(profileId, date);
  const recap = getSessionRecap(profileId, presence.activityId);
  // Recap-line inclusion (#924) is gated by the `workout-recap` row of the #928
  // kind×channel matrix — included unless the user turned it OFF on EVERY
  // profile-scoped channel (Telegram + Home Assistant). The login-scoped push
  // channel gates its own copy at dispatch; a recap-only message additionally
  // carries kind "workout-recap" so each channel's matrix gate applies at send time.
  const recapEnabled =
    isKindEnabled(
      "workout-recap",
      getProfileTelegramDisabledKinds(profileId)
    ) ||
    isKindEnabled(
      "workout-recap",
      getProfileHomeAssistant(profileId).disabledKinds
    );
  const recapLine = recapNudgeLine(recap, recapEnabled);
  // §3 (#981): the recap line gains a forward-looking weekly-remaining status, from the
  // SAME weekly rollup the reminder reads (#221). It rides WITH the recap line (the
  // congratulatory moment) — omitted when there's no recap line to lead it, no targets,
  // or the message is dose-only.
  const weeklyLine = recapLine
    ? weeklyRemainingLine(getFrequencyTargetProgress(profileId))
    : null;
  const leadLine =
    recapLine && weeklyLine ? `${recapLine}\n${weeklyLine}` : recapLine;
  const msg = composeFinishNudge(leadLine, doseMsg);
  if (!msg) return { failed: false }; // nothing to send — don't burn the one-shot

  const results = await dispatch(profileId, msg);
  if (results.length === 0) return { failed: false }; // no channel — fire later
  const delivered = results.some((r) => r.ok);
  const failed = results.some((r) => !r.ok);
  if (delivered) {
    setProfileSetting(profileId, markerKey, date);
    log.info("post-workout finish nudge sent", {
      profile: profileId,
      activity: presence.activityId,
    });
  }
  return { failed };
}

// --- Stale-session suggest ---

export const STALE_WORKOUT_MARKER_PREFIX = "notify_stale_workout_";
export function staleWorkoutMarkerKey(activityId: number): string {
  return `${STALE_WORKOUT_MARKER_PREFIX}${activityId}`;
}

export function renderStaleWorkoutMessage(
  profileName: string,
  deepLinkBase = ""
): NotificationMessage {
  const who = profileName ? ` — ${profileName}` : "";
  const base = deepLinkBase.replace(/\/$/, "");
  const actions: NotificationAction[] | undefined = base
    ? [{ label: "Open workout", url: `${base}/training` }]
    : undefined;
  return {
    title: `⏱️ Still working out?${who}`,
    body: "Your session has been quiet for a while. Finish it or discard the draft — nothing was ended automatically.",
    actions,
    kind: "other",
  };
}

// One gentle suggest per stale session (keyed by activity id). Never auto-ends
// (#560). Returns failed for the tick's exit code; never throws for a send failure.
export async function runStaleWorkoutSuggest(
  profileId: number,
  profileName: string,
  now: Date = new Date()
): Promise<{ failed: boolean }> {
  const presence = getWorkoutPresence(profileId, now);
  if (
    presence.state !== "active" ||
    !presence.stale ||
    presence.activityId == null
  )
    return { failed: false };

  const markerKey = staleWorkoutMarkerKey(presence.activityId);
  if (getProfileSetting(profileId, markerKey) != null) return { failed: false };

  const date = today(profileId);
  const results = await dispatch(
    profileId,
    renderStaleWorkoutMessage(profileName, getPublicUrl())
  );
  if (results.length === 0) return { failed: false };
  const delivered = results.some((r) => r.ok);
  const failed = results.some((r) => !r.ok);
  if (delivered) {
    setProfileSetting(profileId, markerKey, date);
    log.info("stale-workout suggest sent", {
      profile: profileId,
      activity: presence.activityId,
    });
  }
  return { failed };
}
