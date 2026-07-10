// Proactive preventive-care nudge (issue #87). Once per hour per profile, checks
// the profile's due/overdue preventive visits & screenings (the SAME assessment
// the Upcoming page and its digest use) and sends a single Telegram ping when a NEW
// item comes due — rather than the item only ever appearing in the "what's due"
// digest. The pure episode/dedup decision is lib/preventive-nudge; this file is the
// DB gather + marker read/write + send, mirroring ./refill.
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
import { assessProfilePreventive } from "../queries/upcoming";
import { kindedScheduled } from "../queries/appointments";
import { scheduledMatchForRule } from "../preventive-appointment";
import {
  planPreventiveNudges,
  type PreventiveNudgeItem,
} from "../preventive-nudge";
import {
  getNotifySchedule,
  getProfileSettingKeysWithPrefix,
  setProfileSetting,
  deleteProfileSetting,
} from "../settings";
import { dispatch } from "./index";
import type { NotificationMessage } from "./types";
import { createLogger } from "../log";

const log = createLogger("notify");

// Marker prefix + per-rule key. The suffix is the catalog rule key (e.g.
// "colorectal_cancer"), so each rule dedups independently.
const MARKER_PREFIX = "notify_last_preventive_";
const markerKey = (ruleKey: string) => `${MARKER_PREFIX}${ruleKey}`;
const ruleKeyFromMarker = (key: string) => key.slice(MARKER_PREFIX.length);

// The preventive nudge. Names the profile (a shared/caregiver chat may carry
// several profiles) and lists each due/overdue item. A nudge, so no action button —
// following through means booking a visit / logging a result in the app.
export function renderPreventiveMessage(
  profileName: string,
  items: PreventiveNudgeItem[]
): NotificationMessage {
  const who = profileName ? `${profileName} — ` : "";
  const head =
    items.length === 1 ? items[0].name : `${items.length} preventive items due`;
  const lines = items.map((it) => {
    const tag = it.status === "overdue" ? "Overdue" : "Due";
    const extra = it.detail ? ` — ${it.detail}` : "";
    return `• ${it.name}: ${tag}${extra}`;
  });
  return {
    title: `🩺 Preventive care: ${who}${head}`,
    body: `Recommended preventive care is due:\n${lines.join(
      "\n"
    )}\n\nInformational only — not medical advice.`,
  };
}

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
  const actionable: PreventiveNudgeItem[] = assessProfilePreventive(
    profileId,
    td
  ).actionable.map((a) => ({
    ruleKey: a.key,
    name: a.name,
    // actionable is exactly the due/overdue slice, so the status narrows cleanly.
    status: a.status === "overdue" ? "overdue" : "due",
    detail: a.nextLabel ?? a.detail ?? null,
  }));

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

  const { toSend, toClear } = planPreventiveNudges(
    actionable,
    markedRuleKeys,
    coveredRuleKeys
  );

  // End any episodes that are no longer due first — cheap, and it never depends on
  // a successful send.
  for (const ruleKey of toClear) {
    deleteProfileSetting(profileId, markerKey(ruleKey));
    log.info("preventive episode ended", { profile: profileId, rule: ruleKey });
  }

  if (toSend.length === 0) return { failed: false };

  const results = await dispatch(
    profileId,
    renderPreventiveMessage(profileName, toSend)
  );
  if (results.length === 0) {
    // No channel configured — leave markers unset so it can send once configured.
    log.info("preventive nudge skipped: no channel", { profile: profileId });
    return { failed: false };
  }
  const delivered = results.some((r) => r.ok);
  const failed = results.some((r) => !r.ok);
  if (delivered) {
    for (const it of toSend) {
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
