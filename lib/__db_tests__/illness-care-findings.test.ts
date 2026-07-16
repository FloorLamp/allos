// DB INTEGRATION TIER (issue #805 — the #448 builder-fixture rule).
//
// buildIllnessCareFindings / illnessCareItems GATHER DB state (the current open
// illness episode via the #801 assembly + the profile's age) and hand it to the pure
// illness-care engine, so they carry a DB-tier fixture asserting the END-TO-END
// finding output — the pure tier can't see the SQL gather. Pins the acceptance:
// a 4-day fever episode yields the finding; a 2-day episode does not; a dismissed
// finding stays silent everywhere (the shared bus); the worsening (trajectory)
// variant; the source-published infant band; and that every emitted dedupeKey is
// guardable against the known-prefix registry (#448 reflection guard).
//
// Deterministic: :memory:-backed temp DB via setup.ts; dates anchored on today.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { logSymptomCore } from "@/lib/symptom-log-write";
import {
  resolveSituationId,
  setProfileSetting,
  setUserBirthdate,
} from "@/lib/settings";
import {
  serializeSituationEvents,
  type SituationEvent,
} from "@/lib/trend-annotations";
import {
  buildIllnessCareFindings,
  illnessCareItems,
} from "@/lib/illness-care-findings";
import { collectUpcoming, dismissFinding } from "@/lib/queries";
import { dedupeKeyHasKnownPrefix } from "@/lib/rule-finding-prefixes";
import { ILLNESS_CARE_PREFIX } from "@/lib/illness-care";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// Flag Illness active with a start event `startDaysAgo` days back (open episode).
function makeSick(p: number, startDaysAgo: number) {
  resolveSituationId(p, "Illness"); // born illness_type = 1
  db.prepare(
    `UPDATE situations SET active = 1 WHERE profile_id = ? AND name = 'Illness'`
  ).run(p);
  const events: SituationEvent[] = [
    {
      date: shiftDateStr(today(p), -startDaysAgo),
      situation: "Illness",
      change: "start",
    },
  ];
  setProfileSetting(
    p,
    "situation_events",
    serializeSituationEvents([], events)
  );
}

// Log `severities` (oldest→newest) for `symptom` on consecutive days ENDING today.
function logConsecutive(p: number, symptom: string, severities: number[]) {
  const n = severities.length;
  severities.forEach((sev, i) =>
    logSymptomCore(p, symptom, sev, shiftDateStr(today(p), -(n - 1 - i)))
  );
}

describe("illness-care builder — duration variant (#448 fixture)", () => {
  it("a 4-day fever episode yields the duration finding end-to-end", () => {
    const p = newProfile("fever-4day");
    makeSick(p, 3);
    logConsecutive(p, "fever", [2, 2, 3, 3]); // 4 consecutive days ending today

    const findings = buildIllnessCareFindings(p, today(p));
    const dur = findings.filter((f) => f.dedupeKey.includes(":duration:"));
    expect(dur).toHaveLength(1);
    expect(dur[0].domain).toBe("illness-care");
    expect(dur[0].tone).toBe("caution");
    expect(dur[0].title).toContain("Fever logged 4 days running");
    // Cites the source verbatim-adjacent + the mandatory disclaimer tail.
    expect(dur[0].evidence).toContain("Source:");
    expect(dur[0].evidence).toContain("Informational, not medical advice.");
    expect(dur[0].detail).toContain("more than 3 days");
    // Guardable against the known-prefix registry.
    expect(dedupeKeyHasKnownPrefix(dur[0].dedupeKey)).toBe(true);
    expect(dur[0].dedupeKey.startsWith(ILLNESS_CARE_PREFIX)).toBe(true);

    // And it reaches the CARE surfaces: an Upcoming item banded "today" (→ hero),
    // self-contained detail (source + disclaimer), same dedupeKey.
    const items = illnessCareItems(p, today(p));
    const item = items.find((i) => i.key === dur[0].dedupeKey);
    expect(item).toBeTruthy();
    expect(item!.band).toBe("today");
    expect(item!.domain).toBe("illness-care");
    expect(item!.detail).toContain("Informational, not medical advice.");

    // It flows through collectUpcoming (the Upcoming page + hero + digest gather).
    const upcoming = collectUpcoming(p, today(p));
    expect(upcoming.some((i) => i.key === dur[0].dedupeKey)).toBe(true);
  });

  it("a 2-day fever episode yields NO finding (below the cited line)", () => {
    const p = newProfile("fever-2day");
    makeSick(p, 1);
    logConsecutive(p, "fever", [3, 3]); // only 2 consecutive days

    expect(buildIllnessCareFindings(p, today(p))).toHaveLength(0);
    expect(illnessCareItems(p, today(p))).toHaveLength(0);
    const upcoming = collectUpcoming(p, today(p));
    expect(upcoming.some((i) => i.key.startsWith(ILLNESS_CARE_PREFIX))).toBe(
      false
    );
  });

  it("a symptom with no dataset entry never fires (headache logged 10 days)", () => {
    const p = newProfile("headache-long");
    makeSick(p, 9);
    logConsecutive(p, "headache", [3, 3, 3, 3, 3, 3, 3, 3, 3, 3]);
    expect(buildIllnessCareFindings(p, today(p))).toHaveLength(0);
  });
});

describe("illness-care builder — dismissal (dismiss once, silence everywhere)", () => {
  it("a dismissed finding drops out of the collectUpcoming (page + hero) gather", () => {
    const p = newProfile("fever-dismiss");
    makeSick(p, 3);
    logConsecutive(p, "fever", [2, 2, 3, 3]);

    const findings = buildIllnessCareFindings(p, today(p));
    expect(findings.length).toBeGreaterThan(0);
    const key = findings[0].dedupeKey;
    expect(collectUpcoming(p, today(p)).some((i) => i.key === key)).toBe(true);

    // Dismiss via the shared bus (the SAME store every surface consults).
    dismissFinding(p, key);
    expect(collectUpcoming(p, today(p)).some((i) => i.key === key)).toBe(false);
  });
});

describe("illness-care builder — worsening (trajectory) variant", () => {
  it("rising severity over consecutive days yields the trajectory finding", () => {
    const p = newProfile("diarrhea-worse");
    makeSick(p, 2);
    logConsecutive(p, "diarrhea", [1, 2, 3]); // rising 3 days

    const findings = buildIllnessCareFindings(p, today(p));
    const traj = findings.filter((f) => f.dedupeKey.includes(":trajectory:"));
    expect(traj).toHaveLength(1);
    expect(traj[0].title).toContain("getting worse");
    expect(dedupeKeyHasKnownPrefix(traj[0].dedupeKey)).toBe(true);
  });
});

describe("illness-care builder — source-published infant band", () => {
  it("an infant under the source floor gets the refusal for any logged fever day", () => {
    const p = newProfile("infant-fever");
    makeSick(p, 0);
    // ~2 months old: birthdate 60 days ago.
    setUserBirthdate(p, shiftDateStr(today(p), -60));
    logConsecutive(p, "fever", [2]); // a single fever day

    const findings = buildIllnessCareFindings(p, today(p));
    expect(findings).toHaveLength(1);
    expect(findings[0].dedupeKey).toContain(":infant:");
    expect(findings[0].detail).toContain("infant under 3 months");
    expect(dedupeKeyHasKnownPrefix(findings[0].dedupeKey)).toBe(true);
  });
});
