// Proactive single-reading temperature red-flag nudge (issue #859 item 3). Mirrors
// ./illness-care: once a profile's current open episode logs a reading that crosses a
// cited, age-banded red flag (the SAME tempRedFlagFindingFor computation the Upcoming
// page and dashboard render), it pings — once per finding, bus-gated.
//
// CARE-TIER, BUS-GATED (like ./illness-care, per docs/internals/notifications.md): a
// red-flag note is a REMINDER-class care finding, so a dismiss on Upcoming or the dashboard
// (keyed by the identical dedupeKey) holds it out of the push too. The marker
// (notify_last_tempredflag_<dedupeKey>) suppresses re-nudging while the finding stays
// actionable and is cleared the moment it's no longer actionable (a later normal
// reading, the episode closed), so a fresh crossing re-fires.

import { tempRedFlagFindingFor } from "../temp-red-flag-findings";
import { episodeForProfileDate } from "../illness-episode";
import {
  tempRedFlagFullDetail,
  type TempRedFlagFinding,
} from "../temp-red-flag";
import { detectTempRedFlag } from "../datasets/temperature-red-flags";
import { planIllnessCareNudges } from "../illness-care";
import { getFindingSuppressions } from "../queries/upcoming";
import { isSuppressed } from "../upcoming-suppress";
import {
  getProfileSetting,
  setProfileSetting,
  deleteProfileSetting,
  getProfileSettingKeysWithPrefix,
  getPublicUrl,
  profileAgeMonths,
} from "../settings";
import { db, nowTime, today } from "../db";
import { hhmmToMinutes, shiftDateStr } from "../date";
import { episodeHref } from "../hrefs";
import { dispatch } from "./index";
import type { NotificationAction, NotificationMessage } from "./types";
import { createLogger } from "../log";
import { GLYPH } from "./glyphs";

const log = createLogger("notify");

const MARKER_PREFIX = "notify_last_tempredflag_";
const markerKey = (dedupeKey: string) => `${MARKER_PREFIX}${dedupeKey}`;
const dedupeKeyFromMarker = (key: string) => key.slice(MARKER_PREFIX.length);
// A live finding whose send failed. The marker is the "sent" token, so it cannot say
// this; the owed record lets the tick retry across a day roll (#5984).
const OWED_PREFIX = "notify_owed_tempredflag_";
const owedKey = (dedupeKey: string) => `${OWED_PREFIX}${dedupeKey}`;

// Render the nudge from the finding's title, cited line, and source. A "View episode"
// deep-link is the only affordance (nothing idempotent to toggle), following the two-way
// principle.
//
// THE PROFILE IS NAMED ONCE, BY THE ONE THING THAT OWNS NAMING IT (#377/#429). This used
// to interpolate the name itself, so every send through `dispatch` — which composes the
// "[Name] " attribution prefix over the title — read "[Dune] 🌡️ Fever check: Dune — …".
// On a single-profile instance the prefix is empty by design and the hand-rolled copy
// still named the only person there is. Neither case wanted a name here.
//
// THERE IS NO CATEGORY LABEL EITHER. "Fever check:" preceded a title that already opens
// with what crossed ("Very high fever — 40.1 °C / 104.2 °F"), so the word "fever"
// appeared twice before the reading did, and "check" is the wrong verb for a message
// whose body says to call someone now.
export function renderTempRedFlagMessage(
  title: string,
  body: string,
  episodeId: number | null,
  deepLinkBase = ""
): NotificationMessage {
  const base = deepLinkBase.replace(/\/$/, "");
  const actions: NotificationAction[] =
    base && episodeId != null
      ? [{ label: "View episode", url: `${base}${episodeHref(episodeId)}` }]
      : [];
  return {
    title: `${GLYPH.temperature} ${title}`,
    body,
    actions,
    kind: "illness-care",
  };
}

// Who asked for a run, and which day it judges staleness against. The tick judges
// against its own day and retries a finding an earlier run judged live but failed to
// deliver. An event door judges against the day its event happened and leaves the
// owed record to the tick, so the two cannot both deliver it.
export interface TempRedFlagAsk {
  staleBefore: string;
  retryOwed: boolean;
}

