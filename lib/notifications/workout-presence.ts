// Presence-driven notification nudges (issue #921). Both read the ONE derived
// workout presence (getWorkoutPresence → computeWorkoutPresence) so they can't
// drift from the dashboard recap / Household page that render the same state (#221).
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
//   2. runStaleWorkoutSuggest — an `active` session gone quiet past its stale bound gets
//      ONE gentle "Still working out? Finish or discard" suggest (#560). Never
//      auto-ends; suggest-only, deep-links back to the session. Waking-gated (a
//      workout is a waking activity and this is a soft coaching suggest, not a
//      safety signal).
//
// Both use the id-keyed one-shot marker discipline (notify_last_* / notify_stale_*
// keyed by the activity id — #203-safe: AUTOINCREMENT ids never recycle, so a
// stale marker is a harmless dead row needing no rename cleanup).

import { today, writeTx } from "../db";
import { now as clockNow } from "../clock";
import { isCompletedSessionRow } from "../workout-presence";
import { getWorkoutPresence } from "../queries/presence";
import {
  getProfileSetting,
  setProfileSetting,
  getPublicUrl,
} from "../settings";
import { composeFinishNudge } from "./workout-recap-format";
import { finishRecapParts, loadFinishRow } from "./workout-recap-build";
import { collectWindowDoses } from "./intake";
import {
  notifiableWindowDoses,
  type ReminderWindow,
  type WindowDose,
} from "./intake-format";
import { OBLIGATION_ORDER } from "../intake-schedule";
import { intakeShortLabels } from "../intake-short-name";
import { dispatch } from "./index";
import { workoutFinishCallback } from "./callback-data";
import type { NotificationAction, NotificationMessage } from "./types";
import { createLogger } from "../log";
import { formatMedicationDoseProduct } from "../medication-dose-format";
import { GLYPH } from "./glyphs";
import {
  POST_WORKOUT_MARKER_PREFIX,
  postWorkoutAnnouncedOn,
  postWorkoutFinishMarkerKey,
} from "./post-workout-marker";
import {
  claimPostWorkoutDispatch,
  finalizePostWorkoutClaim,
  releasePostWorkoutClaim,
  type PostWorkoutClaimResult,
} from "./post-workout-claim";
import { announcedActivityTwin } from "../queries/integrations";
import { getProfileAge } from "../settings/profile-attrs";
import { isTrainingRelevant } from "../life-stage";

const log = createLogger("notify");

const ALL_WINDOWS: ReminderWindow[] = [
  "Morning",
  "Midday",
  "Evening",
  "Bedtime",
];

// --- Finish-triggered post-workout dose reminder ---

