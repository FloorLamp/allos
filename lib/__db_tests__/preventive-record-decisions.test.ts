// DB INTEGRATION TIER — preventive review decisions (issue #3025). The pure
// boundary (structured evidence decides, prose asks) is unit-tested in
// lib/__tests__/preventive-review.test.ts; this exercises the real tables and
// wiring end-to-end on the owner-reported scenario: a screened profile whose
// Pap cytology was imported as a valueless `report` row. The report emits ONE
// review candidate beside the still-actionable cervical item; confirming it
// with the record date links the decision to the record, satisfies the rule
// through the one shared assessor, and lets the existing nudge lifecycle sweep
// the stale episode marker; dismissing suppresses only the candidate. Forged
// writes write nothing, reconfirming is idempotent, deletion cascades, and
// every read is profile-scoped.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { addMonths } from "@/lib/preventive-status";
import { setProfileBirthdate, setProfileSex } from "@/lib/settings";
import { getProfileSetting, setProfileSetting } from "@/lib/settings";
import { runPreventive } from "@/lib/notifications/preventive";
import { buildDigest, renderDigestMessage } from "@/lib/notifications/digest";
import { gatherDigestInput } from "@/lib/notifications/digest-data";
import {
  assessProfilePreventive,
  collectUpcoming,
  confirmPreventiveRecordDecision,
  dismissPreventiveRecordCandidate,
  dismissFinding,
  getConfirmedPreventiveRecordSatisfactions,
  getFindingSuppressions,
  getInferredPreventiveSatisfactions,
  getPreventiveRecordDecisions,
  getPreventiveReviewOffers,
} from "@/lib/queries";

const PAP_NAME = "Cytology, Gyn-PAP Test (AP)";
const RULE = "cervical_cancer";
const SIGNAL = `screening:${RULE}`;
const MARKER = `notify_last_preventive_${RULE}`;

// A ~40-year-old female — inside the cervical window (21–65). The HPV lab is
// old enough that the 36-month interval has lapsed (the rule is actionable);
// the Pap report is ~23 months old, so counting it moves the next due date
// ~13 months into the future.
const HPV_DAYS_AGO = 1240; // ~41 months
const PAP_DAYS_AGO = 700; // ~23 months

function femaleProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setProfileBirthdate(id, "1986-01-01");
  setProfileSex(id, "female");
  return id;
}