// Clear the marker and owed record of a finding that is gone, and return the finding
// still due a send, if any. Sends nothing, so a normal reading can run it (#6018).
function settleTempRedFlag(
  profileId: number,
  date: string
): TempRedFlagFinding | null {
  // "dual" display (#1019): the nudge has no login-unit context (prefs are
  // per-login, notifications per-profile), and a mixed-preference household must
  // read a fever red-flag correctly either way — so the safety message carries
  // BOTH scales ("38.5 °C / 101.3 °F"). The dedupeKey is display-independent, so
  // the bus gating below still matches the web surfaces' keys exactly.
  const finding = tempRedFlagFindingFor(profileId, date, "dual");
  const actionableKeys = finding ? [finding.dedupeKey] : [];

  // Route through the shared findings-suppression bus (#227).
  const suppressions = getFindingSuppressions(profileId);
  const suppressedKeys = actionableKeys.filter((k) => {
    const rec = suppressions.get(k);
    return rec != null && isSuppressed(rec, date);
  });

  const markedKeys = getProfileSettingKeysWithPrefix(
    profileId,
    MARKER_PREFIX
  ).map(dedupeKeyFromMarker);

  const { toSend, toClear } = planIllnessCareNudges(
    actionableKeys,
    markedKeys,
    suppressedKeys
  );

  for (const dedupeKey of toClear) {
    deleteProfileSetting(profileId, markerKey(dedupeKey));
    log.info("temp-red-flag cleared", { profile: profileId, key: dedupeKey });
  }
  // An owed retry ends with its finding, or when the finding is snoozed or dismissed:
  // a snooze that lapses days later must not push a finding that old.
  for (const key of getProfileSettingKeysWithPrefix(profileId, OWED_PREFIX)) {
    const dedupeKey = key.slice(OWED_PREFIX.length);
    if (
      !actionableKeys.includes(dedupeKey) ||
      suppressedKeys.includes(dedupeKey)
    ) {
      deleteProfileSetting(profileId, key);
    }
  }

  return toSend.length > 0 ? finding : null;
}

// Send the temperature red-flag nudge for one profile when a NEW crossing comes due.
// Returns whether a send failed. `date` is the profile-local date (the dedup value).
export async function runTempRedFlag(
  profileId: number,
  date: string,
  ask: TempRedFlagAsk = { staleBefore: date, retryOwed: true }
): Promise<{ failed: boolean }> {
  const finding = settleTempRedFlag(profileId, date);
  if (!finding) return { failed: false };

  // REFUSED HERE: a finding that was already stale when the run started (#5969, #5984):
  // its day precedes `ask.staleBefore`, and no earlier live run left it owed. Only the
  // send is refused. The finding is still actionable, so its marker, if any, stays and
  // the web surfaces keep showing it; a backdated episode open pushes nothing.
  const owed =
    ask.retryOwed &&
    getProfileSetting(profileId, owedKey(finding.dedupeKey)) != null;
  if (finding.date < ask.staleBefore && !owed) return { failed: false };

  const base = getPublicUrl();
  const episodeId = episodeForProfileDate(profileId, date)?.id ?? null;
  const results = await dispatch(
    profileId,
    renderTempRedFlagMessage(
      finding.title,
      tempRedFlagFullDetail(finding),
      episodeId,
      base
    )
  );
  if (results.length === 0) {
    log.info("temp-red-flag nudge skipped: no channel", { profile: profileId });
    return { failed: false };
  }
  const failed = results.some((r) => !r.ok);
  if (results.some((r) => r.ok)) {
    setProfileSetting(profileId, markerKey(finding.dedupeKey), date);
    deleteProfileSetting(profileId, owedKey(finding.dedupeKey));
    log.info("temp-red-flag nudge sent", {
      profile: profileId,
      key: finding.dedupeKey,
    });
  } else {
    setProfileSetting(profileId, owedKey(finding.dedupeKey), date);
  }
  return { failed };
}

// Event-driven dispatch at the temperature WRITE path (#1025 ask 2): after a
// successful reading write whose value crosses a red-flag line, evaluate + send
// immediately instead of waiting up to a day (pre-#1025) or an hour (the tick
// fallback) — the push exists exactly for the OTHER caregiver (#858), who isn't
// looking at the logger's inline toast. A reading that crosses nothing never sends;
// it only clears the marker of a finding it ended (#6018). Everything else — the
// open-episode framing (a backfilled historical reading is never the episode's
// LATEST, and no open episode ⇒ no finding), the per-finding marker, the
// suppression bus, delivery accounting — is the SAME runTempRedFlag the tick runs,
// so the two paths can never disagree ("one question, one computation").
//
// QUIET-HOURS EXEMPT, deliberately (the REDOSE precedent, not the episode-nudge
// one): a 2 AM 106 °F reading is the overnight-emergency case, and the reading only
// exists because a caregiver is awake logging it. The tick path keeps its waking
// window; only this event-driven send skips it.
//
// Just after local midnight the reading door still accepts the day before, so a 23:50
// reading synced at 00:05 pushes. Ten minutes covers a sync a few minutes late and
// nothing a morning re-carry or a backfill reaches.
const MIDNIGHT_GRACE_MINUTES = 10;

