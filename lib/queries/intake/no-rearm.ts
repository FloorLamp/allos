// Part of the lib/queries/intake barrel (#319), split out of adherence.ts under
// #2960. NOT re-exported through the adherence facade: this was never public and
// stays internal to lib/queries/intake.
//
// One rule, shared by the two write modules that can un-mark a dose — the historical
// edit (which may move a row onto a different date) and the undoable delete. It lives
// on its own so neither of them owns it, and so a third un-marking write cannot ship
// without meeting it.
import { setProfileSetting } from "../../settings";
import { escalationMarkerKey } from "../../notifications/escalation-keys";

// ---- The no-rearm rule (#1933 × #328 × the attention doctrine) --------------
//
// A historical write may UN-MARK a dose for a day: deleting its taken ledger row, or
// moving that row onto a different date. The dose then reads unconfirmed for the day
// it left behind — and the hourly missed-dose escalation would be free to chase it.
//
// That is the one thing a history correction must never do. The attention doctrine's
// contact-consent rule is asymmetric: the system may reduce contact unilaterally, but
// it may never INCREASE it off its own reading of state. Un-marking yesterday's (or
// this morning's) dose is a bookkeeping correction, not a request to be chased.
//
// So every un-marking write stamps the dose's date-keyed escalation marker (#328) for
// the day it vacated, exactly as a real escalation or a caregiver's "👍 I'm on it" ack
// would. The tick's `escalatedDoseIds` check then treats that day as already handled
// and fires nothing. The marker only ever suppresses, and only for the ONE date it
// names, so a genuine miss on any other day still escalates normally.
//
// The inverse write (restoreAdministrationLog) deliberately does NOT clear the marker:
// the restored row re-confirms the dose anyway, and clearing would be the system
// re-arming contact — the direction the rule forbids.
export function suppressEscalationRearm(
  profileId: number,
  doseId: number,
  date: string
): void {
  setProfileSetting(profileId, escalationMarkerKey(doseId), date);
}
