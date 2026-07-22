// Proactive preventive-care nudge (issue #87). Once per hour per profile, checks
// the profile's due/overdue preventive visits & screenings (the SAME assessment
// the Upcoming page and its digest use) and pings when a NEW item comes due —
// rather than the item only ever appearing in the "what's due" digest. Each
// newly-due screening is its own message (rendering: ./preventive-format) so its
// buttons attach to the named item. The pure episode/dedup decision is
// lib/preventive-nudge; this file is the DB gather + marker read/write + send,
// mirroring ./refill.
//
// Dedup semantics — "once per due EPISODE", not once per day:
//   - notify_last_preventive_<ruleKey> is set (to the send date) once a nudge goes
//     out and suppresses further nudges while the item stays due/overdue.
//   - The marker is CLEARED the moment the item is no longer actionable (satisfied,
//     overridden, or aged out), so the next interval's due re-fires a fresh nudge.
//
// The whole domain is gated by the per-profile toggle (Settings → Profile →
// preventiveEnabled): off ⇒ no nudge at all (and the digest drops these lines too).

import { today } from "../db";
import {
  assessProfilePreventive,
  getFindingSuppressions,
  clearPreventiveDismissal,
} from "../queries/upcoming";
import { kindedScheduled } from "../queries/appointments";
import { scheduledMatchForRule } from "../preventive-appointment";
import {
  preventiveSignalKey,
  preventiveNudgeAction,
} from "../preventive-upcoming";
import { isSuppressed } from "../upcoming-suppress";
import {
  planPreventiveNudges,
  type PreventiveNudgeItem,
} from "../preventive-nudge";
import {
  getNotifySchedule,
  getProfileSettingKeysWithPrefix,
  setProfileSetting,
  deleteProfileSetting,
  getPublicUrl,
} from "../settings";
import { dispatch } from "./index";
import { renderPreventiveMessage } from "./preventive-format";
import { createLogger } from "../log";

const log = createLogger("notify");

// Marker prefix + per-rule key. The suffix is the catalog rule key (e.g.
// "colorectal_cancer"), so each rule dedups independently.
const MARKER_PREFIX = "notify_last_preventive_";
const markerKey = (ruleKey: string) => `${MARKER_PREFIX}${ruleKey}`;
const ruleKeyFromMarker = (key: string) => key.slice(MARKER_PREFIX.length);

// Send any newly-due preventive nudges for one profile. Returns whether a send
// failed (aggregated into the tick's exit code). Never throws for an ordinary send
// failure. `date` is the profile-local date, used as the dedup marker value.
export async function runPreventive(
  profileId: number,
  profileName: string,
  date: string
): Promise<{ failed: boolean }> {
  // Domain toggle off ⇒ do nothing (no nudge, no marker churn). Stale markers are
  // reconciled the moment it's turned back on (planPreventiveNudges clears any that
  // are no longer actionable).
  if (!getNotifySchedule(profileId).preventiveEnabled) return { failed: false };

  const td = today(profileId);
  const assessments = assessProfilePreventive(profileId, td).actionable;
  const actionable: PreventiveNudgeItem[] = assessments.map((a) => {
    // The concrete-action deep link + CTA (#1083) — the SAME per-class link + label
    // the Upcoming row derives (#221), so page and push agree on the next step.
    const action = preventiveNudgeAction(a, td);
    return {
      ruleKey: a.key,
      name: a.name,
      // actionable is exactly the due/overdue slice, so the status narrows cleanly.
      status: a.status === "overdue" ? "overdue" : "due",
      detail: a.nextLabel ?? a.detail ?? null,
      href: action?.href ?? null,
      ctaLabel: action?.label ?? null,
    };
  });

  const markedRuleKeys = getProfileSettingKeysWithPrefix(
    profileId,
    MARKER_PREFIX
  ).map(ruleKeyFromMarker);

  // Rules already covered by a future matching-kind booking (issue #183) — the SAME
  // profile-scoped read the Upcoming builder uses to quiet an item to "Scheduled"
  // (issue #85), so the push never contradicts the page. A covered rule is held out
  // of the nudge without burning its once-per-episode marker.
  const scheduled = kindedScheduled(profileId);
  const coveredRuleKeys = actionable
    .filter((it) => scheduledMatchForRule(it.ruleKey, scheduled, td) != null)
    .map((it) => it.ruleKey);

  // Rules the user dismissed/snoozed on the Upcoming page (#227): the SAME shared
  // findings-suppression bus, keyed by the identical `<kind>:<ruleKey>` signal the
  // Upcoming item carries — so a page dismissal silences the push. Like a covered
  // rule, a suppressed rule is held out of the nudge with its episode marker frozen.
  const suppressions = getFindingSuppressions(profileId);
  const suppressedRuleKeys = assessments
    .filter((a) => {
      const rec = suppressions.get(preventiveSignalKey(a.kind, a.key));
      return rec != null && isSuppressed(rec, td);
    })
    .map((a) => a.key);

  const { toSend, toClear } = planPreventiveNudges(
    actionable,
    markedRuleKeys,
    coveredRuleKeys,
    suppressedRuleKeys
  );

  // End any episodes that are no longer due first — cheap, and it never depends on
  // a successful send.
  for (const ruleKey of toClear) {
    deleteProfileSetting(profileId, markerKey(ruleKey));
    // The episode ended without an explicit "done" (satisfied by record inference,
    // aged out, overridden) — retire any indefinite page dismissal too, so the next
    // cycle's due isn't silenced by this episode's stale suppression (issue #1024).
    // recordPreventiveDone covers the "done"-tap / satisfying-event paths; this covers
    // the rest (and the notification-less instances are covered there in turn).
    clearPreventiveDismissal(profileId, ruleKey);
    log.info("preventive episode ended", { profile: profileId, rule: ruleKey });
  }

  if (toSend.length === 0) return { failed: false };

  // One message PER screening (see preventive-format.ts): the buttons attach to
  // the named item. Each item's episode marker is set on ITS OWN delivery, so a
  // mid-loop failure re-attempts only the items that never went out.
  // Absolute deep-link base for the nudge's "go do it" button (#1083) — same pattern
  // the refill/food/workout nudges use; empty ⇒ the button degrades to omitted.
  const deepLinkBase = getPublicUrl();
  let failed = false;
  for (const it of toSend) {
    const results = await dispatch(
      profileId,
      renderPreventiveMessage(profileName, it, profileId, deepLinkBase)
    );
    if (results.length === 0) {
      // No channel configured — leave markers unset so it can send once
      // configured. Channels don't appear mid-loop; stop instead of re-logging.
      log.info("preventive nudge skipped: no channel", { profile: profileId });
      return { failed };
    }
    if (results.some((r) => !r.ok)) failed = true;
    if (results.some((r) => r.ok)) {
      setProfileSetting(profileId, markerKey(it.ruleKey), date);
      log.info("preventive nudge sent", {
        profile: profileId,
        rule: it.ruleKey,
        status: it.status,
      });
    }
  }
  return { failed };
}
