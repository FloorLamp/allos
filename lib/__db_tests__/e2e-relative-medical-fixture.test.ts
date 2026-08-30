// DB INTEGRATION TIER — profile 1's undated e2e documents move on the same
// today-relative calendar as its past illness episode (#3949).

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setTimezone } from "@/lib/settings";
import { getEpisodeInRangeEvents } from "@/lib/illness-episode-events";
import { pinnedTimezone } from "../../e2e/pinned-timezone";
import {
  PROFILE_ONE_UNDATED_DOCUMENT_UPLOADS,
  profileOneUndatedDocumentUploadedAt,
  type ProfileOneUndatedDocumentFilename,
} from "../../e2e/seed/profile-time-fixtures";

const FIRST_RUN_DAY = "2026-08-28";
const RUN_DAY_COUNT = 60;

function newProfile(): number {
  return Number(
    db
      .prepare("INSERT INTO profiles (name) VALUES ('relative document sweep')")
      .run().lastInsertRowid
  );
}

function zonesFor(runDay: string): string[] {
  return Array.from(
    { length: 24 },
    (_, hour) =>
      pinnedTimezone(`${runDay}T${String(hour).padStart(2, "0")}:37:00.000Z`)
        .zone
  );
}

function membershipSignatures(
  profileId: number,
  runDay: string,
  uploadedAt: (
    filename: ProfileOneUndatedDocumentFilename,
    zone: string
  ) => string
): Set<string> {
  const signatures = new Set<string>();
  for (const zone of zonesFor(runDay)) {
    setTimezone(profileId, zone);
    db.prepare("DELETE FROM medical_documents WHERE profile_id = ?").run(
      profileId
    );
    for (const fixture of PROFILE_ONE_UNDATED_DOCUMENT_UPLOADS) {
      db.prepare(
        `INSERT INTO medical_documents
           (profile_id, filename, stored_path, extraction_status, uploaded_at)
         VALUES (?, ?, '', 'done', ?)`
      ).run(profileId, fixture.filename, uploadedAt(fixture.filename, zone));
    }
    // situation_events stops on daysAgo(52), so the stored episode's inclusive end
    // is daysAgo(53), matching scripts/seed.ts's reconstruction.
    const documents = getEpisodeInRangeEvents(
      profileId,
      shiftDateStr(runDay, -60),
      shiftDateStr(runDay, -53)
    ).documents;
    signatures.add(
      documents
        .map((document) => document.filename)
        .sort()
        .join("|")
    );
  }
  return signatures;
}

describe("profile-1 undated documents follow the illness fixture clock (#3949)", () => {
  it("has identical episode membership across dates and all 24 pinned zones", () => {
    const profileId = newProfile();
    for (let dayIndex = 0; dayIndex < RUN_DAY_COUNT; dayIndex++) {
      const runDay = shiftDateStr(FIRST_RUN_DAY, dayIndex);
      const signatures = membershipSignatures(
        profileId,
        runDay,
        (filename, zone) =>
          profileOneUndatedDocumentUploadedAt(filename, runDay, zone)
      );
      expect([...signatures], runDay).toEqual([""]);
    }
  });

  it("would red when the documents are pinned back to the old fixed clock", () => {
    const profileId = newProfile();
    const runDay = "2026-08-30";
    const oldFixed = new Map(
      PROFILE_ONE_UNDATED_DOCUMENT_UPLOADS.map((fixture) => [
        fixture.filename,
        `${fixture.filename === "e2e-produced-panels.xml" ? "2026-07-09" : "2026-07-08"} ${fixture.wallTime}:00`,
      ])
    );
    const signatures = membershipSignatures(profileId, runDay, (filename) =>
      oldFixed.get(filename)!
    );
    expect(signatures.size).toBeGreaterThan(1);
  });
});
