// DB INTEGRATION TIER — the medication → required-monitoring-lab bridge builder (#995),
// per the #448 findings-builder-test discipline.
//
// getMedMonitoringItems is a findings BUILDER: it GATHERS DB state (the profile's ACTIVE
// meds via the shared getIntakeSafetyContext, their courses/start dates, and the current
// lab readings) and hands it to the pure engine (buildMedMonitoring). The pure tier
// (lib/__tests__/medication-monitoring.test.ts) takes pre-gathered inputs and structurally
// can't see a gather bug (an inactive/supplement row leaking in, a mis-derived start date,
// a lab whose family key doesn't match) — so this seeds a realistic fixture and asserts the
// END-TO-END retest item, its dismissible Upcoming twin (one question, one computation),
// the satisfaction reset when a fresh lab lands, and the per-entry care/coaching tier.
//
// Fixtures are 100% synthetic (a throwaway per-file DB via setup.ts). No AI, no network.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setTimezone } from "@/lib/settings";
import {
  getMedMonitoringItems,
  collectUpcoming,
  dismissFinding,
} from "@/lib/queries";

function makeProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function addMedication(profileId: number, name: string, active = 1): number {
  return Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, active, kind)
         VALUES (?, ?, ?, 'medication')`
      )
      .run(profileId, name, active).lastInsertRowid
  );
}

function addCourse(itemId: number, startedOn: string): void {
  db.prepare(
    `INSERT INTO medication_courses (item_id, started_on, stopped_on) VALUES (?, ?, NULL)`
  ).run(itemId, startedOn);
}

function addLab(
  profileId: number,
  canonical: string,
  date: string,
  value = 1
): void {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, canonical_name, value_num)
     VALUES (?, ?, 'lab', ?, ?, ?, ?)`
  ).run(profileId, date, canonical, String(value), canonical, value);
}

function monitorKeys(profileId: number): string[] {
  return collectUpcoming(profileId, today(profileId))
    .filter((i) => i.domain === "med-monitor")
    .map((i) => i.key);
}

describe("getMedMonitoringItems — active monitored meds (#995)", () => {
  it("surfaces an overdue monitoring lab on both surfaces; a fresh lab satisfies it", () => {
    const profileId = makeProfile("medmon-lithium");
    const td = today(profileId);
    const medId = addMedication(profileId, "Lithium carbonate 300 mg");
    // Long-established (maintenance phase): started 2 years ago.
    addCourse(medId, shiftDateStr(td, -730));
    // Every lithium lab fresh EXCEPT the level, drawn 400 days ago (past 180d maintenance).
    for (const lab of [
      "Thyroid-Stimulating Hormone (TSH)",
      "Creatinine",
      // The dataset names the kidney index by its canonical entry (#2335); a lab
      // filed under the retired bare spelling would not satisfy the requirement.
      "Estimated Glomerular Filtration Rate (eGFR)",
      "Calcium",
    ]) {
      addLab(profileId, lab, shiftDateStr(td, -20));
    }
    addLab(profileId, "Lithium", shiftDateStr(td, -400));

    const hits = getMedMonitoringItems(profileId, td);
    expect(hits).toHaveLength(1);
    expect(hits[0].entryKey).toBe("lithium");
    expect(hits[0].tier).toBe("care");
    expect(hits[0].dueLabs.map((l) => l.canonical)).toEqual(["Lithium"]);
    expect(hits[0].dedupeKey).toBe(`med-monitor:${medId}:lithium`);

    // Surface 2: the dismissible Upcoming finding — same dedupeKey, carries the reason.
    const up = collectUpcoming(profileId, td).find(
      (i) => i.domain === "med-monitor"
    );
    expect(up?.key).toBe(hits[0].dedupeKey);
    expect(up?.reasons?.[0]?.code).toBe("medication-monitoring");
    expect(up?.priority).toBe(1); // care-tier ranks up

    // Satisfaction via the shared stream: a fresh lithium level resets the clock.
    addLab(profileId, "Lithium", shiftDateStr(td, -5));
    expect(getMedMonitoringItems(profileId, td)).toEqual([]);
    expect(monitorKeys(profileId)).toEqual([]);
  });

  it("dismiss silences the med-monitor finding everywhere ('dismiss once')", () => {
    const profileId = makeProfile("medmon-dismiss");
    const medId = addMedication(profileId, "Warfarin 5 mg");
    addCourse(medId, shiftDateStr(today(profileId), -365));
    addLab(profileId, "INR", shiftDateStr(today(profileId), -120)); // past 30d maintenance

    const key = `med-monitor:${medId}:warfarin`;
    expect(monitorKeys(profileId)).toContain(key);
    dismissFinding(profileId, key);
    expect(monitorKeys(profileId)).not.toContain(key);
  });

  it("a newly-started monitored med with no labs surfaces a baseline recommendation", () => {
    const profileId = makeProfile("medmon-baseline");
    const td = today(profileId);
    const medId = addMedication(profileId, "Valproate 500 mg");
    addCourse(medId, shiftDateStr(td, -2)); // just started
    const hits = getMedMonitoringItems(profileId, td);
    const valp = hits.find((h) => h.entryKey === "valproate");
    expect(valp?.kind).toBe("baseline");
  });

  it("a coaching-tier monitor (metabolic on an antipsychotic) is calm — no reason/priority, never pushed", () => {
    const profileId = makeProfile("medmon-coaching");
    const td = today(profileId);
    const medId = addMedication(profileId, "Quetiapine 200 mg");
    addCourse(medId, shiftDateStr(td, -800)); // long ago, past everything
    // No metabolic labs on file → baseline metabolic monitoring due.
    const up = collectUpcoming(profileId, td).find(
      (i) => i.key === `med-monitor:${medId}:second_gen_antipsychotic`
    );
    expect(up).toBeDefined();
    expect(up?.reasons).toBeUndefined(); // coaching: no #656 highlight reason
    expect(up?.priority).toBeUndefined(); // coaching: doesn't rank up
  });

  it("ignores an INACTIVE monitored med and a non-monitored active med", () => {
    const profileId = makeProfile("medmon-inactive");
    const inactiveId = addMedication(profileId, "Lithium 300 mg", 0);
    addCourse(inactiveId, shiftDateStr(today(profileId), -730));
    addMedication(profileId, "Acetaminophen 500 mg", 1); // active, not monitored
    expect(getMedMonitoringItems(profileId, today(profileId))).toEqual([]);
  });

  it("satisfies an HbA1c requirement with an eAG reading (family-aware, #482)", () => {
    const profileId = makeProfile("medmon-eag");
    const td = today(profileId);
    const medId = addMedication(profileId, "Olanzapine 10 mg");
    addCourse(medId, shiftDateStr(td, -800));
    // Fresh readings for every metabolic lab, with the A1c satisfied by an eAG reading.
    for (const lab of [
      "Glucose",
      "LDL Cholesterol",
      "HDL Cholesterol",
      "Triglycerides",
    ]) {
      addLab(profileId, lab, shiftDateStr(td, -20));
    }
    addLab(profileId, "Estimated Average Glucose (eAG)", shiftDateStr(td, -20));
    const metabolic = getMedMonitoringItems(profileId, td).find(
      (h) => h.entryKey === "second_gen_antipsychotic"
    );
    expect(metabolic).toBeUndefined(); // the eAG satisfied the A1c clock
  });
});

