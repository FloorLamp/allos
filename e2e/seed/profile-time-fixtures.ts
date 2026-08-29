// Pure constructors for the two profile-local fixture corpora whose invariants are
// swept in the unit/DB tiers. Keep the clocks here so the seed and its proof cannot
// quietly choose different calendars.

import { shiftDateStr, utcSqlString, zonedWallTimeToUtc } from "../../lib/date";

export function sriSleepWindow(
  timeZone: string,
  wakeDay: string,
  weekend: boolean
): { start: string; end: string } {
  const startDay = weekend ? wakeDay : shiftDateStr(wakeDay, -1);
  const startWall = weekend ? "00:30" : "23:00";
  const endWall = weekend ? "08:30" : "07:00";
  return {
    start: zonedWallTimeToUtc(timeZone, startDay, startWall)!.toISOString(),
    end: zonedWallTimeToUtc(timeZone, wakeDay, endWall)!.toISOString(),
  };
}

export const PROFILE_ONE_UNDATED_DOCUMENT_UPLOADS = [
  { filename: "e2e-labs.pdf", dayOffset: -51, wallTime: "12:00" },
  { filename: "e2e-broken.txt", dayOffset: -51, wallTime: "11:30" },
  { filename: "e2e-mychart-export.xml", dayOffset: -51, wallTime: "10:30" },
  { filename: "e2e-drop-report.xml", dayOffset: -51, wallTime: "09:45" },
  { filename: "e2e-declined-only.pdf", dayOffset: -51, wallTime: "09:50" },
  { filename: "e2e-growth-visit.pdf", dayOffset: -51, wallTime: "09:40" },
  { filename: "e2e-confidence-labs.pdf", dayOffset: -51, wallTime: "09:40" },
  { filename: "e2e-records-browser.xml", dayOffset: -51, wallTime: "09:50" },
  { filename: "e2e-produced-panels.xml", dayOffset: -50, wallTime: "09:50" },
  { filename: "e2e-triage-labs.pdf", dayOffset: -51, wallTime: "09:35" },
] as const;

export type ProfileOneUndatedDocumentFilename =
  (typeof PROFILE_ONE_UNDATED_DOCUMENT_UPLOADS)[number]["filename"];

export function profileOneUndatedDocumentUploadedAt(
  filename: ProfileOneUndatedDocumentFilename,
  profileToday: string,
  timeZone: string
): string {
  const fixture = PROFILE_ONE_UNDATED_DOCUMENT_UPLOADS.find(
    (entry) => entry.filename === filename
  );
  if (!fixture)
    throw new Error(`Unknown profile-1 document fixture: ${filename}`);
  return utcSqlString(
    zonedWallTimeToUtc(
      timeZone,
      shiftDateStr(profileToday, fixture.dayOffset),
      fixture.wallTime
    )!
  );
}
