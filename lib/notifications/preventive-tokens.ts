// THE PREVENTIVE-NUDGE TOKEN FAMILY (issue #2961 step 2) — `pvdone:` / `pvna:` /
// `pvlater:`. Carved off `callback-data.ts` verbatim; no imports. The answer and closing
// texts stay beside the handler's outcome type until step 3 moves the handler.

// ---- Phase 1: preventive-nudge buttons (issue #233) ----
// ✅ Done → recordPreventiveDone; 🚫 Not applicable → setPreventiveOverride;
// ⏰ Remind later → findings-bus snooze (#227). The token carries the profile id
// (cross-checked against the chat like a dose tap) and the catalog RULE KEY — a
// stable machine key, never a name, and never recycled — so it fits Telegram's
// 64-byte limit and the handler re-derives the rule's kind from the catalog.

export type PreventiveAction = "done" | "na" | "later";

export interface PreventiveCallback {
  profileId: number;
  ruleKey: string;
  action: PreventiveAction;
}

// Parse a "pv<done|na|later>:<profileId>:<ruleKey>" token. Rule keys are the
// catalog's stable snake_case identifiers (no colons), so the greedy tail is the
// whole key. The handler still validates it against the catalog. Malformed →
// null.
export function parsePreventiveCallback(
  data: unknown
): PreventiveCallback | null {
  if (typeof data !== "string") return null;
  const m = /^pv(done|na|later):(\d+):(.+)$/.exec(data);
  if (!m) return null;
  const profileId = Number(m[2]);
  const ruleKey = m[3];
  if (!profileId || !ruleKey) return null;
  const action: PreventiveAction =
    m[1] === "done" ? "done" : m[1] === "na" ? "na" : "later";
  return { profileId, ruleKey, action };
}
