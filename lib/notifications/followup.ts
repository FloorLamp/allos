// Overdue safety-follow-up escalation (issue #1866, owner ruling 2026-08-01). Once
// per waking day per profile, checks whether any tracked finding follow-up (#700)
// is OVERDUE — the SAME followUpItems computation the Upcoming page + Needs-attention
// hero render, one question one answer — and pushes on the conservative two-send
// cadence the pure planner (lib/followup-nudge.ts) owns: one send when the follow-up
// crosses overdue, one repeat FOLLOWUP_REPEAT_DAYS later framed as final, then
// nothing further — the finding keeps holding the calm surfaces forever.
//
// ZERO NEW SETTINGS (the owner ruling's first requirement): delivery is governed
// entirely by the channels the user already enabled — dispatch()'s isConfigured
// gates — and the `followup` kind is NON_CONFIGURABLE by design. The consent is the
// tracked due date itself (the user recorded this follow-up as a care item with a
// date — the same structure that makes a `must` medication remind without a "remind
// me about medications" toggle).
//
// SAFETY-TIER SUPPRESSION, VIA THE SHARED POLICY — NOT a bus-gated nudge and NOT a
// fork: the send gate is isHiddenUnderPolicy under the item's OWN declared policy
// (itemSuppressionPolicy → "snooze-only" for an overdue follow-up, #700 ask 5 /
// #942), keyed by the IDENTICAL `followup:<id>` dedupeKey the visible finding
// carries. So an Upcoming DISMISS is RESISTED (it never silences this send — the
// same posture the page itself takes), while a deliberate time-boxed SNOOZE defers
// it with the cadence marker frozen (#227). The ONLY permanent off-switch is the
// per-item terminator (settleFollowUpCore — "done on <date>" / "discussed, not
// doing it"), which removes the follow-up from the overdue set entirely.
//
// Marker discipline: notify_last_followup_<carePlanItemId> stores the send DATES
// (the whole cadence state); stamped only on a delivered send, swept when the
// follow-up leaves the overdue set (#325). Delivery-health folds through dispatch()
// like every sender, and any Telegram write rides the one chokepoint underneath it.

import { followUpItems } from "../followup-findings";
import {
  planFollowUpNudges,
  followUpNudgeMarkerKey,
  followUpIdFromMarker,
  parseFollowUpMarker,
  serializeFollowUpMarker,
  FOLLOWUP_NUDGE_MARKER_PREFIX,
  type FollowUpNudgeCandidate,
  type FollowUpNudgeStage,
} from "../followup-nudge";
import { itemSuppressionPolicy } from "../upcoming-suppress";
import { isHiddenUnderPolicy } from "../lifecycle";
import { getFindingSuppressions } from "../queries/upcoming";
import {
  getProfileSetting,
  setProfileSetting,
  deleteProfileSetting,
  getProfileSettingKeysWithPrefix,
  getPublicUrl,
} from "../settings";
import { dispatch } from "./index";
import type { NotificationAction, NotificationMessage } from "./types";
import type { UpcomingItem } from "../upcoming";
import { createLogger } from "../log";
import { GLYPH } from "./glyphs";

const log = createLogger("notify");

// Render ONE overdue follow-up's escalation message. States the fact (what, due
// when, for which source finding) and the honest cadence framing: the repeat says
// out loud that it is the last message and where the item keeps living. Copy is
// channel-neutral (#1718 — it names no button any channel strips); the only
// affordance is a deep link to Upcoming, where the terminator controls live.
export function renderFollowUpNudgeMessage(
  profileName: string,
  item: Pick<UpcomingItem, "title" | "detail" | "dueDate" | "reasons">,
  stage: FollowUpNudgeStage,
  deepLinkBase = ""
): NotificationMessage {
  const who = profileName ? `${profileName} — ` : "";
  const lines: string[] = [];
  if (item.dueDate) lines.push(`Was due ${item.dueDate}.`);
  if (item.detail) lines.push(item.detail);
  lines.push(
    stage === "repeat"
      ? "Final reminder — this stays on your Upcoming list until you record it as done or decline it."
      : "You can mark it done, decline it, or snooze it from your Upcoming list."
  );
  const base = deepLinkBase.replace(/\/$/, "");
  const actions: NotificationAction[] = base
    ? [{ label: "Open Upcoming", url: `${base}/upcoming` }]
    : [];
  return {
    title: `${GLYPH.clinical} Overdue follow-up: ${who}${item.title}`,
    body: lines.join("\n"),
    actions,
    kind: "followup",
  };
}

