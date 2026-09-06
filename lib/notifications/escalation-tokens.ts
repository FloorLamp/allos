// THE ESCALATION TOKEN FAMILY (issue #2961 step 2) — `esctake:` / `escskip:` /
// `escack:`. Carved off `callback-data.ts` verbatim. The one import is the pure date
// predicate the dose tokens also use; the chat-authorization rule
// (`resolveEscalationTap`) and the answer texts stay with the handler until step 3.

import { isRealIsoDate } from "../date";

// ---- Phase 2: escalation buttons (issue #233) ----
// ✅ Confirmed taken → markDoseTaken (its DoseTakenOutcome answers honestly);
// 👍 I'm on it → an ack that suppresses re-nudge WITHOUT claiming the dose taken.
// The token mirrors a dose tap's shape (profile/dose/item/date) under distinct
// "esctake"/"escack" prefixes.

// ⏭️ Skip joins the two original affordances (#1716): a skip is a RECORDED DELIBERATE
// DECISION, distinct from silence, and skipped doses already end the escalation loop.
export type EscalationAction = "take" | "ack" | "skip";

export interface EscalationCallback {
  profileId: number;
  doseId: number;
  itemId: number | null;
  date: string;
  action: EscalationAction;
}

// Parse an "esctake:…" / "escskip:…" / "escack:…" token (same field layout as a dose
// token). Malformed (wrong prefix, bad ids, missing or non-date date — #3120) → null.
//
// THE DATE IS NOT ONLY A WRITE KEY HERE. An `escack:` PERSISTS its date as the
// escalation's acknowledgement marker, and lib/notifications/escalate.ts compares that
// marker to the dose's day by EQUALITY — so a token carrying a non-date once stored a
// garbage marker that could never match, silently voiding the acknowledgement while the
// caregiver was told "we'll hold off" and the escalation kept re-firing.
export function parseEscalationCallback(
  data: unknown
): EscalationCallback | null {
  if (typeof data !== "string") return null;
  let action: EscalationAction;
  if (data.startsWith("esctake:")) action = "take";
  else if (data.startsWith("escskip:")) action = "skip";
  else if (data.startsWith("escack:")) action = "ack";
  else return null;
  const [, profStr, doseStr, itemStr, date] = data.split(":");
  const profileId = Number(profStr);
  const doseId = Number(doseStr);
  if (!profileId || !doseId || !isRealIsoDate(date)) return null;
  return {
    profileId,
    doseId,
    itemId: Number(itemStr) || null,
    date,
    action,
  };
}