// The owner-reported shape: an HPV RESULT that counts (LOINC in the cervical
// qualitative concept, value present) and a VALUELESS Pap cytology report that
// used to count for nothing.
function screenedProfile(name: string): {
  p: number;
  now: string;
  papDate: string;
  papId: number;
} {
  const p = femaleProfile(name);
  const now = today(p);
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, canonical_name, value, loinc)
     VALUES (?, ?, 'lab', 'HPV, High Risk', NULL, 'Not Detected', '30167-1')`
  ).run(p, shiftDateStr(now, -HPV_DAYS_AGO));
  const papDate = shiftDateStr(now, -PAP_DAYS_AGO);
  const papId = Number(
    db
      .prepare(
        `INSERT INTO medical_records
           (profile_id, date, category, name, value, loinc)
         VALUES (?, ?, 'report', ?, NULL, '33717-0')`
      )
      .run(p, papDate, PAP_NAME).lastInsertRowid
  );
  return { p, now, papDate, papId };
}

function cervicalActionable(p: number, now: string): boolean {
  return assessProfilePreventive(p, now).actionable.some((a) => a.key === RULE);
}

describe("the owner-reported Pap scenario (#3025)", () => {
  it("the valueless Pap report emits ONE candidate and leaves the item actionable", () => {
    const { p, now, papDate, papId } = screenedProfile("Pap Offer");

    // The report alone never auto-satisfies: the only cervical satisfaction is
    // the lapsed HPV result's (the #686 stream), so the rule is still actionable.
    expect(cervicalActionable(p, now)).toBe(true);
    expect(
      getInferredPreventiveSatisfactions(p).some(
        (s) => s.ruleKey === RULE && s.date === papDate
      )
    ).toBe(false);

    // ...and exactly one review candidate is offered for the (record, rule) pair.
    expect(getPreventiveReviewOffers(p)).toEqual([
      {
        recordId: papId,
        ruleKey: RULE,
        recordName: PAP_NAME,
        recordDate: papDate,
      },
    ]);

    // The candidate rides BESIDE the due item on Upcoming, which stays banded
    // as work until the person confirms.
    const item = collectUpcoming(p, now).find((i) => i.key === SIGNAL);
    expect(item?.signalGroup).toBeUndefined();
    expect(item?.preventiveReview).toEqual([
      {
        recordId: papId,
        ruleKey: RULE,
        recordName: PAP_NAME,
        recordDate: papDate,
      },
    ]);
  });

  it("confirming with the record date satisfies the rule and moves the next due +36mo", () => {
    const { p, now, papDate, papId } = screenedProfile("Pap Confirm");

    expect(confirmPreventiveRecordDecision(p, papId, RULE, papDate)).toBe(
      "written"
    );

    // The decision links THIS record to THIS rule and projects into the shared
    // satisfaction stream — deliberately not duplicated into preventive_events.
    expect(getPreventiveRecordDecisions(p)).toEqual([
      {
        medicalRecordId: papId,
        ruleKey: RULE,
        decision: "confirmed",
        confirmedDate: papDate,
      },
    ]);
    expect(getConfirmedPreventiveRecordSatisfactions(p)).toEqual([
      { ruleKey: RULE, date: papDate },
    ]);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM preventive_events WHERE profile_id = ?"
        )
        .get(p) as { n: number }
    ).toEqual({ n: 0 });

    // The assessment is no longer actionable and the next due date is the
    // confirmed date + the rule's 36-month interval.
    expect(cervicalActionable(p, now)).toBe(false);
    const assessment = assessProfilePreventive(p, now).assessments.find(
      (a) => a.key === RULE
    );
    expect(assessment?.nextDueDate).toBe(addMonths(papDate, 36));

    // Answered → the candidate is no longer offered.
    expect(getPreventiveReviewOffers(p)).toEqual([]);
  });

  it("a changed date is the date the satisfaction stream receives", () => {
    const { p, papId } = screenedProfile("Pap Edited Date");
    const edited = shiftDateStr(today(p), -30);
    confirmPreventiveRecordDecision(p, papId, RULE, edited);
    expect(getConfirmedPreventiveRecordSatisfactions(p)).toEqual([
      { ruleKey: RULE, date: edited },
    ]);
  });

  it("reconfirming is idempotent; a re-confirm with a new date updates the ONE row", () => {
    const { p, papDate, papId } = screenedProfile("Pap Idempotent");
    confirmPreventiveRecordDecision(p, papId, RULE, papDate);
    // Reconfirm — same pair, still a derivable candidate even though decided.
    expect(confirmPreventiveRecordDecision(p, papId, RULE, papDate)).toBe(
      "written"
    );
    const changed = shiftDateStr(papDate, 1);
    expect(confirmPreventiveRecordDecision(p, papId, RULE, changed)).toBe(
      "written"
    );
    const rows = getPreventiveRecordDecisions(p);
    expect(rows).toHaveLength(1);
    expect(rows[0].confirmedDate).toBe(changed);
  });

  it("dismissing suppresses ONLY the candidate — the preventive item stays", () => {
    const { p, now, papId } = screenedProfile("Pap Dismiss");
    expect(dismissPreventiveRecordCandidate(p, papId, RULE)).toBe("written");

    // The candidate is gone from the offers and from the item...
    expect(getPreventiveReviewOffers(p)).toEqual([]);
    const item = collectUpcoming(p, now).find((i) => i.key === SIGNAL);
    expect(item).toBeTruthy();
    expect(item?.preventiveReview).toBeUndefined();

    // ...but the item itself is still actionable and nothing satisfied the rule.
    expect(cervicalActionable(p, now)).toBe(true);
    expect(getConfirmedPreventiveRecordSatisfactions(p)).toEqual([]);
  });

  it("a dismissed candidate can still be confirmed later (the pair still derives)", () => {
    const { p, now, papDate, papId } = screenedProfile(
      "Pap Dismiss Then Confirm"
    );
    dismissPreventiveRecordCandidate(p, papId, RULE);
    expect(confirmPreventiveRecordDecision(p, papId, RULE, papDate)).toBe(
      "written"
    );
    expect(cervicalActionable(p, now)).toBe(false);
  });
});

describe("write validation (#3025)", () => {
  it("a forged profile/record/rule combination writes nothing", () => {
    const { papId } = screenedProfile("Forged Owner");
    const other = femaleProfile("Forged Other");

    // Another profile's record id under my profile: not a candidate here.
    expect(
      confirmPreventiveRecordDecision(other, papId, RULE, today(other))
    ).toBe("not-a-candidate");
    // A rule the record's title does not uniquely match.
    const { p: mine, papId: myPap } = screenedProfile("Forged Rule");
    expect(
      confirmPreventiveRecordDecision(mine, myPap, "mammography", today(mine))
    ).toBe("not-a-candidate");
    // A record that does not exist.
    expect(
      confirmPreventiveRecordDecision(mine, 99999999, RULE, today(mine))
    ).toBe("not-a-candidate");
    // Dismissal validates identically.
    expect(dismissPreventiveRecordCandidate(other, papId, RULE)).toBe(
      "not-a-candidate"
    );

    expect(getPreventiveRecordDecisions(other)).toEqual([]);
    expect(
      getPreventiveRecordDecisions(mine).filter(
        (d) => d.ruleKey !== RULE || d.medicalRecordId !== myPap
      )
    ).toEqual([]);
  });

  it("a malformed confirmed date writes nothing", () => {
    const { p, papId } = screenedProfile("Bad Date");
    expect(confirmPreventiveRecordDecision(p, papId, RULE, "not-a-date")).toBe(
      "invalid-date"
    );
    expect(getPreventiveRecordDecisions(p)).toEqual([]);
  });

  it("a value-bearing or edited-away record stops being a candidate target", () => {
    const { p, papDate, papId } = screenedProfile("Edited Record");
    // The record acquires a value — it is a result now, not a document to review.
    db.prepare("UPDATE medical_records SET value = 'NILM' WHERE id = ?").run(
      papId
    );
    expect(confirmPreventiveRecordDecision(p, papId, RULE, papDate)).toBe(
      "not-a-candidate"
    );
  });

  it("every decision read is profile-scoped", () => {
    const { p, papDate, papId } = screenedProfile("Scoped A");
    const other = femaleProfile("Scoped B");
    confirmPreventiveRecordDecision(p, papId, RULE, papDate);
    expect(getPreventiveRecordDecisions(other)).toEqual([]);
    expect(getConfirmedPreventiveRecordSatisfactions(other)).toEqual([]);
    expect(getPreventiveReviewOffers(other)).toEqual([]);
  });
});

describe("lifecycle (#3025)", () => {
  it("deleting the source record cascades the decision and retracts the satisfaction", () => {
    const { p, now, papDate, papId } = screenedProfile("Cascade");
    confirmPreventiveRecordDecision(p, papId, RULE, papDate);
    expect(cervicalActionable(p, now)).toBe(false);

    db.prepare(
      "DELETE FROM medical_records WHERE id = ? AND profile_id = ?"
    ).run(papId, p);

    expect(getPreventiveRecordDecisions(p)).toEqual([]);
    expect(getConfirmedPreventiveRecordSatisfactions(p)).toEqual([]);
    // The evidence is gone, so the rule is due again.
    expect(cervicalActionable(p, now)).toBe(true);
  });

  it("confirmation retires the rule's shared page dismissal (episode ends, #1024)", () => {
    const { p, now, papDate, papId } = screenedProfile("Dismissal Clear");
    dismissFinding(p, SIGNAL);
    expect(getFindingSuppressions(p).has(SIGNAL)).toBe(true);

    confirmPreventiveRecordDecision(p, papId, RULE, papDate);
    expect(getFindingSuppressions(p).has(SIGNAL)).toBe(false);
    expect(cervicalActionable(p, now)).toBe(false);
  });

  it("once confirmation makes the rule not due, the nudge lifecycle clears the stale marker", async () => {
    const { p, now, papDate, papId } = screenedProfile("Marker Sweep");
    // The 2026-08-16 state: the once-per-episode nudge already fired.
    setProfileSetting(p, MARKER, shiftDateStr(now, -3));

    confirmPreventiveRecordDecision(p, papId, RULE, papDate);
    await runPreventive(p, "Marker Sweep", now);

    expect(getProfileSetting(p, MARKER)).toBeUndefined();
  });

  it("the candidate is absent from the digest send transcript", () => {
    const { p } = screenedProfile("Digest Silent");
    const model = buildDigest(gatherDigestInput(p, "Digest Silent"));
    if (model) {
      const msg = renderDigestMessage(model);
      const text = `${msg.title} ${msg.body} ${JSON.stringify(msg)}`;
      expect(text).not.toContain(PAP_NAME);
      expect(text).not.toContain("Does this record show");
    }
  });
});

describe("structured document evidence through the real gather (#3025)", () => {
  it("a report carrying a concept-map code or curated canonical name auto-satisfies", () => {
    const p = femaleProfile("Structured Report");
    const now = today(p);
    const d = shiftDateStr(now, -10);
    // Exact code authored by the concept map (CPT cervical cytopathology).
    db.prepare(
      `INSERT INTO medical_records (profile_id, date, category, name, value, loinc)
       VALUES (?, ?, 'report', 'Narrative cytopathology', NULL, '88141')`
    ).run(p, d);
    // Curated canonical name authored for lipid_screening — refusal wording in
    // the free-text title cannot withhold it (identity beats prose).
    db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, canonical_name, value)
       VALUES (?, ?, 'report', 'Lipid panel — fasting not done', 'LDL Cholesterol', NULL)`
    ).run(p, d);

    const sats = getInferredPreventiveSatisfactions(p);
    expect(sats).toContainEqual({ ruleKey: RULE, date: d });
    expect(sats).toContainEqual({ ruleKey: "lipid_screening", date: d });
  });

  it("order/counseling/refusal titles never auto-satisfy from any document row", () => {
    const p = femaleProfile("Prose Reports");
    const now = today(p);
    const d = shiftDateStr(now, -10);
    for (const name of [
      "Nutrition Counseling Note",
      "Order for screening mammogram",
      "Radiology: Order for screening mammogram",
      "Screening mammogram declined by patient",
    ]) {
      db.prepare(
        `INSERT INTO medical_records (profile_id, date, category, name, value)
         VALUES (?, ?, 'report', ?, NULL)`
      ).run(p, d, name);
    }
    expect(getInferredPreventiveSatisfactions(p)).toEqual([]);
  });
});