// Send any due overdue-follow-up escalations for one profile. Returns whether a
// send failed (aggregated into the tick's exit code). Never throws for an ordinary
// send failure. `date` is the profile-local date — the dedup marker value and the
// overdue/suppression evaluation day.
export async function runFollowUpNudges(
  profileId: number,
  profileName: string,
  date: string
): Promise<{ failed: boolean }> {
  // The SAME computation the Upcoming page / hero render. Overdue = the items the
  // builder marked care-persistent (exactly the overdue state, #700 ask 5).
  const items = followUpItems(profileId, date);
  const overdue = items.filter(
    (i) => i.carePersistent === true && i.followUpSettle != null
  );

  // The FULL set of live cadence markers — not just current candidates — so a marker
  // whose follow-up left the overdue set (settled, resolved, deleted, re-dated) is
  // swept (#325).
  const markedIds = getProfileSettingKeysWithPrefix(
    profileId,
    FOLLOWUP_NUDGE_MARKER_PREFIX
  )
    .map(followUpIdFromMarker)
    .filter((id) => Number.isInteger(id) && id > 0);

  if (overdue.length === 0 && markedIds.length === 0) return { failed: false };

  // Suppression through the ONE shared policy decision (#942): the item's own
  // "snooze-only" tier — a live snooze freezes the cadence; a dismiss is resisted
  // and never reaches the plan. Keyed by the identical dedupeKey the finding carries.
  const suppressions = getFindingSuppressions(profileId);
  const suppressedIds = overdue
    .filter((i) =>
      isHiddenUnderPolicy(
        itemSuppressionPolicy(i),
        suppressions.get(i.key),
        date
      )
    )
    .map((i) => i.followUpSettle!.carePlanItemId);

  const candidates: FollowUpNudgeCandidate[] = overdue.map((i) => ({
    id: i.followUpSettle!.carePlanItemId,
    sentDates: parseFollowUpMarker(
      getProfileSetting(
        profileId,
        followUpNudgeMarkerKey(i.followUpSettle!.carePlanItemId)
      )
    ),
  }));

  const { toSend, toClear } = planFollowUpNudges(
    candidates,
    markedIds,
    suppressedIds,
    date
  );

  // End any finished escalations first — cheap, and never depends on a send.
  for (const id of toClear) {
    deleteProfileSetting(profileId, followUpNudgeMarkerKey(id));
    log.info("followup escalation ended", { profile: profileId, id });
  }

  if (toSend.length === 0) return { failed: false };

  const byId = new Map(
    overdue.map((i) => [i.followUpSettle!.carePlanItemId, i])
  );
  const base = getPublicUrl();
  let failed = false;
  // One message PER follow-up so the title names the concrete follow-up and the
  // cadence stage attaches to the right chain node.
  for (const s of toSend) {
    const item = byId.get(s.id);
    if (!item) continue;
    const results = await dispatch(
      profileId,
      renderFollowUpNudgeMessage(profileName, item, s.stage, base)
    );
    if (results.length === 0) {
      // No channel configured — leave markers unset so it can send once configured.
      // "No channels, nothing new happens" is the owner ruling's own boundary.
      log.info("followup nudge skipped: no channel", { profile: profileId });
      return { failed };
    }
    if (results.some((r) => !r.ok)) failed = true;
    if (results.some((r) => r.ok)) {
      const cand = candidates.find((c) => c.id === s.id);
      setProfileSetting(
        profileId,
        followUpNudgeMarkerKey(s.id),
        serializeFollowUpMarker([...(cand?.sentDates ?? []), date])
      );
      log.info("followup nudge sent", {
        profile: profileId,
        id: s.id,
        stage: s.stage,
      });
    }
  }
  return { failed };
}
