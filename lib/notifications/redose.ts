// PRN redose-notice orchestration (issue #798). For each opted-in PRN medication with
// CONFIRMED interval/max fields, decide (via the pure redoseNoticeDecision) whether the
// one-shot redose window has just opened, and if so send a notice carrying a "Log
// dose" button, then stamp the per-item one-shot marker with the arming administration
// id. Called once per hour from the notify tick.
//
// SAFETY-TIER, NEVER BUS-GATED (issue #798, matching #435's dose-reminder policy). A
// redose notice is a medication-safety signal armed by an actual administration and
// opted in per item — a page dismissal must never silence it — so, exactly like the
// scheduled dose reminder and missed-dose escalation (#227), it does NOT consult the
// findings-suppression bus. It is NOT a coaching/care finding on the shared bus; the
// over-max *care finding* (a separate Upcoming generator) is the bus-riding half.
//
// QUIET-HOURS EXCEPTION (deliberate, documented in docs/internals/notifications.md).
// Unlike the episode nudges (refill/preventive/milestone), this is called
// UNCONDITIONALLY every tick — it is NOT gated by inWakingWindow. A notice due at 3am
// is exactly the overnight fever case, and it can only fire from a real administration
// the user logged, so nighttime delivery is the feature working, not spam.
//
// Delivery goes through dispatch() (all configured channels), so the global
// notify_last_error marker folds like any other send and Web Push mirrors the
// content-safe body (the "Log dose" button is Telegram-only; push drops actions but
// the body carries the real content, so redose is push-deliverable, #692). The
// per-item one-shot marker is stamped only when at least one channel DELIVERED, so a
// total delivery failure re-fires next tick.

import crypto from "node:crypto";
import { dispatch } from "./index";
import {
  getRedoseNoticeItems,
  getRedoseArmingState,
  getMedicationFamilyStates,
} from "../queries";
import { redoseNoticeDecision } from "../prn-redose";
import { redoseNoticeMessage } from "../redose-format";
import { formatGivenAtClock } from "../administration-format";
import { getProfileSetting, setProfileSetting, getTimezone } from "../settings";
import { parseUtcSql } from "../date";
import { now as clockNow } from "../clock";
import { createLogger } from "../log";
import type { NotificationAction } from "./types";

const log = createLogger("notify");

// The per-item one-shot dedup marker: notify_last_redose_<itemId>, holding the id of
// the administration the notice last fired for. Equal to the latest administration ⇒
// already notified (one-shot); a newer administration re-arms it. Pure key so a delete
// seam could sweep it (ids never recycle, so a stale marker is a harmless dead row).
export function redoseMarkerKey(itemId: number): string {
  return `notify_last_redose_${itemId}`;
}

// A per-render nonce for the "Log dose" callback token — mirrors the /dose command's
// dedup token (the real double-log guard is logAdministration's short-window dedup).
function prnLogToken(): string {
  return crypto.randomBytes(4).toString("hex");
}

// Send any due PRN redose notices for one profile. Returns whether a send failed (so
// the tick can aggregate into its exit code). Never throws for an ordinary send
// failure. `now` is the tick's instant (injectable for tests); interval elapsed is a
// pure duration, while the day count/max reset in the profile's timezone (date).
export async function runRedoseNotices(
  profileId: number,
  _profileName: string,
  date: string,
  now: Date = clockNow()
): Promise<{ failed: boolean }> {
  const items = getRedoseNoticeItems(profileId);
  if (items.length === 0) return { failed: false };
  const tz = getTimezone(profileId);
  // The #1027 ingredient-family state: the interval clock is armed by the FAMILY's
  // latest administration (an OTC ibuprofen dose holds the Rx item's notice until
  // the interval clears from THAT dose), the count totals the family's
  // administrations, and the max is the most conservative confirmed max among
  // members. The per-item one-shot marker semantics are unchanged — the notice
  // still belongs to this item, keyed by the arming administration id (a sibling's
  // id works identically: ids are ledger-global and never recycle).
  const families = getMedicationFamilyStates(profileId, date);

  let failed = false;
  for (const item of items) {
    const fam = families.get(item.id);
    const arming = fam ?? {
      // A notice item is always an active med, so it's always in the family map;
      // this per-item fallback only guards a race with a just-paused item.
      ...getRedoseArmingState(profileId, item.id, date),
      latestItemId: null as number | null,
      latestItemName: null as string | null,
      minConfirmedMax: null as number | null,
    };
    const markerRaw = getProfileSetting(profileId, redoseMarkerKey(item.id));
    const notifiedAdministrationId = markerRaw
      ? Number(markerRaw) || null
      : null;

    const effectiveMax =
      arming.minConfirmedMax != null
        ? Math.min(item.maxDailyCount, arming.minConfirmedMax)
        : item.maxDailyCount;
    const decision = redoseNoticeDecision({
      minIntervalHours: item.minIntervalHours,
      maxDailyCount: effectiveMax,
      latestAdministrationId: arming.latestId,
      latestGivenAt: parseUtcSql(arming.latestGivenAt),
      countToday: arming.countToday,
      now,
      notifiedAdministrationId,
    });
    if (decision.kind !== "fire") continue;

    const msg = redoseNoticeMessage({
      name: item.name,
      sinceHours: decision.sinceHours,
      lastClock: formatGivenAtClock(tz, arming.latestGivenAt),
      countToday: decision.countToday,
      maxDailyCount: decision.maxDailyCount,
      // When a same-ingredient SIBLING's dose armed the clock (#1027), the body
      // names it — "8h since Ibuprofen OTC" — instead of implying this item.
      sinceName:
        arming.latestItemId != null && arming.latestItemId !== item.id
          ? arming.latestItemName
          : null,
    });
    // The "Log dose" button reuses the /dose PRN callback (prn:<profileId>:<itemId>:
    // <nonce>) → handlePrnLogTap → logAdministration through the ONE chokepoint. NOT
    // idempotent (multiple/day is the point); the handler answers from the typed
    // AdministrationOutcome and the nonce is the dedup token.
    const actions: NotificationAction[] = [
      {
        label: `💊 Log dose`,
        data: `prn:${profileId}:${item.id}:${prnLogToken()}`,
      },
    ];

    const results = await dispatch(profileId, {
      title: msg.title,
      body: msg.body,
      actions,
      kind: "redose",
    });
    if (results.length === 0) {
      // No channel configured for this profile — leave the marker unset so it retries.
      continue;
    }
    const delivered = results.some((r) => r.ok);
    if (results.some((r) => !r.ok)) failed = true;
    // Stamp the one-shot marker only on a delivered notice (so a total failure re-
    // fires next tick). Keyed by the arming administration id: a NEWER administration
    // re-arms; the same administration never re-fires.
    if (delivered) {
      setProfileSetting(
        profileId,
        redoseMarkerKey(item.id),
        String(decision.administrationId)
      );
      log.info("redose notice sent", {
        profile: profileId,
        item: item.id,
        administration: decision.administrationId,
      });
    }
  }
  return { failed };
}
