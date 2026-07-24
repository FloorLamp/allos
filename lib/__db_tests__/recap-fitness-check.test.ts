// DB INTEGRATION TIER — the weekly-recap gather's fitness-check completion line (#1307).
// A check that COMPLETED in the window surfaces one recap line (the dashboard card and the
// Telegram recap read the SAME gather, #221); absent when no check completed. Every value
// is synthetic. Runs against a throwaway DB (lib/__db_tests__/setup.ts).

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { batteryForAge } from "@/lib/fitness-battery";
import { saveFitnessEntry } from "@/lib/fitness-assessment";
import { gatherRecapInput } from "@/lib/notifications/weekly-recap-data";
import { buildWeeklyRecap } from "@/lib/weekly-recap";

function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  const ins = db.prepare(
    "INSERT INTO profile_settings (profile_id, key, value) VALUES (?, ?, ?) ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value"
  );
  ins.run(id, "sex", "male");
  ins.run(id, "birthdate", "1985-06-01");
  return id;
}

// Record a plausible fresh value for every battery test on `date`, so the whole battery
// reads complete. The big lift needs a chosen lift; a plausible mid value suffices for the
// rest (the completion decision only cares that each carries a fresh value).
function completeBattery(profileId: number, date: string) {
  for (const def of batteryForAge(40)) {
    saveFitnessEntry(profileId, {
      date,
      testKey: def.key,
      value: def.key === "vo2max" ? 45 : def.lowerIsBetter ? 12 : 40,
      liftName:
        def.store.kind === "set" && !def.store.lift ? "Back Squat" : undefined,
    });
  }
}

describe("gatherRecapInput — fitness-check completion line (#1307)", () => {
  it("includes the completed-check line when a full check landed this window", () => {
    const profileId = newProfile("recap-fitness-complete");
    completeBattery(profileId, today(profileId));

    const input = gatherRecapInput(profileId);
    expect(input.fitnessCheck).not.toBeNull();
    const recap = buildWeeklyRecap(input);
    expect(recap.lines.find((l) => l.key === "fitness-check")).toBeTruthy();
  });

  it("omits the line when no check exists", () => {
    const profileId = newProfile("recap-fitness-none");
    const input = gatherRecapInput(profileId);
    expect(input.fitnessCheck ?? null).toBeNull();
    const recap = buildWeeklyRecap(input);
    expect(recap.lines.find((l) => l.key === "fitness-check")).toBeUndefined();
  });

  it("omits the line when the only check is OLDER than the window", () => {
    const profileId = newProfile("recap-fitness-old");
    completeBattery(profileId, shiftDateStr(today(profileId), -30));
    const input = gatherRecapInput(profileId);
    expect(input.fitnessCheck ?? null).toBeNull();
  });
});