export async function dispatchTempRedFlagForReading(
  profileId: number,
  degF: number
): Promise<{ failed: boolean }> {
  // Captured before any await, so the reading judges against the day it arrived.
  const date = today(profileId);
  const minuteOfDay = hhmmToMinutes(nowTime(profileId));
  // A normal reading sends nothing, but it may end a finding, and that finding's
  // marker must go now: a second crossing later the same day has the same key.
  if (!detectTempRedFlag(degF, profileAgeMonths(profileId, date))) {
    settleTempRedFlag(profileId, date);
    return { failed: false };
  }
  const staleBefore =
    minuteOfDay < MIDNIGHT_GRACE_MINUTES ? shiftDateStr(date, -1) : date;
  return assessTempRedFlagNow(profileId, { staleBefore, retryOwed: false });
}

// The same immediate assessment with NO reading in hand.
//
// WHY THIS EXISTS (#4712): the reading-keyed door above is gated on an OPEN EPISODE
// two layers down (`tempRedFlagFindingFor` → `openEpisodeAsOf` → null), and before
// #4712 nothing but the situation toggle could open one. So the first fever of the
// night — logged by a caregiver who has not performed that ceremony — reached
// `dispatchTempRedFlagForReading`, found no episode, derived no finding, and sent
// NOTHING, while the logger's own screen showed the red-flag toast. The other
// caregiver's phone stayed dark. The push was not broken; its precondition simply
// arrived after it.
//
// So the EPISODE OPENING is the second event that can make a finding true, and it
// re-asks the same question through the same orchestrator. There is no reading
// argument because the episode's own LATEST reading is the subject — the same one
// `detectEpisodeTempRedFlag` would judge on any other path.
//
// THE WINDOW IS THE EPISODE'S, NOT TODAY'S. `assembleIllnessEpisode` windows readings to
// `[episode.start, …]`; a reading logged before that start is not `latestTemp` and
// produces no finding. Since #5969 the symptom bar's door can open the row on the day
// the bar was showing, so the reading that walked the door is inside the window on
// whichever day it was logged for. What keeps that from pushing a day late is the
// refusal in `runTempRedFlag`: this door judges against the profile's today, so a
// finding from before it is not sent and gets no marker, and the hourly tick refuses it
// the same way.
//
// The per-finding marker and the suppression bus are unchanged, so this can no more
// double-send than the reading path can — the two share one orchestrator and one key.
export async function dispatchTempRedFlagForEpisodeOpen(
  profileId: number
): Promise<{ failed: boolean }> {
  return assessTempRedFlagNow(profileId, {
    staleBefore: today(profileId),
    retryOwed: false,
  });
}

// The shared tail of both event-driven doors: confirm the profile still exists, then
// hand the question to the ONE orchestrator the hourly tick also runs.
async function assessTempRedFlagNow(
  profileId: number,
  ask: TempRedFlagAsk
): Promise<{ failed: boolean }> {
  const profile = db
    .prepare("SELECT id FROM profiles WHERE id = ?")
    .get(profileId) as { id: number } | undefined;
  if (!profile) return { failed: false };
  return runTempRedFlag(profileId, today(profileId), ask);
}

// Fire-and-forget wrapper for request-path callers (the temperature Server Action,
// the Telegram temp log, the vitals ingest): never blocks or fails the write, and a
// send error lands in the persisted error log (#596) via createLogger, not the
// caller's response.
export function queueTempRedFlagDispatch(
  profileId: number,
  degF: number
): void {
  void dispatchTempRedFlagForReading(profileId, degF).catch((e) => {
    log.error("temp-red-flag write-path dispatch failed", {
      profile: profileId,
      err: e instanceof Error ? e : String(e),
    });
  });
}

// The same fire-and-forget wrapper for the episode-open door (#4712). Separate from
// its reading-keyed sibling only in which event it names in the error log, so a failed
// send says which door was walked.
export function queueTempRedFlagForEpisodeOpen(profileId: number): void {
  void dispatchTempRedFlagForEpisodeOpen(profileId).catch((e) => {
    log.error("temp-red-flag episode-open dispatch failed", {
      profile: profileId,
      err: e instanceof Error ? e : String(e),
    });
  });
}
