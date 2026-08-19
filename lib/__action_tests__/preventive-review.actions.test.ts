// SERVER-ACTION TIER — preventive review candidate confirm/dismiss (issue
// #3025). The lib core is DB-tier tested; this exercises the REAL actions:
// the gate, the field parsing, and — the adversarial reproduction — the
// calendar-invalid date "2024-13-45", which fits the bare \d{4}-\d{2}-\d{2}
// shape and slips past a lexical compare against today (month 13 in a past
// year), so only isRealIsoDate refuses it. A written nonsense day would
// project verbatim into the PreventiveSatisfaction stream.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setProfileBirthdate, setProfileSex } from "@/lib/settings";
import {
  confirmPreventiveRecord,
  dismissPreventiveRecord,
} from "@/app/(app)/upcoming/actions";
import { getPreventiveRecordDecisions } from "@/lib/queries";
import { seedActor, fd } from "./harness";

const PAP_NAME = "Cytology, Gyn-PAP Test (AP)";
const RULE = "cervical_cancer";

// The acting profile with the owner-reported fixture: a valueless Pap report
// old enough to prefill a past date.
function seedPap(): { profileId: number; papId: number; papDate: string } {
  const { profile } = seedActor();
  setProfileBirthdate(profile.id, "1986-01-01");
  setProfileSex(profile.id, "female");
  const papDate = shiftDateStr(today(profile.id), -700);
  const papId = Number(
    db
      .prepare(
        `INSERT INTO medical_records
           (profile_id, date, category, name, value, loinc)
         VALUES (?, ?, 'report', ?, NULL, '33717-0')`
      )
      .run(profile.id, papDate, PAP_NAME).lastInsertRowid
  );
  return { profileId: profile.id, papId, papDate };
}

describe("confirmPreventiveRecord", () => {
  it("refuses the calendar-invalid '2024-13-45' and writes nothing", async () => {
    const { profileId, papId } = seedPap();
    const res = await confirmPreventiveRecord(
      fd({ record_id: papId, rule_key: RULE, confirmed_date: "2024-13-45" })
    );
    expect(res).toEqual({
      ok: false,
      error: "Enter a valid date (today or earlier).",
    });
    expect(getPreventiveRecordDecisions(profileId)).toEqual([]);
  });

  it("refuses '2024-02-31' (real-shape, impossible day) and a future date", async () => {
    const { profileId, papId } = seedPap();
    for (const confirmed_date of [
      "2024-02-31",
      shiftDateStr(today(profileId), 1),
    ]) {
      const res = await confirmPreventiveRecord(
        fd({ record_id: papId, rule_key: RULE, confirmed_date })
      );
      expect(res.ok).toBe(false);
    }
    expect(getPreventiveRecordDecisions(profileId)).toEqual([]);
  });

  it("writes the confirmed decision for a real past day", async () => {
    const { profileId, papId, papDate } = seedPap();
    const res = await confirmPreventiveRecord(
      fd({ record_id: papId, rule_key: RULE, confirmed_date: papDate })
    );
    expect(res).toEqual({ ok: true });
    expect(getPreventiveRecordDecisions(profileId)).toEqual([
      {
        medicalRecordId: papId,
        ruleKey: RULE,
        decision: "confirmed",
        confirmedDate: papDate,
      },
    ]);
  });
});

describe("dismissPreventiveRecord", () => {
  it("writes the dismissed decision for the offered pair", async () => {
    const { profileId, papId } = seedPap();
    const res = await dismissPreventiveRecord(
      fd({ record_id: papId, rule_key: RULE })
    );
    expect(res).toEqual({ ok: true });
    expect(getPreventiveRecordDecisions(profileId)).toEqual([
      {
        medicalRecordId: papId,
        ruleKey: RULE,
        decision: "dismissed",
        confirmedDate: null,
      },
    ]);
  });
});
