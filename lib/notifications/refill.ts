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
//     the threshold, or quantity tracking turned off), so the next time it runs
//     low a fresh nudge fires. Without this the marker would silence it forever.

import { getSupplements, getRefillRates } from "../queries";
import {
  daysOfSupplyLeft,
  isLowSupply,
  DEFAULT_LOW_SUPPLY_DAYS,
} from "../refill";
import {
  getProfileSetting,
  setProfileSetting,
  deleteProfileSetting,
} from "../settings";
import { dispatch } from "./index";
import type { NotificationMessage } from "./types";
import { createLogger } from "../log";

const log = createLogger("notify");

const refillKey = (supplementId: number) =>
  `notify_last_refill_${supplementId}`;

interface LowItem {
  id: number;
  name: string;
  daysLeft: number;
}

// The refill nudge. Names the profile (a shared/caregiver chat may carry several
// profiles) and lists each low item with its remaining days. A nudge,
// so no action button.
export function renderRefillMessage(
  profileName: string,
  items: LowItem[]
): NotificationMessage {
  const who = profileName ? `${profileName} — ` : "";
  const head =
    items.length === 1 ? items[0].name : `${items.length} items running low`;
  const lines = items.map(
    (it) =>
      `• ${it.name}: ≈${it.daysLeft} day${it.daysLeft === 1 ? "" : "s"} left`
  );
  return {
    title: `🔄 Refill due: ${who}${head}`,
    body: `Running low on supply — time to reorder:\n${lines.join("\n")}`,
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

  const toSend: LowItem[] = [];
  for (const s of tracked) {
    const daysLeft = daysOfSupplyLeft(
      s.quantity_on_hand,
      s.qty_per_dose,
      rates.get(s.id)?.dosesPerDay ?? 0
    );
    const low = isLowSupply(daysLeft, DEFAULT_LOW_SUPPLY_DAYS);
    const marked = !!getProfileSetting(profileId, refillKey(s.id));
    if (low && daysLeft != null) {
      if (!marked) toSend.push({ id: s.id, name: s.name, daysLeft });
    } else if (marked) {
      // Recovered (refilled, or no longer estimable) — end the episode so a
      // future low run can nudge again.
      deleteProfileSetting(profileId, refillKey(s.id));
    }
  }
  if (toSend.length === 0) return { failed: false };

  const results = await dispatch(
    profileId,
    renderRefillMessage(profileName, toSend)
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
      setProfileSetting(profileId, refillKey(it.id), date);
      log.info("refill nudge sent", {
        profile: profileId,
        supp: it.name,
        daysLeft: it.daysLeft,
      });
    }
  }
  return { failed };
}
