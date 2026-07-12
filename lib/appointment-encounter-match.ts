// Pure, DB-free matcher for the import auto-complete (issue #288): when an
// import/sync lands an encounter, does it correspond to a still-scheduled
// appointment the user booked ahead of the visit? If so the persist layer marks
// that appointment completed and links it, closing the preventive loop with zero
// manual steps (screening due → book → visit happens → portal sync → appointment
// completed → rule satisfied).
//
// CONSERVATIVE BY DESIGN — a wrong auto-complete silently retires a real, still-
// upcoming appointment, so the bar for a match is high:
//   - same profile (the query layer scopes the candidate list);
//   - same calendar day (the encounter's date == the appointment's scheduled day);
//   - same provider_id — and a null provider on EITHER side is never a match (no
//     provider = no evidence the two are the same visit);
//   - the appointment is still 'scheduled' and not already linked;
//   - exactly one candidate wins. Two candidates on the same day + provider are
//     disambiguated ONLY by a clear nearest-time signal; a tie (or missing times,
//     so no signal) yields NO auto-match — the ambiguity is left for the human.
//
// The query/persist layer maps its rows into these minimal shapes and applies the
// returned id; everything here is pure and unit-tested.

export interface MatchEncounter {
  // "YYYY-MM-DD" or "YYYY-MM-DD HH:MM". Only the date is required to match; a time,
  // when present, is used solely to break a multi-candidate tie.
  date: string;
  providerId: number | null;
}

export interface MatchAppointment {
  id: number;
  // "YYYY-MM-DD" or "YYYY-MM-DD HH:MM".
  scheduledAt: string;
  providerId: number | null;
  status: string;
  // The appointment's existing encounter link; a non-null value means it's already
  // been logged/matched and is never re-matched.
  encounterId: number | null;
}

// The calendar day (first 10 chars) of a date-or-datetime string.
function dayOf(s: string): string {
  return s.slice(0, 10);
}

// Minutes-since-midnight for a "YYYY-MM-DD HH:MM"-shaped string, or null when the
// string carries no parseable HH:MM time component (a date-only value).
function minuteOfDay(s: string): number | null {
  const m = /^\d{4}-\d{2}-\d{2}[ T](\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// The id of the single appointment this encounter confidently completes, or null
// when there's no confident match. See the module header for the match rules.
export function matchAppointmentForEncounter(
  encounter: MatchEncounter,
  appointments: MatchAppointment[]
): number | null {
  // No provider on the encounter → no evidence to match on.
  if (encounter.providerId == null) return null;

  const encDay = dayOf(encounter.date);
  const candidates = appointments.filter(
    (a) =>
      a.status === "scheduled" &&
      a.encounterId == null &&
      a.providerId != null &&
      a.providerId === encounter.providerId &&
      dayOf(a.scheduledAt) === encDay
  );

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].id;

  // Multiple candidates on the same day + provider: only a clear nearest-time
  // signal disambiguates. Needs a time on the encounter AND on the appointments.
  const encMinute = minuteOfDay(encounter.date);
  if (encMinute == null) return null;

  let bestId: number | null = null;
  let bestDist = Infinity;
  let tie = false;
  for (const a of candidates) {
    const apptMinute = minuteOfDay(a.scheduledAt);
    if (apptMinute == null) continue; // no comparable time → not a disambiguator
    const dist = Math.abs(apptMinute - encMinute);
    if (dist < bestDist) {
      bestDist = dist;
      bestId = a.id;
      tie = false;
    } else if (dist === bestDist) {
      tie = true;
    }
  }
  // A tie (or no timed candidate at all) is ambiguous → no auto-match.
  return tie || bestId == null ? null : bestId;
}
