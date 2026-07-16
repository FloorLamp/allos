// Proactive illness-care nudge (issue #805). Once per waking day per profile, checks
// whether the profile's CURRENT open illness episode has crossed a cited
// duration/trajectory care line (the SAME illnessCareFindingsFor computation the
// Upcoming page + Needs-attention hero render) and pings when a NEW finding comes due.
// The pure episode/dedup decision is lib/illness-care (planIllnessCareNudges); this
// file is the DB gather + marker read/write + send, mirroring ./preventive and
// ./refill.
//
// CARE-TIER, BUS-GATED (deliberately, per docs/internals/notifications.md): an
// illness-care finding is a REMINDER-class care finding — not a dose-safety signal —
// so it IS gated by the shared findings-suppression bus (dismiss-once-silence-
// everywhere, #227/#245): a finding dismissed/snoozed on Upcoming or the hero is held
// out of the push too. This is the opposite of the safety-tier senders (dose
// reminders, missed-dose escalation, PRN redose), which are DELIBERATELY never
// bus-gated because a page dismissal must never silence a possibly-critical dose
// signal.
//
// Dedup semantics — "once per finding EPISODE", not once per day:
//   - notify_last_illnesscare_<dedupeKey> is set once a nudge goes out and suppresses
//     further nudges while that finding stays actionable.
//   - The marker is CLEARED the moment the finding is no longer actionable (the
//     episode closed, the streak broke, the symptom resolved), so a fresh crossing
//     re-fires. The marked set is the FULL live-marker set, so a stale marker whose
//     finding vanished entirely is still swept (the refill nudge's #325 self-heal).

import { illnessCareFindingsFor } from "../illness-care-findings";
import {
  planIllnessCareNudges,
  illnessCareFullDetail,
  type IllnessCareFinding,
} from "../illness-care";
import { getFindingSuppressions } from "../queries/upcoming";
import { isSuppressed } from "../upcoming-suppress";
import {
  setProfileSetting,
  deleteProfileSetting,
  getProfileSettingKeysWithPrefix,
  getPublicUrl,
} from "../settings";
import { episodeHref } from "../hrefs";
import { dispatch } from "./index";
import type { NotificationAction, NotificationMessage } from "./types";
import { createLogger } from "../log";

const log = createLogger("notify");

// Marker prefix + per-finding key. The suffix is the finding's full dedupeKey (which
// itself starts with `illness-care:`), so each finding dedups independently and the
// marker maps 1:1 to the bus key.
const MARKER_PREFIX = "notify_last_illnesscare_";
const markerKey = (dedupeKey: string) => `${MARKER_PREFIX}${dedupeKey}`;
const dedupeKeyFromMarker = (key: string) => key.slice(MARKER_PREFIX.length);

// Render ONE illness-care finding's nudge — the fact + the cited line + the source +
// the mandatory "not medical advice" tail (the #798 discipline: cite, never
// generate; never "you should", never a diagnosis). A deep-link "View episode"
// button (when a public URL is configured) is the only affordance — no state-change
// buttons (there is nothing idempotent to toggle), following the two-way principle.
export function renderIllnessCareMessage(
  profileName: string,
  finding: IllnessCareFinding,
  episodeDay: string,
  deepLinkBase = ""
): NotificationMessage {
  const who = profileName ? `${profileName} — ` : "";
  const base = deepLinkBase.replace(/\/$/, "");
  const actions: NotificationAction[] = base
    ? [{ label: "View episode", url: `${base}${episodeHref(episodeDay)}` }]
    : [];
  return {
    title: `🌡️ Illness check: ${who}${finding.title}`,
    body: illnessCareFullDetail(finding),
    actions,
    kind: "illness-care",
  };
}

// Send any newly-actionable illness-care nudges for one profile. Returns whether a
// send failed (aggregated into the tick's exit code). Never throws for an ordinary
// send failure. `date` is the profile-local date, used as the dedup marker value.
export async function runIllnessCare(
  profileId: number,
  profileName: string,
  date: string
): Promise<{ failed: boolean }> {
  // The SAME computation the Upcoming page / hero render — one question, one answer.
  const findings = illnessCareFindingsFor(profileId, date);
  const byKey = new Map<string, IllnessCareFinding>(
    findings.map((f) => [f.dedupeKey, f])
  );

  // Route through the shared findings-suppression bus (#227): a finding
  // dismissed/snoozed on a page (keyed by the identical dedupeKey) is held out of the
  // push, with its episode marker frozen.
  const suppressions = getFindingSuppressions(profileId);
  const suppressedKeys = findings
    .filter((f) => {
      const rec = suppressions.get(f.dedupeKey);
      return rec != null && isSuppressed(rec, date);
    })
    .map((f) => f.dedupeKey);

  // The FULL set of live episode markers — NOT just the current findings — so a
  // marker whose finding has vanished entirely (episode closed) still reaches the
  // self-healing clear (#325).
  const markedKeys = getProfileSettingKeysWithPrefix(
    profileId,
    MARKER_PREFIX
  ).map(dedupeKeyFromMarker);

  const { toSend, toClear } = planIllnessCareNudges(
    byKey.keys(),
    markedKeys,
    suppressedKeys
  );

  // End any finished episodes first — cheap, and never depends on a successful send.
  for (const dedupeKey of toClear) {
    deleteProfileSetting(profileId, markerKey(dedupeKey));
    log.info("illness-care episode ended", {
      profile: profileId,
      key: dedupeKey,
    });
  }

  if (toSend.length === 0) return { failed: false };

  const base = getPublicUrl();
  let failed = false;
  // One message PER finding so the title + deep link attach to the named symptom.
  for (const dedupeKey of toSend) {
    const finding = byKey.get(dedupeKey);
    if (!finding) continue;
    const results = await dispatch(
      profileId,
      renderIllnessCareMessage(profileName, finding, date, base)
    );
    if (results.length === 0) {
      // No channel configured — leave markers unset so it can send once configured.
      log.info("illness-care nudge skipped: no channel", {
        profile: profileId,
      });
      return { failed };
    }
    if (results.some((r) => !r.ok)) failed = true;
    if (results.some((r) => r.ok)) {
      setProfileSetting(profileId, markerKey(dedupeKey), date);
      log.info("illness-care nudge sent", {
        profile: profileId,
        key: dedupeKey,
        variant: finding.variant,
      });
    }
  }
  return { failed };
}