// #3836 — THE GRAIN THE INIT WINDOW IS ANCHORED IN.
//
// `recentChangeDate` is the MAX of the med's start date and its most recent dose change,
// and it anchors phaseFor's MONITORING_INIT_WINDOW_DAYS window. Converting the start date
// to the profile's local day without converting the dose stamp beside it would compare a
// local day against a UTC one — and the window's boundary is exactly where a one-day
// disagreement becomes a different phase, a different cadence, and a nudge that appears
// or does not. Both stamps below STRADDLE: the instant's UTC day and the profile's local
// day genuinely differ, and the two zones point opposite ways, so a fixed-sign mistake
// fails one of them. The med carries NO course, so its start date falls back to the
// item's created_at — dated 400 days back, which leaves the DOSE stamp as the anchor.
describe("the dose-change day the init window is measured from is the profile's (#3836)", () => {
  it.each([
    // zone, the dose stamp's UTC day relative to today, its wall time, the local day
    // that instant falls on, and the phase that local day implies. The UTC truncation
    // this replaced would have said the opposite in both rows.
    ["Pacific/Auckland", -91, "22:30:00", -90, "init"],
    ["America/Los_Angeles", -90, "02:30:00", -91, "maintenance"],
  ] as const)(
    "%s: a dose stamp on UTC day today%s at %s falls on today%s locally → %s",
    (zone, utcDay, wall, localDay, phase) => {
      const profileId = makeProfile(`medmon-grain-${localDay}`);
      setTimezone(profileId, zone);
      const td = today(profileId);
      const medId = addMedication(profileId, "Lithium carbonate 300 mg");
      db.prepare("UPDATE intake_items SET created_at = ? WHERE id = ?").run(
        `${shiftDateStr(td, -400)} 12:00:00`,
        medId
      );
      db.prepare(
        `INSERT INTO intake_item_doses
           (item_id, amount, time_of_day, food_timing, sort, updated_at)
         VALUES (?, '300 mg', 'Morning', 'any', 0, ?)`
      ).run(medId, `${shiftDateStr(td, utcDay)} ${wall}`);
      // A stale lithium level, so a hit is emitted in EITHER phase and `phase` is the only
      // thing the two rows disagree about.
      addLab(profileId, "Lithium", shiftDateStr(td, -400));

      const hit = getMedMonitoringItems(profileId, td).find(
        (h) => h.entryKey === "lithium"
      )!;
      expect(hit.phase).toBe(phase);
      // The anchor really is the dose stamp's LOCAL day, not the UTC day beside it.
      expect(shiftDateStr(td, localDay)).not.toBe(shiftDateStr(td, utcDay));
    }
  );
});
