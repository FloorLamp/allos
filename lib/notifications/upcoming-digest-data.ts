// "What's due" digest DB gather + send orchestration (issue #213, Phase 3). Reuses
// the Upcoming aggregation — collectUpcoming (fully profile-scoped, and already
// filtered through the page's snooze/dismiss + isTrainingRestricted rules) and the
// pure groupUpcoming banding — so the push and the page never diverge. Called once
// per hour per profile from the notify tick; hard-deduped to one send per profile
// per day, mirroring the morning digest (#135) dedup + gating exactly.

import { today } from "../db";
import { collectUpcoming } from "../queries";
import { groupUpcoming } from "../upcoming";
import { getProfileSetting, setProfileSetting } from "../settings";
import { dispatch } from "./index";
import {
  buildUpcomingDigest,
  renderUpcomingDigestMessage,
} from "./upcoming-digest";
import { createLogger } from "../log";

const log = createLogger("notify");

// Per-profile/day dedup marker (value = the profile-local date it last sent),
// distinct from the morning digest's notify_last_digest so the two coexist.
const DEDUP_KEY = "notify_last_upcoming";

// Build + send this profile's "due soon" digest for `date`. Returns whether a
// send failed. Marks the day done (per-profile/day dedup) whether it sent or found
// nothing to say, so it isn't recomputed every hour; leaves it unmarked only when
// no channel is configured, so it can send once Telegram is set up.
export async function runUpcomingDigest(
  profileId: number,
  profileName: string,
  date: string
): Promise<{ failed: boolean }> {
  const td = today(profileId);
  // collectUpcoming already drops snoozed/dismissed items and training items for
  // an age-restricted profile, so the digest inherits both for free.
  const groups = groupUpcoming(collectUpcoming(profileId, td), td);
  const model = buildUpcomingDigest(profileName, groups);
  if (!model) {
    // Nothing due — mark the day done so we don't recompute every hour.
    setProfileSetting(profileId, DEDUP_KEY, date);
    log.info("upcoming digest: nothing to send", { profile: profileId });
    return { failed: false };
  }

  const results = await dispatch(profileId, renderUpcomingDigestMessage(model));
  if (results.length === 0) {
    // No channel configured (Telegram off / no chat id): leave unmarked so it can
    // send once configured.
    return { failed: false };
  }
  const delivered = results.some((r) => r.ok);
  const failed = results.some((r) => !r.ok);
  if (delivered) {
    setProfileSetting(profileId, DEDUP_KEY, date);
    log.info("upcoming digest sent", {
      profile: profileId,
      total: model.total,
    });
  }
  return { failed };
}
