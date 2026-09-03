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
import { tempRedFlagFullDetail } from "../temp-red-flag";
import { detectTempRedFlag } from "../datasets/temperature-red-flags";
import { planIllnessCareNudges } from "../illness-care";
import { getFindingSuppressions } from "../queries/upcoming";
import { isSuppressed } from "../upcoming-suppress";
import {
  setProfileSetting,
  deleteProfileSetting,
  getProfileSettingKeysWithPrefix,
  getPublicUrl,
  profileAgeMonths,
} from "../settings";
import { db, today } from "../db";
import { episodeHref } from "../hrefs";
import { dispatch } from "./index";
import type { NotificationAction, NotificationMessage } from "./types";
import { createLogger } from "../log";
import { GLYPH } from "./glyphs";

const log = createLogger("notify");

const MARKER_PREFIX = "notify_last_tempredflag_";
const markerKey = (dedupeKey: string) => `${MARKER_PREFIX}${dedupeKey}`;
const dedupeKeyFromMarker = (key: string) => key.slice(MARKER_PREFIX.length);

// Render the nudge from the fact, cited line, and source. A "View episode" deep-link is the
// only affordance (nothing idempotent to toggle), following the two-way principle.
export function renderTempRedFlagMessage(
  profileName: string,
  title: string,
  body: string,
  episodeId: number | null,
  deepLinkBase = ""
): NotificationMessage {
  const who = profileName ? `${profileName} — ` : "";
  const base = deepLinkBase.replace(/\/$/, "");
  const actions: NotificationAction[] =
    base && episodeId != null
      ? [{ label: "View episode", url: `${base}${episodeHref(episodeId)}` }]
      : [];
  return {
    title: `${GLYPH.temperature} Fever check: ${who}${title}`,
    body,
    actions,
    kind: "illness-care",
  };
}

// Send the temperature red-flag nudge for one profile when a NEW crossing comes due.
// Returns whether a send failed. `date` is the profile-local date (the dedup value).
export async function runTempRedFlag(
  profileId: number,
  profileName: string,
  date: string
): Promise<{ failed: boolean }> {
  // "dual" display (#1019): the nudge has no login-unit context (prefs are
  // per-login, notifications per-profile), and a mixed-preference household must
  // read a fever red-flag correctly either way — so the safety message carries
  // BOTH scales ("38.5 °C / 101.3 °F"). The dedupeKey is display-independent, so
  // the bus gating below still matches the web surfaces' keys exactly.
  const finding = tempRedFlagFindingFor(profileId, date, "dual");
  const actionableKeys = finding ? [finding.dedupeKey] : [];

  // Route through the shared findings-suppression bus (#227).
  const suppressions = getFindingSuppressions(profileId);
  const suppressedKeys = finding
    ? actionableKeys.filter((k) => {
        const rec = suppressions.get(k);
        return rec != null && isSuppressed(rec, date);
      })
    : [];

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

  if (toSend.length === 0 || !finding) return { failed: false };

  const base = getPublicUrl();
  const episodeId = episodeForProfileDate(profileId, date)?.id ?? null;
  const results = await dispatch(
    profileId,
    renderTempRedFlagMessage(
      profileName,
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
    log.info("temp-red-flag nudge sent", {
      profile: profileId,
      key: finding.dedupeKey,
    });
  }
  return { failed };
}

// Event-driven dispatch at the temperature WRITE path (#1025 ask 2): after a
// successful reading write whose value crosses a red-flag line, evaluate + send
// immediately instead of waiting up to a day (pre-#1025) or an hour (the tick
// fallback) — the push exists exactly for the OTHER caregiver (#858), who isn't
// looking at the logger's inline toast. The cheap pre-check (one dataset lookup)
// keeps the ordinary-reading write path free of any notification work; everything
// else — the open-episode framing (a backfilled historical reading is never the
// episode's LATEST, and no open episode ⇒ no finding), the per-finding marker, the
// suppression bus, delivery accounting — is the SAME runTempRedFlag the tick runs,
// so the two paths can never disagree ("one question, one computation").
//
// QUIET-HOURS EXEMPT, deliberately (the REDOSE precedent, not the episode-nudge
// one): a 2 AM 106 °F reading is the overnight-emergency case, and the reading only
// exists because a caregiver is awake logging it. The tick path keeps its waking
// window; only this event-driven send skips it.
export async function dispatchTempRedFlagForReading(
  profileId: number,
  degF: number
): Promise<{ failed: boolean }> {
  const date = today(profileId);
  if (!detectTempRedFlag(degF, profileAgeMonths(profileId, date))) {
    return { failed: false };
  }
  return assessTempRedFlagNow(profileId);
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
// IT CANNOT REACH BACK PAST THE EPISODE. `assembleIllnessEpisode` windows readings to
// `[episode.start, …]`, and `syncOpenIllnessEpisode` opens a row starting on the
// profile-local day of the toggle — so opening an episode today can only ever surface
// a reading taken today. A fever from three days ago is outside the window, is not
// `latestTemp`, and produces no finding: this door cannot resurrect a stale crossing.
//
// The per-finding marker and the suppression bus are unchanged, so this can no more
// double-send than the reading path can — the two share one orchestrator and one key.
export async function dispatchTempRedFlagForEpisodeOpen(
  profileId: number
): Promise<{ failed: boolean }> {
  return assessTempRedFlagNow(profileId);
}

// The shared tail of both event-driven doors: resolve the profile's name and day, then
// hand the question to the ONE orchestrator the hourly tick also runs.
async function assessTempRedFlagNow(
  profileId: number
): Promise<{ failed: boolean }> {
  const profile = db
    .prepare("SELECT name FROM profiles WHERE id = ?")
    .get(profileId) as { name: string } | undefined;
  if (!profile) return { failed: false };
  return runTempRedFlag(profileId, profile.name, today(profileId));
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
