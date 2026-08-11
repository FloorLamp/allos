// DB INTEGRATION TIER — the #1680 trying-to-conceive stores and the assembled state.
//
// The point of these assertions is the "reuse an existing store" rule: each observation
// must land in its SHIPPED table (medical_records / metric_samples / symptom_logs), with
// the shared substrate's accounting (classifyUpsert → inserted/updated/unchanged) and the
// #133 edit lock honoured. It also carries the #448 end-to-end fixture for the workup
// coaching builder (registered prefix, coaching tier, no send of its own).

import { describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  BBT_METRIC,
  CERVICAL_MUCUS_SYMPTOM,
  LH_TEST_RECORD_NAME,
  TTC_WORKUP_PREFIX,
  mucusOrdinal,
} from "@/lib/ttc";
import {
  getTtcState,
  latestTtcObservations,
  listBbtReadings,
  listLhTests,
  listMucusObservations,
  logBbtCore,
  logLhTestCore,
  logMucusCore,
  ttcObservationKey,
} from "@/lib/ttc-store";
import {
  EMPTY_RISK_ATTRIBUTES,
  setRiskAttributes,
  setTtcStart,
  setProfileBirthdate,
} from "@/lib/settings";
import {
  buildTtcWorkupFindings,
  collectCoachingFindings,
} from "@/lib/rule-findings";
import {
  dedupeKeyHasKnownPrefix,
  tierForDedupeKey,
} from "@/lib/rule-finding-prefixes";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

const WINDOW_START = "1900-01-01"; // read everything; the fixtures are relative

