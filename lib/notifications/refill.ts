// Low-supply refill nudge. Once per hour per profile, checks
// every tracked (quantity_on_hand set) active item's remaining days of supply and,
// when one drops to/below the refill threshold, sends a single "refill due" nudge
// over the profile's own channel. The days-of-supply arithmetic is the pure
// lib/refill; this file is the DB gather + dedup + send, mirroring ./escalate.
//
// Dedup semantics — "once per low-supply EPISODE", not once per day:
//   - notify_last_refill_<supplementId> is set (to the send date) once a nudge
//     goes out, and suppresses further nudges while the item stays low.
//   - The marker is CLEARED the moment the item is no longer low (refilled above
//     the threshold, or quantity tracking turned off / the item paused), so the next
//     time it runs low a fresh nudge fires. Without this the marker would silence it
//     forever. The clear is self-healing: markedIds is the FULL set of live markers
//     (not just the current candidates), so planRefillNudges sweeps a marker whose
//     item has left the tracked set entirely (issue #325).

import { getSupplements, getRefillRates } from "../queries";
import { getFindingSuppressions } from "../queries/upcoming";
import {
  daysOfSupplyLeft,
  isLowSupply,
  DEFAULT_LOW_SUPPLY_DAYS,
} from "../refill";
import {
  planRefillNudges,
  refillSignalKey,
  refillMarkerKey,
  refillIdFromMarker,
  REFILL_MARKER_PREFIX,
  type RefillCandidate,
} from "../refill-nudge";
import { isSuppressed } from "../upcoming-suppress";
import {
  setProfileSetting,
  deleteProfileSetting,
  getProfileSettingKeysWithPrefix,
  getPublicUrl,
} from "../settings";
import { dispatch } from "./index";
import type { NotificationAction, NotificationMessage } from "./types";
import { createLogger } from "../log";

const log = createLogger("notify");

interface LowItem {
  id: number;
  name: string;
  daysLeft: number;
}

// The refill nudge. Names the profile (a shared/caregiver chat may carry several
// profiles) and lists each low item with its remaining days. Each item gets a
// "📦 Ordered — remind me in 3 days" button (issue #233) that snoozes its
// `refill:<id>` finding on the shared bus (#227), plus — when a public URL is
// configured — a deep link to the refill form (a real "mark refilled" needs an
// amount, which a button handles badly, so the form is the actuator). One row per
// item so a snooze consumes just that item.
export function renderRefillMessage(
  profileName: string,
  items: LowItem[],
  profileId: number,
  deepLinkBase = ""
): NotificationMessage {
  const who = profileName ? `${profileName} — ` : "";
  const head =
    items.length === 1 ? items[0].name : `${items.length} items running low`;
  const lines = items.map(
    (it) =>
      `• ${it.name}: ≈${it.daysLeft} day${it.daysLeft === 1 ? "" : "s"} left`
  );
  const base = deepLinkBase.replace(/\/$/, "");
  const actions: NotificationAction[] = items.flatMap((it) => {
    const row = `rf:${it.id}`;
    const perItem: NotificationAction[] = [
      {
        label: "📦 Ordered — remind me in 3 days",
        data: `rfsnooze:${profileId}:${it.id}`,
        row,
      },
    ];
    if (base) {
      perItem.push({ label: "Open refill form", url: `${base}/medicine`, row });
    }
    return perItem;
  });
  return {
    title: `🔄 Refill due: ${who}${head}`,
    body: `Running low on supply — time to reorder:\n${lines.join("\n")}`,
    actions,
    kind: "refill",
  };
}

// Send any due low-supply nudges for one profile. Returns whether a send failed
// (aggregated into the tick's exit code). Never throws for an ordinary send
// failure. `date` is the profile-local date, used as the dedup marker value.
export async function runRefills(
  profileId: number,
  profileName: string,
  date: string
): Promise<{ failed: boolean }> {
  // Only active items that opted into quantity tracking.
  const tracked = getSupplements(profileId).filter(
    (s) => s.active && s.quantity_on_hand != null
  );
  if (tracked.length === 0) return { failed: false };

  // doses/day comes from the shared getRefillRates: the ACTUAL taken-log rate
  // (confirmed doses over the trailing window) once the item has enough history,
  // else the scheduled-dose-count estimate. A workout-only / situational
  // supplement no longer reads as daily, so the nudge stops firing weeks early.
  const rates = getRefillRates(profileId);

  const candidates: RefillCandidate[] = tracked.map((s) => {
    const daysLeft = daysOfSupplyLeft(
      s.quantity_on_hand,
      s.qty_per_dose,
      rates.get(s.id)?.dosesPerDay ?? 0
    );
    return {
      id: s.id,
      name: s.name,
      daysLeft,
      low: isLowSupply(daysLeft, DEFAULT_LOW_SUPPLY_DAYS),
    };
  });

  // Route the nudge through the shared findings-suppression bus (#227): a refill
  // dismissed/snoozed on the Upcoming page (keyed by the identical `refill:<id>`
  // signal) is held out of the push too. `date` is the profile-local today.
  const suppressions = getFindingSuppressions(profileId);
  // The FULL set of live episode markers — NOT just the ids among `candidates` — so a
  // marker whose item has left the tracked set (paused / quantity tracking turned off)
  // still reaches planRefillNudges' self-healing clear (issue #325). Mirrors the
  // preventive nudge's getProfileSettingKeysWithPrefix read.
  const markedIds = getProfileSettingKeysWithPrefix(
    profileId,
    REFILL_MARKER_PREFIX
  )
    .map(refillIdFromMarker)
    .filter((id) => Number.isInteger(id) && id > 0);
  const suppressedIds = candidates
    .filter((c) => {
      const rec = suppressions.get(refillSignalKey(c.id));
      return rec != null && isSuppressed(rec, date);
    })
    .map((c) => c.id);

  const { toSend, toClear } = planRefillNudges(
    candidates,
    markedIds,
    suppressedIds
  );

  // End any recovered/untracked episodes first — cheap, and never depends on a send.
  for (const id of toClear)
    deleteProfileSetting(profileId, refillMarkerKey(id));

  if (toSend.length === 0) return { failed: false };

  const results = await dispatch(
    profileId,
    renderRefillMessage(profileName, toSend, profileId, getPublicUrl())
  );
  if (results.length === 0) {
    // No channel configured — leave markers unset so it can send once configured.
    log.info("refill nudge skipped: no channel", { profile: profileId });
    return { failed: false };
  }
  const delivered = results.some((r) => r.ok);
  const failed = results.some((r) => !r.ok);
  if (delivered) {
    for (const it of toSend) {
      setProfileSetting(profileId, refillMarkerKey(it.id), date);
      log.info("refill nudge sent", {
        profile: profileId,
        supp: it.name,
        daysLeft: it.daysLeft,
      });
    }
  }
  return { failed };
}
