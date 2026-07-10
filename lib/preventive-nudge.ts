// Pure episode-dedup decision for the proactive preventive-care nudge (issue #87),
// mirroring the refill nudge's "once per low-supply EPISODE" semantics
// (lib/notifications/refill.ts). The DB gather + Telegram send lives in
// lib/notifications/preventive.ts; this file only DECIDES, given the currently
// due/overdue preventive items and the set of rule keys already nudged, which
// items to nudge now and which stale markers to clear. Kept here (not inline in
// the notifier) so the episode logic is unit-tested with no DB/network.
//
// Dedup semantics — "once per due EPISODE", not once per day:
//   - notify_last_preventive_<ruleKey> is set once a nudge goes out and suppresses
//     further nudges while the item STAYS due/overdue.
//   - The marker is CLEARED the moment the item is no longer actionable (satisfied,
//     overridden, or aged out of the window), so when the NEXT interval comes due a
//     fresh nudge fires. Without this the marker would silence the rule forever.

// One due/overdue preventive item the nudge can announce. Derived from the pure
// assessor's actionable slice (lib/preventive-status.ts): `ruleKey` is the catalog
// key, used both for the message and as the per-item dedup marker suffix.
export interface PreventiveNudgeItem {
  ruleKey: string;
  name: string;
  status: "due" | "overdue";
  detail: string | null;
}

export interface PreventiveNudgePlan {
  // Items to nudge now (actionable AND not already marked) — the notifier sends
  // these and sets their markers on a successful delivery.
  toSend: PreventiveNudgeItem[];
  // Rule keys whose marker should be deleted: a previously-nudged rule that is no
  // longer actionable, so its episode has ended and a future due can re-fire.
  toClear: string[];
}

// Decide the nudge plan from the actionable items and the currently-set markers.
// Pure: `markedRuleKeys` is the set of rule keys that already have a
// notify_last_preventive_<ruleKey> marker. `toClear` is sorted for deterministic
// output (delete order is irrelevant, but stable output keeps tests simple).
export function planPreventiveNudges(
  actionable: readonly PreventiveNudgeItem[],
  markedRuleKeys: Iterable<string>
): PreventiveNudgePlan {
  const marked = new Set(markedRuleKeys);
  const actionableKeys = new Set(actionable.map((a) => a.ruleKey));
  const toSend = actionable.filter((a) => !marked.has(a.ruleKey));
  const toClear = [...marked].filter((k) => !actionableKeys.has(k)).sort();
  return { toSend, toClear };
}