// The key and its builder live in the leaf module lib/notifications/post-workout-
// marker.ts since #2570, because the MERGE path has to read and write them and cannot
// afford to import this module's notification stack. Re-exported so every existing
// importer is unchanged.
export { POST_WORKOUT_MARKER_PREFIX, postWorkoutFinishMarkerKey };

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
  ).filter((e) => e.item.condition === "post_workout");
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
  // The #1156 obligation floor: a `may` SUPPLEMENT never rides a dose
  // reminder (body or buttons); medications are never gated (safety tier).
  const pending = notifiableWindowDoses(entries)
    .filter((e) => !e.taken && !e.skipped)
    .sort(
      (a, b) =>
        OBLIGATION_ORDER[a.item.obligation] -
          OBLIGATION_ORDER[b.item.obligation] ||
        a.item.name.localeCompare(b.item.name)
    );
  if (pending.length === 0) return null;

  const body = pending
    .map((e) => {
      const dose =
        e.item.kind === "medication"
          ? formatMedicationDoseProduct(e.dose.amount, e.item.product)
          : e.dose.amount;
      const amt = dose ? ` — ${dose}` : "";
      const mark =
        e.item.obligation === "must"
          ? `${GLYPH.required} `
          : `${GLYPH.bullet} `;
      return `${mark}${e.item.name}${amt}`;
    })
    .join("\n");

  const actions: NotificationAction[] = [];
  // Resolved over this message's own pending set (#2858 review): two ✅ buttons
  // reading alike over two different dose tokens is a wrong-subject tap, so a
  // colliding pair keeps its full names.
  const buttonLabels = intakeShortLabels(pending.map((e) => e.item));
  for (const [i, { dose, item }] of pending.entries()) {
    const row = `dose:${dose.id}`;
    actions.push({
      label: `${GLYPH.done} ${buttonLabels[i]}`,
      data: `take:${profileId}:${dose.id}:${item.id}:${date}`,
      row,
    });
    actions.push({
      label: `${GLYPH.skipped} Skip`,
      data: `skip:${profileId}:${dose.id}:${item.id}:${date}`,
      row,
    });
  }
  const noun = pending.length === 1 ? "dose" : "doses";
  return {
    title: `${GLYPH.training} Post-workout — ${pending.length} ${noun}`,
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

// How one call to the claim-owning core resolved (#3058). `sent` is the only
// arm that contacted anyone. The losing arms are typed rather than folded into
// a boolean so a caller — and a test — can tell "another caller owns this send"
// (`already-claimed` / `already-sent`, the durable claim's election) apart from
// "this row's own one-shot already fired" (`already-announced`), the #2570
// duplicate-cluster decline (`twin-announced`), an ineligible/empty run
// (`skipped`), and the two retryable ends (`no-channel`, `failed`).
export type PostWorkoutDispatchOutcome =
  | "sent"
  | "already-claimed"
  | "already-sent"
  | "already-announced"
  | "twin-announced"
  | "skipped"
  | "no-channel"
  | "failed";

// Deliver the post-workout reminder for ONE activity — the shared dispatch core
// (#1154 §B / #221): the presence-driven tick flagship AND the write-path
// delayed dispatch (lib/notifications/post-workout-queue.ts) both call this, so
// gating (dueness, the #924 recap composition, the #928 channel matrix), the
// one-shot marker AND the #3058 dispatch claim can never fork — no public or
// core path may perform the read-then-send sequence around this function.
// One-shot per activity id; only-when-pending; the marker is stamped only on
// delivery so a no-channel/failed run retries on the tick backstop.
//
// THE CLAIM (#3058). The marker check above the dispatch is read-then-act, and
// two callers outside one promise chain (another process; the core called
// directly while a queued run is mid-send) could both pass it before either
// stamped. So the send is now ELECTED: one immediate transaction re-runs the
// eligibility checks (marker, #2570 twin) and inserts the durable `pending`
// claim — the unique key picks exactly one winner across processes — and only
// the winner dispatches, outside the transaction. Any successful channel moves
// the claim to `sent` and stamps the marker in one transaction; a total failure
// releases the claim for the retry band; a crashed winner's claim expires on
// the lease (lib/notifications/post-workout-claim.ts). The residual crash
// window between a provider accepting and the `sent` commit remains the
// documented at-least-once boundary — see that module's header.
//
// `verifyCompletedToday` (the queued path) re-reads the activity at fire time
// and skips — without burning the one-shot — unless the row still exists for
// this profile, is dated today (profile-local), and is COMPLETED
// (isCompletedSessionRow): a finish that was undone in the delay window, or an
// edit that moved the session off today, sends nothing. The presence path skips
// this (presence already proved a just-finished session).
export async function runPostWorkoutForActivity(
  profileId: number,
  activityId: number,
  opts: { verifyCompletedToday?: boolean } = {}
): Promise<{ failed: boolean; outcome: PostWorkoutDispatchOutcome }> {
  if (!isTrainingRelevant(getProfileAge(profileId)))
    return { failed: false, outcome: "skipped" };
  const date = today(profileId);
  const finishRow = loadFinishRow(profileId, activityId);
  if (opts.verifyCompletedToday) {
    if (
      !finishRow ||
      finishRow.date !== date ||
      !isCompletedSessionRow(finishRow)
    )
      return { failed: false, outcome: "skipped" };
  }

  const markerKey = postWorkoutFinishMarkerKey(activityId);
  if (getProfileSetting(profileId, markerKey) != null)
    return { failed: false, outcome: "already-announced" };

  // DUPLICATE AWARENESS (#2570). The one-shot above is keyed on a ROW; a session can
  // be several rows, and a merge destroys and recreates that identity. So the send
  // also asks whether a row a HIGH-confidence detection calls the same session has
  // already been announced.
  //
  // Why this is needed ON TOP of the fold in lib/notifications/post-workout-marker.ts:
  // that fold covers the case where a merge HAPPENED and the keeper is a new id. Here
  // no merge happens at all — `autoMergeCluster` refuses every same-source group by
  // design, and a pair waiting for a human in Data → Review is not merged either — so
  // there is no fold to carry anything through. One bike ride mirrored twice into
  // Health Connect by the same app, 32 seconds apart, is exactly that case, and it
  // produced two contacts fifteen minutes apart.
  //
  // Declining costs nothing that matters: the twin's send already carried this
  // session's recap and its due post-workout doses, which are the same doses. The
  // one-shot is deliberately NOT burned here — a merge could still make this row the
  // keeper of a session that has not been announced, and the marker should then say
  // what actually happened rather than what was declined.
  const announcedTwin = announcedActivityTwin(
    profileId,
    activityId,
    (twinId) => postWorkoutAnnouncedOn(profileId, twinId) != null
  );
  if (announcedTwin != null) {
    log.info("post-workout finish nudge declined — session already announced", {
      profile: profileId,
      activity: activityId,
      announcedAs: announcedTwin,
    });
    return { failed: false, outcome: "twin-announced" };
  }

  // The recap-led composition (#924): the session recap line LEADS, then the due
  // post-workout supplement section. The recap line is gated by the workout-recap
  // kind (below); the dose section by dueness. Either alone still sends; both
  // absent ⇒ no send (and the one-shot is not burned).
  const doseMsg = buildPostWorkoutFinishReminder(profileId, date);
  // WHAT THE MESSAGE SAYS ABOUT THE SESSION is gathered by ./workout-recap-build, which
  // the #4996 prose reconciler re-runs to correct this very message after a merge
  // replaces its subject. One builder, two callers — the prose-claim class's rule.
  const parts = finishRecapParts(profileId, activityId);
  const msg = composeFinishNudge(
    parts.leadLine,
    doseMsg,
    parts.ask,
    parts.type
  );
  // Nothing to send — don't burn the one-shot, and don't claim a dispatch that
  // will never happen.
  if (!msg) return { failed: false, outcome: "skipped" };

  // THE ELECTION (#3058). One immediate transaction re-runs the eligibility
  // checks the fast path above already answered — they were read OUTSIDE any
  // lock, and this transaction is where they become the authoritative judgment
  // — and inserts the durable `pending` claim. The unique key elects exactly
  // one dispatcher across processes and database connections; a loser returns
  // its typed outcome having contacted nobody.
  const election = writeTx((): PostWorkoutClaimResult | "marker" | "twin" => {
    if (getProfileSetting(profileId, markerKey) != null) return "marker";
    if (
      announcedActivityTwin(
        profileId,
        activityId,
        (twinId) => postWorkoutAnnouncedOn(profileId, twinId) != null
      ) != null
    )
      return "twin";
    return claimPostWorkoutDispatch(profileId, activityId);
  });
  if (election !== "won") {
    if (election === "already-claimed" || election === "already-sent") {
      log.info("post-workout finish nudge declined — dispatch claimed", {
        profile: profileId,
        activity: activityId,
        claim: election,
      });
      return { failed: false, outcome: election };
    }
    return {
      failed: false,
      outcome: election === "marker" ? "already-announced" : "twin-announced",
    };
  }

  // ATTRIBUTION (#1721) is now `dispatch`'s (#4538): "🏋️ Post-workout — 2 doses" /
  // "🏋️ Workout complete" name nobody, and in a shared household chat a post-workout
  // DOSE list is unattributable — so the label is applied to every dispatch rather
  // than by whichever builder remembered to ask for it.
  //
  // The winner dispatches OUTSIDE the election transaction (#3058 contract): a
  // network round trip can never sit inside a write lock three processes share.
  const results = await dispatch(profileId, msg);
  if (results.length === 0) {
    // No channel configured — release the claim so a later-configured channel
    // (or the tick backstop) can elect a fresh winner.
    releasePostWorkoutClaim(profileId, activityId);
    return { failed: false, outcome: "no-channel" };
  }
  const delivered = results.some((r) => r.ok);
  const failed = results.some((r) => !r.ok);
  if (delivered) {
    // Any successful channel finalizes the claim AND stamps the one-shot in ONE
    // transaction (#3058 contract point 4): "this session was announced" is a
    // single atomic fact, whichever of the marker and the claim a reader asks.
    // The marker keeps its stamp-once re-read (#468) so a fold-carried value is
    // never overwritten. The crash window between the provider accepting and
    // this commit is the documented at-least-once boundary — a post-lease retry
    // may duplicate a contact there, never lose one.
    writeTx(() => {
      finalizePostWorkoutClaim(profileId, activityId);
      if (getProfileSetting(profileId, markerKey) == null) {
        setProfileSetting(profileId, markerKey, date);
      }
    });
    log.info("post-workout finish nudge sent", {
      profile: profileId,
      activity: activityId,
    });
    return { failed, outcome: "sent" };
  }
  // TOTAL failure: release the claim so the existing retry band (the hourly
  // tick backstop; the marker is unstamped) may try again immediately rather
  // than after the lease.
  releasePostWorkoutClaim(profileId, activityId);
  return { failed, outcome: "failed" };
}

// Deliver the post-workout reminder once, at the moment the session is `finished`
// (the presence-driven tick flagship). Delegates to the shared per-activity core.
export async function runPostWorkoutFinish(
  profileId: number,
  now: Date = clockNow()
): Promise<{ failed: boolean; outcome: PostWorkoutDispatchOutcome }> {
  const presence = getWorkoutPresence(profileId, now);
  if (presence.state !== "finished" || presence.activityId == null)
    return { failed: false, outcome: "skipped" };
  return runPostWorkoutForActivity(profileId, presence.activityId);
}

// --- Stale-session suggest ---

export const STALE_WORKOUT_MARKER_PREFIX = "notify_stale_workout_";
export function staleWorkoutMarkerKey(activityId: number): string {
  return `${STALE_WORKOUT_MARKER_PREFIX}${activityId}`;
}

// The stale-session nudge (#560), now ACTIONABLE (#1205): a "🏁 Finish workout" and
// "🗑️ Discard" inline button that resolve the stale draft in place (the two-way
// principle — one idempotent, low-risk state change through the shared
// finishWorkoutSession/discardWorkoutSession cores; the tokens carry ids only), plus
// the "Open workout" deep-link that non-Telegram channels (Web Push / Home Assistant,
// which can't do a stateful callback) fall back to. The buttons need the activity id
// to act on and the profile id as the resolve-against-chat cross-check.
export function renderStaleWorkoutMessage(
  profileId: number,
  activityId: number,
  profileName: string,
  deepLinkBase = ""
): NotificationMessage {
  const who = profileName ? ` — ${profileName}` : "";
  const base = deepLinkBase.replace(/\/$/, "");
  const actions: NotificationAction[] = [
    {
      label: `${GLYPH.finish} Finish workout`,
      data: workoutFinishCallback(profileId, activityId, "finish"),
      row: "finish",
    },
    {
      label: `${GLYPH.discarded} Discard`,
      data: workoutFinishCallback(profileId, activityId, "discard"),
      row: "finish",
    },
  ];
  if (base) actions.push({ label: "Open workout", url: `${base}/training` });
  return {
    title: `${GLYPH.inProgress} Still working out?${who}`,
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
  now: Date = clockNow()
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
    renderStaleWorkoutMessage(
      profileId,
      presence.activityId,
      profileName,
      getPublicUrl()
    )
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
