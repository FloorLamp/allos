// The GATHERING and DISPATCH half of the practice finish message (#4775 §3). The copy
// and the gate are pure and live in ./practice-recap; nothing here re-decides them.
//
// The tick calls `runPracticeRecaps` once a pass. It costs ONE bounded, indexed query
// on a profile with no recently-finished practice, which is nearly every pass — the
// physiology reads happen only for a row that is actually inside the bound and has not
// already been announced.
//
// SEND-MARKER DISCIPLINE. `notify_last_practice_recap_<practice_log id>`, id-keyed and
// one-shot (ids never recycle, #203). It is stamped ONLY on delivery, so a row that
// aged out of the bound without ever gaining coverage leaves it unset — the marker
// records a send that happened, and there was none.

import { db, today as profileToday } from "../db";
import { now as clockNow } from "../clock";
import { getProfileSetting, setProfileSetting, getTimezone } from "../settings";
import { zonedMinuteStr, shiftDateStr } from "../date";
import { getPracticeSpellings } from "../queries/wellness";
import {
  getWindowPhysiology,
  restingReferenceBpm,
} from "../queries/event-physiology";
import {
  localMinutesBetween,
  practiceEffectBpm,
  USUAL_RECENT_EVENTS,
} from "../event-physiology";
import { activityWindow, type ActivityWindow } from "../training-zones";
import {
  practiceRecapBody,
  practiceRecapFacts,
  practiceRecapMarkerKey,
  practiceRecapTitle,
  PRACTICE_RECAP_BOUND_MIN,
} from "./practice-recap";
import type { NotificationMessage } from "./types";

interface PracticeRow {
  id: number;
  practice: string;
  date: string;
  start_time: string | null;
  end_time: string | null;
  duration_min: number | null;
  derived_window: number;
}

/**
 * The finished practice rows whose window ended inside the bound.
 *
 * Two profile-local days are read because a window can end after midnight — an evening
 * sauna that runs to 00:10 belongs to the day it STARTED on (#3143), so today's date
 * alone would miss it for the two hours it is eligible.
 */
function recentlyFinishedPractices(
  profileId: number,
  nowLocal: string
): { row: PracticeRow; window: ActivityWindow }[] {
  const todayStr = profileToday(profileId);
  const rows = db
    .prepare(
      `SELECT id, practice, date, start_time, end_time, duration_min, derived_window
         FROM practice_logs
        WHERE profile_id = ? AND live = 0 AND start_time IS NOT NULL
          AND date >= ?
        ORDER BY id DESC`
    )
    .all(profileId, shiftDateStr(todayStr, -1)) as PracticeRow[];
  const out: { row: PracticeRow; window: ActivityWindow }[] = [];
  for (const row of rows) {
    const window = activityWindow(row);
    if (!window) continue;
    const since = localMinutesBetween(window.end, nowLocal);
    // Half-open at both ends on purpose: a window that has not finished yet is not a
    // finish, and one past the bound has stopped being news.
    if (since < 0 || since > PRACTICE_RECAP_BOUND_MIN) continue;
    out.push({ row, window });
  }
  return out;
}

/**
 * This practice's own prior windowed sessions, newest first and capped — the events a
 * "usual" is averaged over. Same practice means same SPELLING FAMILY (#1259's grouping),
 * never a raw string match, so "Sauna" and "sauna" are one practice here exactly as
 * they are everywhere else.
 */
function priorSessions(
  profileId: number,
  practice: string,
  beforeId: number
): PracticeRow[] {
  const spellings = getPracticeSpellings(profileId, practice);
  if (spellings.length === 0) return [];
  return db
    .prepare(
      `SELECT id, practice, date, start_time, end_time, duration_min, derived_window
         FROM practice_logs
        WHERE profile_id = ? AND live = 0 AND start_time IS NOT NULL
          AND id < ? AND practice IN (${spellings.map(() => "?").join(", ")})
        ORDER BY id DESC
        LIMIT ?`
    )
    .all(
      profileId,
      beforeId,
      ...spellings,
      USUAL_RECENT_EVENTS
    ) as PracticeRow[];
}

/**
 * The message for one finished practice row, or null when the send must not happen —
 * the row is uncovered, unmeasured, or the profile has no resting reference. See
 * ./practice-recap's header for why "no physiology" means "no message" here and not
 * "a shorter message".
 */
export function buildPracticeRecap(
  profileId: number,
  row: PracticeRow,
  window: ActivityWindow,
  at: Date
): NotificationMessage | null {
  const reference = restingReferenceBpm(profileId);
  const facts = practiceRecapFacts({
    practice: row.practice,
    physiology: getWindowPhysiology(profileId, window, at),
    derivedWindow: row.derived_window === 1,
    restingReferenceBpm: reference,
    priorEffectsBpm: priorSessions(profileId, row.practice, row.id).flatMap(
      (prior) => {
        const priorWindow = activityWindow(prior);
        if (!priorWindow) return [];
        const effect = practiceEffectBpm(
          getWindowPhysiology(profileId, priorWindow, at),
          reference
        );
        return effect != null ? [effect] : [];
      }
    ),
  });
  if (!facts) return null;
  return {
    title: practiceRecapTitle(),
    body: practiceRecapBody(facts),
    kind: "practice-recap",
  };
}

/**
 * Send the finish message for every practice row that has just become sayable.
 *
 * `send` is the tick's own chokepoint, passed in rather than imported so this module
 * carries no delivery knowledge and the tick keeps owning the channel matrix and the
 * delivery accounting.
 */
export async function runPracticeRecaps(
  profileId: number,
  send: (msg: NotificationMessage) => Promise<{
    delivered: boolean;
    failed: boolean;
  }>,
  at: Date = clockNow()
): Promise<{ sent: number; failed: boolean }> {
  const nowLocal = zonedMinuteStr(getTimezone(profileId), at);
  let sent = 0;
  let failed = false;
  for (const { row, window } of recentlyFinishedPractices(profileId, nowLocal)) {
    const markerKey = practiceRecapMarkerKey(row.id);
    if (getProfileSetting(profileId, markerKey) != null) continue;
    const msg = buildPracticeRecap(profileId, row, window, at);
    if (!msg) continue; // no physiology, no send, and the marker stays unset
    const result = await send(msg);
    if (result.failed) failed = true;
    if (result.delivered) {
      setProfileSetting(profileId, markerKey, row.date);
      sent += 1;
    }
  }
  return { sent, failed };
}
