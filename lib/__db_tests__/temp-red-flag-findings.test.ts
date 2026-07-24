import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  resolveSituationId,
  setProfileSetting,
  setUserBirthdate,
} from "@/lib/settings";
import {
  serializeSituationEvents,
  type SituationEvent,
} from "@/lib/trend-annotations";
import { logTemperatureCore } from "@/lib/temperature-log";
import {
  buildTempRedFlagFindings,
  tempRedFlagItems,
} from "@/lib/temp-red-flag-findings";
import { collectUpcoming, dismissFinding } from "@/lib/queries";
import {
  dedupeKeyHasKnownPrefix,
  tierForDedupeKey,
} from "@/lib/rule-finding-prefixes";
import { TEMP_RED_FLAG_PREFIX } from "@/lib/temp-red-flag";

// #448 findings-builder fixture for the single-reading temperature red-flag builder
// (issue #859 item 3). Seeds a realistic open illness episode + a logged reading and
// asserts the end-to-end care-tier finding output — the input layer the pure tier
// can't see.

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function makeSick(p: number, startDaysAgo: number) {
  resolveSituationId(p, "Illness");
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
  db.prepare(
    `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
     VALUES (?, 'Illness', ?, NULL)`
  ).run(p, shiftDateStr(today(p), -startDaysAgo));
}

describe("temp-red-flag builder — infant fever (#448 fixture)", () => {
  it("a young infant's fever reading yields the care-tier red-flag finding end-to-end", () => {
    const p = newProfile("infant-red-flag");
    makeSick(p, 1);
    setUserBirthdate(p, shiftDateStr(today(p), -60)); // ~2 months old
    // A single low-grade fever reading — crosses the infant band (>= 100.4°F).
    logTemperatureCore(p, 100.6, "F", today(p), "09:00");

    const findings = buildTempRedFlagFindings(p, today(p));
    expect(findings).toHaveLength(1);
    expect(findings[0].domain).toBe("temp-red-flag");
    expect(findings[0].tone).toBe("caution");
    expect(findings[0].dedupeKey).toContain(":infant_fever");
    expect(findings[0].title).toContain("100.6");
    expect(findings[0].detail).toMatch(/contact a clinician/i);
    expect(findings[0].evidence).toContain("Source:");
    expect(findings[0].evidence).not.toContain(
      "Informational, not medical advice."
    );
    expect(dedupeKeyHasKnownPrefix(findings[0].dedupeKey)).toBe(true);
    expect(findings[0].dedupeKey.startsWith(TEMP_RED_FLAG_PREFIX)).toBe(true);
    // #860 Track A — temp red-flag is a CARE-tier (push/hero) builder, registered so.
    expect(tierForDedupeKey(findings[0].dedupeKey)).toBe("care");

    // Care surface: an Upcoming item banded "today" (→ hero), same dedupeKey.
    const items = tempRedFlagItems(p, today(p));
    expect(items).toHaveLength(1);
    expect(items[0].key).toBe(findings[0].dedupeKey);
    expect(items[0].band).toBe("today");
    expect(items[0].detail).not.toContain("Informational, not medical advice.");

    // Flows through collectUpcoming (Upcoming page + hero + digest gather).
    expect(
      collectUpcoming(p, today(p)).some((i) => i.key === findings[0].dedupeKey)
    ).toBe(true);
  });

  it("a very high fever fires at any age (no age set)", () => {
    const p = newProfile("hyperpyrexia");
    makeSick(p, 0);
    logTemperatureCore(p, 104.5, "F", today(p), "10:00");

    const findings = buildTempRedFlagFindings(p, today(p));
    expect(findings).toHaveLength(1);
    expect(findings[0].dedupeKey).toContain(":hyperpyrexia");
  });

  it("an ordinary low fever in an adult yields NO finding", () => {
    const p = newProfile("adult-low-fever");
    makeSick(p, 0);
    setUserBirthdate(p, shiftDateStr(today(p), -30 * 365));
    logTemperatureCore(p, 100.8, "F", today(p), "10:00");

    expect(buildTempRedFlagFindings(p, today(p))).toHaveLength(0);
    expect(tempRedFlagItems(p, today(p))).toHaveLength(0);
  });

  it("a dismissed red flag drops out of collectUpcoming (dismiss once, silence everywhere)", () => {
    const p = newProfile("red-flag-dismiss");
    makeSick(p, 0);
    logTemperatureCore(p, 104.2, "F", today(p), "11:00");
    const findings = buildTempRedFlagFindings(p, today(p));
    const key = findings[0].dedupeKey;
    expect(collectUpcoming(p, today(p)).some((i) => i.key === key)).toBe(true);
    dismissFinding(p, key);
    expect(collectUpcoming(p, today(p)).some((i) => i.key === key)).toBe(false);
  });
});