describe("LH tests reuse medical_records", () => {
  it("stores a dated test result and counts the upsert dispositions", () => {
    const p = newProfile("ttc-lh");
    const d = today(p);

    const first = logLhTestCore(p, d, "negative");
    expect(first.kind).toBe("logged");
    if (first.kind === "logged") expect(first.counts.inserted).toBe(1);

    // Re-logging the same result writes nothing new and reports `unchanged`.
    const again = logLhTestCore(p, d, "negative");
    if (again.kind === "logged") {
      expect(again.counts.unchanged).toBe(1);
      expect(again.counts.inserted).toBe(0);
    }

    // A correction UPDATES the same row rather than minting a second one.
    const corrected = logLhTestCore(p, d, "positive");
    if (corrected.kind === "logged") expect(corrected.counts.updated).toBe(1);

    const rows = db
      .prepare(
        `SELECT category, value, canonical_name, source FROM medical_records
          WHERE profile_id = ? AND name = ?`
      )
      .all(p, LH_TEST_RECORD_NAME) as {
      category: string;
      value: string;
      canonical_name: string | null;
      source: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe("positive");
    expect(rows[0].category).toBe("lab");
    expect(rows[0].source).toBe("manual");
    // NO canonical name: a urine strip must never be read against serum LH ranges.
    expect(rows[0].canonical_name).toBeNull();

    expect(listLhTests(p, WINDOW_START)).toEqual([
      { date: d, result: "positive" },
    ]);
  });

  it("refuses to overwrite a hand-corrected (edit-locked) row", () => {
    const p = newProfile("ttc-lh-locked");
    const d = today(p);
    logLhTestCore(p, d, "negative");
    db.prepare(
      `UPDATE medical_records SET edited = 1 WHERE profile_id = ? AND name = ?`
    ).run(p, LH_TEST_RECORD_NAME);

    expect(logLhTestCore(p, d, "positive").kind).toBe("locked");
    expect(listLhTests(p, WINDOW_START)[0].result).toBe("negative");
  });
});

describe("BBT reuses metric_samples", () => {
  it("stores canonical °F under the manual natural key, one row per day", () => {
    const p = newProfile("ttc-bbt");
    const d = today(p);

    expect(logBbtCore(p, d, 97.3).kind).toBe("logged");
    const second = logBbtCore(p, d, 97.9);
    if (second.kind === "logged") expect(second.counts.updated).toBe(1);

    const rows = db
      .prepare(
        `SELECT source, origin, start_time, value FROM metric_samples
          WHERE profile_id = ? AND metric = ?`
      )
      .all(p, BBT_METRIC) as {
      source: string;
      origin: string | null;
      start_time: string;
      value: number;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("manual");
    expect(rows[0].origin).toBeNull();
    expect(rows[0].start_time).toBe(`${d}T00:00:00`);
    expect(rows[0].value).toBe(97.9);

    expect(listBbtReadings(p, WINDOW_START)).toEqual([{ date: d, degF: 97.9 }]);
  });

  it("refuses an implausible waking temperature without writing", () => {
    const p = newProfile("ttc-bbt-bounds");
    const out = logBbtCore(p, today(p), 36.6); // a °C value typed into a °F field
    expect(out.kind).toBe("invalid");
    expect(listBbtReadings(p, WINDOW_START)).toEqual([]);
  });

  it("honours the edit lock on a corrected sample", () => {
    const p = newProfile("ttc-bbt-locked");
    const d = today(p);
    logBbtCore(p, d, 97.3);
    db.prepare(
      `UPDATE metric_samples SET edited = 1 WHERE profile_id = ? AND metric = ?`
    ).run(p, BBT_METRIC);
    expect(logBbtCore(p, d, 98.1).kind).toBe("locked");
    expect(listBbtReadings(p, WINDOW_START)[0].degF).toBe(97.3);
  });
});

describe("cervical mucus reuses symptom_logs", () => {
  it("stores the quality as its ordinal severity on the shared symptom row", () => {
    const p = newProfile("ttc-mucus");
    const d = today(p);

    const first = logMucusCore(p, d, "creamy");
    if (first.kind === "logged") expect(first.counts.inserted).toBe(1);
    const same = logMucusCore(p, d, "creamy");
    if (same.kind === "logged") expect(same.counts.unchanged).toBe(1);

    // An explicit correction may LOWER the ordinal — the observation is categorical, not a
    // day's worst severity.
    const lowered = logMucusCore(p, d, "dry");
    if (lowered.kind === "logged") expect(lowered.counts.updated).toBe(1);

    const rows = db
      .prepare(
        `SELECT severity FROM symptom_logs
          WHERE profile_id = ? AND symptom = ? AND date = ?`
      )
      .all(p, CERVICAL_MUCUS_SYMPTOM, d) as { severity: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe(mucusOrdinal("dry"));
    expect(listMucusObservations(p, WINDOW_START)).toEqual([
      { date: d, quality: "dry" },
    ]);
  });
});

describe("getTtcState — the assembled gather", () => {
  // Six regular cycles ending with a period 20 days ago, so the calendar forecast exists
  // and the current cycle is mid-way through.
  function seedRegularCycles(profileId: number, lastStartAgo: number): void {
    const anchor = today(profileId);
    let ago = lastStartAgo + 28 * 6;
    for (let i = 0; i < 7; i++) {
      db.prepare(
        `INSERT INTO cycles (profile_id, period_start, period_end, flow)
         VALUES (?, ?, ?, 'medium')`
      ).run(
        profileId,
        shiftDateStr(anchor, -ago),
        shiftDateStr(anchor, -(ago - 4))
      );
      ago -= 28;
    }
  }

  it("is entirely off until the user declares a start", () => {
    const p = newProfile("ttc-undeclared");
    seedRegularCycles(p, 20);
    logMucusCore(p, today(p), "egg_white"); // an observation is NOT a declaration
    const s = getTtcState(p, today(p));
    expect(s.ttcStart).toBeNull();
    expect(s.active).toBe(false);
    expect(s.duration).toBeNull();
  });

  it("ranks an LH positive over the calendar estimate", () => {
    const p = newProfile("ttc-window");
    seedRegularCycles(p, 20);
    setTtcStart(p, shiftDateStr(today(p), -200));

    const calendarOnly = getTtcState(p, today(p));
    expect(calendarOnly.active).toBe(true);
    expect(calendarOnly.window?.evidence).toBe("calendar");

    logLhTestCore(p, today(p), "positive");
    const withSurge = getTtcState(p, today(p));
    expect(withSurge.window?.evidence).toBe("lh");
    expect(withSurge.todayLh).toBe("positive");
  });

  it("confirms ovulation from a temp shift inside the current cycle", () => {
    const p = newProfile("ttc-confirm");
    const anchor = today(p);
    seedRegularCycles(p, 20);
    setTtcStart(p, shiftDateStr(anchor, -100));
    // Six baseline mornings then three elevated ones, all inside the current cycle.
    const temps = [97.3, 97.2, 97.4, 97.3, 97.2, 97.3, 97.9, 98.0, 97.9];
    temps.forEach((t, i) => logBbtCore(p, shiftDateStr(anchor, -19 + i), t));

    const s = getTtcState(p, anchor);
    expect(s.confirmation).not.toBeNull();
    expect(s.confirmation?.ovulationDate).toBe(shiftDateStr(anchor, -14));
    expect(s.confirmation?.baselineF).toBe(97.4);
  });

  it("stops everything while a pregnancy is recorded, keeping the declared start", () => {
    const p = newProfile("ttc-pregnant");
    seedRegularCycles(p, 20);
    const declared = shiftDateStr(today(p), -300);
    setTtcStart(p, declared);
    logLhTestCore(p, today(p), "positive");
    setRiskAttributes(p, { ...EMPTY_RISK_ATTRIBUTES, pregnant: true });

    const s = getTtcState(p, today(p));
    expect(s.pregnant).toBe(true);
    expect(s.active).toBe(false);
    expect(s.window).toBeNull();
    expect(s.confirmation).toBeNull();
    expect(s.ttcStart).toBe(declared); // retained for history
  });

  it("counts the cycles attempted since the declared start", () => {
    const p = newProfile("ttc-count");
    seedRegularCycles(p, 20);
    // Declared just before the last two period starts.
    setTtcStart(p, shiftDateStr(today(p), -60));
    const s = getTtcState(p, today(p));
    expect(s.duration?.cyclesAttempted).toBe(2);
  });
});

describe("latestTtcObservations — one canonical identity per kind", () => {
  it("keys on the observation kind and takes the newest per kind", () => {
    const rows = [
      {
        id: 1,
        date: "2019-05-01",
        kind: "lh" as const,
        lhResult: "negative" as const,
      },
      {
        id: 2,
        date: "2019-05-04",
        kind: "lh" as const,
        lhResult: "positive" as const,
      },
      { id: 3, date: "2019-05-03", kind: "bbt" as const, degF: 97.6 },
    ];
    expect(ttcObservationKey(rows[0])).toBe("lh");
    const latest = latestTtcObservations(rows);
    expect(latest.get("lh")?.date).toBe("2019-05-04");
    expect(latest.get("bbt")?.degF).toBe(97.6);
    expect(latest.get("mucus")).toBeUndefined();
  });
});

describe("the workup prompt is coaching-tier and stays there (#448 fixture)", () => {
  it("emits at the threshold with its registered prefix, and joins the coaching set", () => {
    const p = newProfile("ttc-workup");
    const anchor = today(p);
    // An adult profile (birthdate well before the age line) declared as trying 13 months
    // ago — past the 12-month threshold. Relative dates only.
    setProfileBirthdate(p, shiftDateStr(anchor, -365 * 31));
    setTtcStart(p, shiftDateStr(anchor, -400));

    const findings = buildTtcWorkupFindings(p, anchor);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.dedupeKey.startsWith(TTC_WORKUP_PREFIX)).toBe(true);
    expect(dedupeKeyHasKnownPrefix(f.dedupeKey)).toBe(true);
    expect(tierForDedupeKey(f.dedupeKey)).toBe("coaching");
    expect(f.tone).toBe("info");

    const coaching = collectCoachingFindings(p, anchor, "kg");
    expect(coaching.some((c) => c.dedupeKey === f.dedupeKey)).toBe(true);
  });

  it("says nothing before the threshold, and nothing without a declaration", () => {
    const p = newProfile("ttc-workup-quiet");
    const anchor = today(p);
    setProfileBirthdate(p, shiftDateStr(anchor, -365 * 31));
    expect(buildTtcWorkupFindings(p, anchor)).toEqual([]);

    setTtcStart(p, shiftDateStr(anchor, -100)); // ~3 months
    expect(buildTtcWorkupFindings(p, anchor)).toEqual([]);
  });

  it("says nothing for a minor profile, whatever is declared", () => {
    const p = newProfile("ttc-workup-minor");
    const anchor = today(p);
    setProfileBirthdate(p, shiftDateStr(anchor, -365 * 15));
    setTtcStart(p, shiftDateStr(anchor, -600));
    expect(buildTtcWorkupFindings(p, anchor)).toEqual([]);
  });
});
