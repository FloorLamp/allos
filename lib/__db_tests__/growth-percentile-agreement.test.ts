// DB INTEGRATION TIER — the passport and /trends/growth report the SAME percentile
// for the SAME measurement (#2802).
//
// The reported disagreement: one 22-month-old, one Aug 9 height + weight, and two
// numbers — the health passport said 53rd/54th while the growth page said 64th/60th.
// Same tables, same scorer; the divergence was WHEN age was evaluated. The passport
// took the latest scalar and scored it at the age TODAY; the growth page scores every
// measurement at the age on ITS OWN date. A birthdate whose anniversary day falls
// between the measurement and today floors to a different whole month — one reference
// row apart on a steep median — so the headline number of a growth-first profile
// depended on which page you were looking at.
//
// The repair is ONE computation: the passport reads growthBadge(buildGrowthProfile())
// too. What this file proves, against real rows in both stores, is that the two
// surfaces agree — and that the fixture is a real reproduction, i.e. the retired
// score-at-today shortcut would still disagree on these very rows.
//
// All fixtures SYNTHETIC.

import { describe, it, expect, beforeAll } from "vitest";
import { db, today } from "@/lib/db";
import { ageInMonthsFromBirthdate, shiftDateStr } from "@/lib/date";
import { measurementPercentile } from "@/lib/growth";
import { buildGrowthTrendPresentation } from "@/lib/growth-trend-views";
import { getGrowthMeasurementSeries } from "@/lib/queries";
import { getProfileSummary } from "@/lib/profile-summary-load";
import { setProfileBirthdate, setProfileSex } from "@/lib/settings";

const HEIGHT_CM = 84.3;
const WEIGHT_KG = 11.2;

let profileId: number;
let todayStr: string;
let birthdate: string;
let measuredOn: string;

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run("GROWTH-AGREE")
      .lastInsertRowid
  );
  todayStr = today(profileId);
  // ~21 months old, with the one reading taken 40 days ago. Forty days is longer
  // than any month, so the reading's whole-month age is BELOW the age today for
  // every possible birthdate — the divergence this file is about is guaranteed
  // rather than dependent on which day the suite runs.
  birthdate = shiftDateStr(todayStr, -650);
  measuredOn = shiftDateStr(todayStr, -40);
  setProfileBirthdate(profileId, birthdate);
  setProfileSex(profileId, "female");
  db.prepare(
    `INSERT INTO metric_samples
       (profile_id, source, metric, date, started_at, ended_at, value)
     VALUES (?, 'manual', 'height_cm', ?, ?, ?, ?)`
  ).run(
    profileId,
    measuredOn,
    `${measuredOn}T09:00`,
    `${measuredOn}T09:00`,
    HEIGHT_CM
  );
  db.prepare(
    `INSERT INTO body_metrics (profile_id, date, weight_kg, source)
     VALUES (?, ?, ?, 'manual')`
  ).run(profileId, measuredOn, WEIGHT_KG);
});

describe("passport growth badge vs /trends/growth", () => {
  it("prints the same percentile for the same measurement", () => {
    const badge = getProfileSummary(profileId, "GROWTH-AGREE").body.growth;
    const presentation = buildGrowthTrendPresentation({
      sex: "female",
      birthdate,
      today: todayStr,
      ...getGrowthMeasurementSeries(profileId),
      weightUnit: "kg",
    });
    const pageLatest = (metric: string) =>
      presentation?.views.find((v) => v.metric === metric)?.latestPercentile ??
      null;

    expect(badge).not.toBeNull();
    expect(badge!.heightPercentile).toBe(pageLatest("height"));
    expect(badge!.weightPercentile).toBe(pageLatest("weight"));
    expect(badge!.heightPercentile).not.toBeNull();
    expect(badge!.weightPercentile).not.toBeNull();
  });

  it("scores at the reading's own age, not the age today", () => {
    const badge = getProfileSummary(profileId, "GROWTH-AGREE").body.growth;
    const ageAtReading = ageInMonthsFromBirthdate(birthdate, measuredOn)!;
    const ageToday = ageInMonthsFromBirthdate(birthdate, todayStr)!;
    // The fixture really does straddle a month boundary — otherwise the assertion
    // below would pass for the wrong reason.
    expect(ageToday).toBeGreaterThan(ageAtReading);

    expect(badge!.heightPercentile).toBe(
      measurementPercentile("female", ageAtReading, "height", HEIGHT_CM)!
        .percentile
    );
    // The retired shortcut's answer — a different number, which is why two
    // surfaces disagreed.
    expect(badge!.heightPercentile).not.toBe(
      measurementPercentile("female", ageToday, "height", HEIGHT_CM)!.percentile
    );
  });
});
