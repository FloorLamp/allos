// SERVER-ACTION TIER — manual body-temperature quick entry from the illness symptom
// card (issue #800). Proves the real logTemperature action runs through the (mocked)
// auth guard and: converts °C/°F at the boundary to canonical degF, writes ONE
// medical_records row in the shared "Body Temperature" vitals identity (source
// 'manual', external_id NULL), derives the reference-range flag ("high" on a fever),
// stamps the reading's clock time in `notes`, supports multiple same-day readings, and
// rejects malformed/out-of-range input without writing.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { logTemperature } from "@/app/(app)/symptoms/actions";
import { createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
const DATE = "2026-07-08";

interface TempRow {
  date: string;
  category: string;
  name: string;
  canonical_name: string | null;
  value: string | null;
  value_num: number | null;
  unit: string | null;
  flag: string | null;
  source: string | null;
  external_id: string | null;
  notes: string | null;
}

function tempRows(profileId: number): TempRow[] {
  return db
    .prepare(
      `SELECT date, category, name, canonical_name, value, value_num, unit, flag,
              source, external_id, notes
         FROM medical_records
        WHERE profile_id = ? AND canonical_name = 'Body Temperature'
        ORDER BY id`
    )
    .all(profileId) as TempRow[];
}

beforeEach(() => {
  revalidate.mockClear();
});

describe("logTemperature — canonical write + fever flag", () => {
  it("logs a °C fever into the shared vitals series flagged high", async () => {
    const login = createLogin();
    const profile = createProfile("Feverish Kid", login.id);
    actAs(login, profile);

    const res = await logTemperature(
      fd({ temperature: "39.5", temp_unit: "C", date: DATE, time: "02:15" })
    );
    expect(res).toEqual({ ok: true, degF: 103.1, flag: "high", redFlag: null });

    const rows = tempRows(profile.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      date: DATE,
      category: "vitals",
      name: "Body Temperature",
      canonical_name: "Body Temperature",
      value: "103.1",
      value_num: 103.1,
      unit: "degF",
      flag: "high",
      source: "manual",
      external_id: null,
      notes: "02:15", // the reading's clock time rides notes (fever curve)
    });
    expect(revalidate).toHaveBeenCalledWith("/timeline");
    expect(revalidate).toHaveBeenCalledWith("/results");
  });

  it("logs a °F reading without conversion", async () => {
    const login = createLogin();
    const profile = createProfile("F Reader", login.id);
    actAs(login, profile);

    const res = await logTemperature(
      fd({ temperature: "98.6", temp_unit: "F", date: DATE })
    );
    expect(res).toEqual({ ok: true, degF: 98.6, flag: null, redFlag: null });
    const rows = tempRows(profile.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].value_num).toBe(98.6);
    expect(rows[0].flag).toBeNull(); // in range → no derived flag
  });

  it("supports multiple same-day readings with distinct times (fever curve)", async () => {
    const login = createLogin();
    const profile = createProfile("Curve", login.id);
    actAs(login, profile);

    await logTemperature(
      fd({ temperature: "100.4", temp_unit: "F", date: DATE, time: "08:00" })
    );
    await logTemperature(
      fd({ temperature: "102.2", temp_unit: "F", date: DATE, time: "14:00" })
    );
    await logTemperature(
      fd({ temperature: "101.1", temp_unit: "F", date: DATE, time: "20:00" })
    );

    const rows = tempRows(profile.id);
    // Three distinct same-day rows — none collapsed (distinct values) — each with its
    // own time in notes, each flagged high.
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.notes)).toEqual(["08:00", "14:00", "20:00"]);
    expect(rows.map((r) => r.value_num)).toEqual([100.4, 102.2, 101.1]);
    expect(rows.every((r) => r.flag === "high")).toBe(true);
  });
});

describe("logTemperature — rejects bad input without writing", () => {
  it("rejects a non-numeric temperature", async () => {
    const login = createLogin();
    const profile = createProfile("Bad", login.id);
    actAs(login, profile);

    const res = await logTemperature(
      fd({ temperature: "not-a-temp", temp_unit: "F", date: DATE })
    );
    expect(res.ok).toBe(false);
    expect(tempRows(profile.id)).toHaveLength(0);
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("rejects a physiologically impossible reading", async () => {
    const login = createLogin();
    const profile = createProfile("Impossible", login.id);
    actAs(login, profile);

    // 60 °C → 140 °F, well past the upper bound.
    const res = await logTemperature(
      fd({ temperature: "60", temp_unit: "C", date: DATE })
    );
    expect(res).toEqual({
      ok: false,
      error: "Body temperature is out of range.",
    });
    expect(tempRows(profile.id)).toHaveLength(0);
  });

  it("scopes the write to the acting profile", async () => {
    const login = createLogin();
    const mine = createProfile("Mine", login.id);
    const other = createProfile("Other", login.id);
    actAs(login, mine);

    await logTemperature(
      fd({ temperature: "101.0", temp_unit: "F", date: DATE })
    );
    expect(tempRows(mine.id)).toHaveLength(1);
    expect(tempRows(other.id)).toHaveLength(0);
  });
});
