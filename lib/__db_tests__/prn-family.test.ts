// DB INTEGRATION TIER — the #1027 cross-item PRN safety counters, end-to-end over the
// issue's own two-ibuprofen fixture: OTC ibuprofen (confirmed interval/max, opted in)
// alongside Rx ibuprofen 800 mg (a second item, same ingredient). Before #1027 every
// counter was strictly per-item, so the OTC dose an hour ago was invisible to the Rx
// item — a false "you may redose" GO in the dangerous direction. These tests pin:
//   • the family gather (getMedicationFamilyStates) — one family, combined counters;
//   • the redose ORCHESTRATOR held by a sibling's dose (runRedoseNotices, real
//     dispatch through the stubbed-fetch HA channel — the prn-redose-notify harness);
//   • the family over-max care finding (combined count vs the most conservative max)
//     and its Upcoming twin;
//   • the coaching-tier therapeutic-duplication note with a registry-parsing key.
//
// Every value is synthetic (fake meds + a fake HA webhook URL; no phones, no PHI).

import { describe, it, expect, afterEach, vi } from "vitest";
import { db, today } from "@/lib/db";
import { TIER_FROZEN_INSTANT } from "./frozen-clock";
import {
  setProfileHomeAssistant,
  getProfileSetting,
  setProfileSetting,
} from "@/lib/settings";
import {
  parseUtcSql,
  shiftDateStr,
  utcInstant,
  utcSqlString,
} from "@/lib/date";
import { runRedoseNotices, redoseMarkerKey } from "@/lib/notifications/redose";
import {
  markDoseTaken,
  restampDoseLogsCore,
  setDoseStatusCore,
} from "@/lib/queries/intake/adherence";
import {
  collectUpcoming,
  dismissFinding,
  getFindingSuppressions,
  getMedicationFamilyStates,
  getPrnMedicationsForQuickLog,
  getRedoseArmingState,
  getPrnOverMaxItems,
} from "@/lib/queries";
import { activeFindings } from "@/lib/findings";
import {
  prnMaxSignalKey,
  prnQuickLogRedoseStatus,
  redoseNoticeDecision,
  PRN_MAX_PREFIX,
} from "@/lib/prn-redose";
import { redoseActionIsPrimary, redoseCardLabel } from "@/lib/redose-format";
import { SUPPRESSION_DISPLAY_PREFIXES } from "@/lib/suppression-display";
import { buildMedicationDuplicationFindings } from "@/lib/rule-findings";
import {
  dedupeKeyHasKnownPrefix,
  tierForDedupeKey,
} from "@/lib/rule-finding-prefixes";
import { MED_DUP_PREFIX, medDupSignalKey } from "@/lib/medication-family";

const HA_URL = "http://homeassistant.local:8123/api/webhook/allos-prn-family";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function configureHA(profileId: number): void {
  setProfileHomeAssistant(profileId, {
    enabled: true,
    webhookUrl: HA_URL,
    secret: "",
    disabledKinds: [],
  });
}

function stubFetch(): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

// A PRN medication + its primary dose row. Confirmed interval/max + opt-in are
// per-case knobs.
function seedMed(
  profileId: number,
  name: string,
  opts: {
    amount?: string;
    redoseNotice?: number;
    minInterval?: number | null;
    maxDaily?: number | null;
    maxDailyMg?: number | null;
  } = {}
): { itemId: number; doseId: number } {
  const {
    amount = "200 mg",
    redoseNotice = 0,
    minInterval = null,
    maxDaily = null,
    maxDailyMg = null,
  } = opts;
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation, redose_notice, min_interval_hours, max_daily_count, max_daily_amount_mg)
         VALUES (?, ?, 1, 'medication', 'daily', 'may', ?, ?, ?, ?)`
      )
      .run(profileId, name, redoseNotice, minInterval, maxDaily, maxDailyMg)
      .lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, ?, 'anytime', 'any', 0)`
      )
      .run(itemId, amount).lastInsertRowid
  );
  return { itemId, doseId };
}

function logAdmin(
  itemId: number,
  doseId: number,
  date: string,
  hoursAgo: number,
  now: Date,
  // The snapshotted amount (#797's confirm-dose invariant; what the real
  // logAdministration stamps from the dose row). Null = a legacy/amount-less row.
  amount: string | null = null
): number {
  // A REAL administration STATES its instant: `logAdministration` writes both columns,
  // and since #4686 the ceiling window judges `occurred_at` (a row that states none is
  // anchored at its day's noon instead), so a fixture that wrote only the capture stamp
  // would be exercising the untimed arm while claiming to be a timed dose.
  const at = new Date(now.getTime() - hoursAgo * 3_600_000);
  const recordedAt = utcSqlString(at);
  return Number(
    db
      .prepare(
        `INSERT INTO intake_item_logs
           (dose_id, item_id, date, recorded_at, occurred_at, status, amount)
         VALUES (?, ?, ?, ?, ?, 'taken', ?)`
      )
      .run(doseId, itemId, date, recordedAt, utcInstant(at), amount)
      .lastInsertRowid
  );
}

// The issue's fixture: OTC ibuprofen (confirmed 6h interval / max 4, opted in) + Rx
// ibuprofen 800 mg (unconfirmed fields — the liability gate keeps its own notice off).
function seedIbuprofenPair(profileId: number) {
  const otc = seedMed(profileId, "Ibuprofen", {
    amount: "200 mg",
    redoseNotice: 1,
    minInterval: 6,
    maxDaily: 4,
  });
  const rx = seedMed(profileId, "Ibuprofen 800 mg", { amount: "800 mg" });
  return { otc, rx };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getMedicationFamilyStates — the two-ibuprofen family (#1027)", () => {
  it("partitions both items into ONE family with combined counters", () => {
    const p = newProfile("FamState");
    const { otc, rx } = seedIbuprofenPair(p);
    const now = new Date();
    const date = today(p);
    logAdmin(otc.itemId, otc.doseId, date, 8, now);
    const rxAdmin = logAdmin(rx.itemId, rx.doseId, date, 1, now);

    const states = getMedicationFamilyStates(p);
    const state = states.get(otc.itemId)!;
    expect(state).toBeTruthy();
    expect(states.get(rx.itemId)!.familyKey).toBe(state.familyKey);
    expect(state.memberIds.sort()).toEqual([otc.itemId, rx.itemId].sort());
    // The family's latest administration is the Rx dose an hour ago, and the
    // combined count spans both items.
    expect(state.latestId).toBe(rxAdmin);
    expect(state.latestItemId).toBe(rx.itemId);
    expect(state.count24h).toBe(2);
    expect(state.minConfirmedMax).toBe(4);
  });

  it("an unrelated med stays its own family", () => {
    const p = newProfile("FamUnrelated");
    seedIbuprofenPair(p);
    const other = seedMed(p, "Acetaminophen");
    const states = getMedicationFamilyStates(p);
    expect(states.get(other.itemId)!.memberIds).toEqual([other.itemId]);
  });
});

describe("runRedoseNotices — the sibling dose holds the notice (#1027)", () => {
  it("an Rx ibuprofen dose an hour ago holds the OTC item's notice; it fires from THAT dose's clock", async () => {
    const p = newProfile("FamHold");
    const { otc, rx } = seedIbuprofenPair(p);
    const now = new Date();
    const date = today(p);
    // The OTC item's OWN last dose is 8h back (its per-item window would be open) —
    // but the Rx sibling dosed 1h ago, so the family clock holds the notice.
    logAdmin(otc.itemId, otc.doseId, date, 8, now);
    const rxAdmin = logAdmin(rx.itemId, rx.doseId, date, 1, now);
    configureHA(p);
    const fetchMock = stubFetch();

    await runRedoseNotices(p, "FamHold", date, now);
    expect(fetchMock).not.toHaveBeenCalled(); // the pre-#1027 false GO
    expect(getProfileSetting(p, redoseMarkerKey(otc.itemId))).toBeUndefined();

    // Six hours later the interval has cleared from the SIBLING's dose — the notice
    // fires once, armed by (and marker-keyed to) that administration.
    const later = new Date(now.getTime() + 6 * 3_600_000);
    await runRedoseNotices(p, "FamHold", date, later);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getProfileSetting(p, redoseMarkerKey(otc.itemId))).toBe(
      String(rxAdmin)
    );
    // The body names the med the arming dose belongs to (honest attribution).
    const body = String(fetchMock.mock.calls[0]?.[1]?.body ?? "");
    expect(body).toContain("Ibuprofen 800 mg");

    // Same state, next tick → one-shot done, no re-send.
    await runRedoseNotices(p, "FamHold", date, later);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("the mg ceiling suppresses the notice when the summed amounts are at max even though the count reads calm (#1854)", async () => {
    const p = newProfile("FamMgCeiling");
    const { otc, rx } = seedIbuprofenPair(p); // OTC: 6h interval, count max 4, opted in
    db.prepare(
      "UPDATE intake_items SET max_daily_amount_mg = 1200 WHERE id = ?"
    ).run(otc.itemId);
    const now = new Date();
    const date = today(p);
    // 3 × 800 mg = 2400 mg ≥ 1200 mg/day, while "3 of 4 doses" would have fired.
    for (const h of [12, 10, 7])
      logAdmin(rx.itemId, rx.doseId, date, h, now, "800 mg");
    configureHA(p);
    const fetchMock = stubFetch();

    await runRedoseNotices(p, "FamMgCeiling", date, now);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getProfileSetting(p, redoseMarkerKey(otc.itemId))).toBeUndefined();
  });
});

describe("family over-max care finding (#1027)", () => {
  it("fires on the COMBINED count vs the most conservative confirmed max, keyed to the confirmed item", () => {
    const p = newProfile("FamOverMax");
    const { otc, rx } = seedIbuprofenPair(p); // OTC max 4; Rx unconfirmed
    const now = new Date();
    const date = today(p);
    // 3 OTC + 2 Rx = 5 combined (> 4), while NEITHER item alone exceeds 4 — the
    // pre-#1027 per-item check could never fire here.
    for (const h of [12, 10, 8]) logAdmin(otc.itemId, otc.doseId, date, h, now);
    for (const h of [6, 2]) logAdmin(rx.itemId, rx.doseId, date, h, now);

    const items = getPrnOverMaxItems(p, date);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(otc.itemId); // anchored on the confirmed-max member
    expect(items[0].basis).toBe("count"); // no mg max confirmed → count fallback
    expect(items[0].total).toBe(5);
    expect(items[0].max).toBe(4);
    expect(items[0].memberNames).toEqual(
      expect.arrayContaining(["Ibuprofen", "Ibuprofen 800 mg"])
    );

    // The Upcoming twin carries the combined framing and the stable per-item key.
    const up = collectUpcoming(p, date).find(
      (u) => u.key === prnMaxSignalKey(otc.itemId)
    );
    expect(up).toBeTruthy();
    expect(up!.detail).toContain("across");
    expect(up!.detail).toContain("Ibuprofen 800 mg");
    // The copy states the basis actually used (#1854): doses, not milligrams.
    expect(up!.detail).toContain("5 doses logged in 24h");
  });

  it("a solo item keeps the exact pre-#1027 behavior", () => {
    const p = newProfile("SoloOverMax");
    const { itemId, doseId } = seedMed(p, "Loratadine", {
      minInterval: 24,
      maxDaily: 1,
    });
    const now = new Date();
    const date = today(p);
    logAdmin(itemId, doseId, date, 10, now);
    logAdmin(itemId, doseId, date, 2, now);
    const items = getPrnOverMaxItems(p, date);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: itemId,
      basis: "count",
      total: 2,
      max: 1,
    });
    expect(items[0].memberNames).toBeUndefined();
  });
});

// ---- Amount-aware mg accounting (#1854) over the SAME mixed-strength family ----
//
// The issue's own numbers: OTC ibuprofen 200 mg + Rx ibuprofen 800 mg are ONE
// family (#1027), so a "dose" spans a 4× strength range and counting rows
// misreports exposure in both directions. With a confirmed mg/day max and the
// snapshotted per-log amounts, the counters sum MILLIGRAMS; the count stays the
// fallback when an amount doesn't parse.
describe("family over-max care finding — mg basis (#1854)", () => {
  // A mixed-strength pair with the ADULT OTC ceiling confirmed in mg on the OTC
  // member (1200 mg/day) alongside a loose count max of 6.
  function seedMgPair(p: number) {
    const otc = seedMed(p, "Ibuprofen", {
      amount: "200 mg",
      minInterval: 6,
      maxDaily: 6,
      maxDailyMg: 1200,
    });
    const rx = seedMed(p, "Ibuprofen 800 mg", { amount: "800 mg" });
    return { otc, rx };
  }

  it("under-report fixed: 3 × 800 mg = 2400 mg fires the mg finding while the count reads a calm 3 of 6", () => {
    const p = newProfile("MgUnder");
    const { otc, rx } = seedMgPair(p);
    const now = new Date();
    const date = today(p);
    for (const h of [10, 6, 2])
      logAdmin(rx.itemId, rx.doseId, date, h, now, "800 mg");

    const state = getMedicationFamilyStates(p).get(otc.itemId)!;
    expect(state.minConfirmedMaxMg).toBe(1200);
    expect(state.exposure).toMatchObject({
      basis: "mg",
      total: 2400,
      max: 1200,
      over: true,
      unknownAmounts: 0,
    });

    const items = getPrnOverMaxItems(p, date);
    expect(items).toHaveLength(1);
    // Anchored on the member holding the binding mg max; the key namespace is the
    // registered `prn-max:` finding prefix (dismiss bus + suppression registry).
    expect(items[0].id).toBe(otc.itemId);
    expect(items[0]).toMatchObject({ basis: "mg", total: 2400, max: 1200 });

    const key = prnMaxSignalKey(otc.itemId);
    expect(key.startsWith(PRN_MAX_PREFIX)).toBe(true);
    expect(SUPPRESSION_DISPLAY_PREFIXES).toContain(PRN_MAX_PREFIX);
    const up = collectUpcoming(p, date).find((u) => u.key === key)!;
    expect(up).toBeTruthy();
    expect(up.domain).toBe("prn-max");
    // End-to-end copy: milligram basis stated, both members named, never a
    // dose-count framing.
    expect(up.detail).toContain("2400 mg logged in 24h");
    expect(up.detail).toContain("max of 1200 mg per 24h");
    expect(up.detail).toContain("Ibuprofen 800 mg");
    expect(up.detail).not.toContain("doses logged");
  });

  it("over-report fixed: 5 × 200 mg = 1000 mg stays calm although the count max of 4 would have tripped", () => {
    const p = newProfile("MgOver");
    const { otc } = seedMgPair(p);
    const now = new Date();
    const date = today(p);
    // Tighten the count max to the pre-#1854 trip point.
    db.prepare("UPDATE intake_items SET max_daily_count = 4 WHERE id = ?").run(
      otc.itemId
    );
    for (const h of [12, 10, 8, 5, 2])
      logAdmin(otc.itemId, otc.doseId, date, h, now, "200 mg");

    const state = getMedicationFamilyStates(p).get(otc.itemId)!;
    expect(state.exposure).toMatchObject({
      basis: "mg",
      total: 1000,
      max: 1200,
      over: false,
    });
    expect(getPrnOverMaxItems(p, date)).toHaveLength(0);
  });

  it("count remains the fallback when an administration's amount doesn't parse", () => {
    const p = newProfile("MgFallback");
    const { otc, rx } = seedMgPair(p);
    const now = new Date();
    const date = today(p);
    db.prepare("UPDATE intake_items SET max_daily_count = 4 WHERE id = ?").run(
      otc.itemId
    );
    for (const h of [12, 10, 8, 5])
      logAdmin(otc.itemId, otc.doseId, date, h, now, "200 mg");
    logAdmin(rx.itemId, rx.doseId, date, 2, now, "1 tablet"); // unparseable

    const items = getPrnOverMaxItems(p, date);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ basis: "count", total: 5, max: 4 });
    const up = collectUpcoming(p, date).find(
      (u) => u.key === prnMaxSignalKey(otc.itemId)
    )!;
    expect(up.detail).toContain("5 doses logged in 24h");
    expect(up.detail).not.toContain("mg logged in 24h");
  });

  it("mg lower bound when NO count fallback exists: known amounts already past the ceiling read 'at least'", () => {
    const p = newProfile("MgLowerBound");
    const otc = seedMed(p, "Ibuprofen", {
      amount: "200 mg",
      maxDailyMg: 1200, // mg max only — no count max anywhere in the family
    });
    const rx = seedMed(p, "Ibuprofen 800 mg", { amount: "800 mg" });
    const now = new Date();
    const date = today(p);
    logAdmin(rx.itemId, rx.doseId, date, 8, now, "800 mg");
    logAdmin(rx.itemId, rx.doseId, date, 4, now, "800 mg");
    logAdmin(otc.itemId, otc.doseId, date, 2, now, "1 tablet"); // unknown mg

    const items = getPrnOverMaxItems(p, date);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      basis: "mg",
      total: 1600,
      max: 1200,
      unknownAmounts: 1,
    });
    const up = collectUpcoming(p, date).find(
      (u) => u.key === prnMaxSignalKey(otc.itemId)
    )!;
    expect(up.detail).toContain("At least 1600 mg logged in 24h");
    expect(up.detail).toContain("1 dose had no recorded amount");
  });
});

describe("therapeutic-duplication note (#1027 ask 3, coaching tier)", () => {
  it("emits ONE hideable observation per multi-item family with a registry-parsing key", () => {
    const p = newProfile("FamDup");
    seedIbuprofenPair(p);
    seedMed(p, "Acetaminophen"); // solo — no note

    const findings = buildMedicationDuplicationFindings(p);
    expect(findings).toHaveLength(1);
    // A one-strength-one-without pair cannot be proven indistinguishable (#3069),
    // so the ORIGINAL #1027 copy renders, reassurance included.
    expect(findings[0].title).toContain("Ibuprofen appears in 2 active");
    expect(findings[0].detail).toContain("share the same active ingredient");
    expect(findings[0].evidence).toContain("often deliberate");
    expect(findings[0].dedupeKey.startsWith(MED_DUP_PREFIX)).toBe(true);
    expect(dedupeKeyHasKnownPrefix(findings[0].dedupeKey)).toBe(true);
    // Coaching tier (#449): calm — never a notification, never the hero.
    expect(tierForDedupeKey(findings[0].dedupeKey)).toBe("coaching");
    // And it is NOT an Upcoming item (coaching findings stay off Upcoming).
    expect(
      collectUpcoming(p, today(p)).some((u) => u.key.startsWith(MED_DUP_PREFIX))
    ).toBe(false);
  });

  // #3069 — the observed triplicate-import family through the REAL builder: three
  // active `albuterol` items (one name key, no strengths) plus the profile's
  // `Albuterol Sulfate` (a different name key — its own family, no note). The
  // indistinguishable trio renders as duplicate RECORDS, never as a lifestyle
  // choice; the family math and the dismissal key are untouched.
  it("an indistinguishable family reads as duplicate records; the family math and the dismissal keep working", () => {
    const p = newProfile("FamDupRecords");
    const a1 = seedMed(p, "albuterol", { minInterval: 4, maxDaily: 6 });
    const a2 = seedMed(p, "albuterol");
    const a3 = seedMed(p, "albuterol");
    seedMed(p, "Albuterol Sulfate"); // distinct name key — solo family, no note

    const findings = buildMedicationDuplicationFindings(p);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.title).toBe("Albuterol is recorded 3 times");
    expect(f.detail).toBe(
      "Most likely one medication imported more than once. Their doses " +
        "already count as one toward the redose window, so nothing is " +
        "over-counted."
    );
    // No "often deliberate" rationalization anywhere on the note.
    for (const text of [f.title, f.detail ?? "", f.evidence ?? ""]) {
      expect(text).not.toContain("often deliberate");
      expect(text).not.toContain("albuterol + albuterol");
    }
    // Action → the medications page, where an extra can be stopped or deleted.
    expect(f.actionHref).toBe("/medications");
    // Same key namespace / tier / posture as before the copy split.
    expect(f.dedupeKey.startsWith(MED_DUP_PREFIX)).toBe(true);
    expect(tierForDedupeKey(f.dedupeKey)).toBe("coaching");
    expect(
      collectUpcoming(p, today(p)).some((u) => u.key.startsWith(MED_DUP_PREFIX))
    ).toBe(false);

    // The protective half is UNCHANGED: all three duplicates are one family, so
    // a dose on one member arms the shared redose clock and today's count spans
    // the trio (their doses count as ONE stream — nothing over-counted).
    const now = new Date();
    const date = today(p);
    logAdmin(a1.itemId, a1.doseId, date, 8, now);
    const arming = logAdmin(a2.itemId, a2.doseId, date, 1, now);
    const state = getMedicationFamilyStates(p).get(a3.itemId)!;
    expect(state.memberIds.sort()).toEqual(
      [a1.itemId, a2.itemId, a3.itemId].sort()
    );
    expect(state.latestId).toBe(arming);
    expect(state.count24h).toBe(2);
    expect(state.minConfirmedMax).toBe(6);

    // A dismissal recorded against the family key (as before the copy change)
    // still suppresses the re-rendered finding — the dedupeKey did not move.
    expect(f.dedupeKey).toBe(medDupSignalKey(state.familyKey));
    dismissFinding(p, f.dedupeKey);
    const after = activeFindings(
      buildMedicationDuplicationFindings(p),
      getFindingSuppressions(p),
      date
    );
    expect(after).toEqual([]);
  });
});

// ── The ceiling window is the trailing 24 HOURS (#4686) ───────────────────────
//
// Every `maxDailyCount` in the app is a public Drug Facts figure that reads "no more
// than N doses IN 24 HOURS", and the gather judged it on the profile-local calendar
// DAY. The two disagree only across midnight — which is the fevered-child-overnight
// case this cockpit exists for — so the fixture below is the one shape that separates
// them: five doses inside 17 hours, three of them before midnight.
describe("PRN ceilings judge the trailing 24h, not the calendar day (#4686)", () => {
  // 09:16 on the tier's frozen day (the reported screenshot's own clock), so last
  // night's doses are hours old and still inside the label's 24-hour cap.
  const MORNING = new Date(
    `${TIER_FROZEN_INSTANT.toISOString().slice(0, 10)}T09:16:00.000Z`
  );

  function seedAcetaminophen(p: number) {
    return seedMed(p, "Acetaminophen", {
      amount: "500 mg",
      redoseNotice: 1,
      minInterval: 4,
      maxDaily: 5,
    });
  }

  function cardLabel(profileId: number, now: Date): string | null {
    const med = getPrnMedicationsForQuickLog(profileId)[0]!;
    return redoseCardLabel(prnQuickLogRedoseStatus(med, now), 1);
  }

  it("the screenshot's own case: last evening's dose still counts this morning", () => {
    vi.setSystemTime(MORNING);
    const p = newProfile("Win24Screenshot");
    const med = seedAcetaminophen(p);
    const yesterday = shiftDateStr(today(p), -1);
    // 19:15 last night — 14h before 09:16, well inside 24h.
    logAdmin(med.itemId, med.doseId, yesterday, 14.02, MORNING, "500 mg");

    const state = getMedicationFamilyStates(p).get(med.itemId)!;
    expect(state.count24h).toBe(1);
    expect(cardLabel(p, MORNING)).toContain("1 of 5 in 24h");
  });

  // A NINE-DIGIT EPOCH IS NOT A SMALLER STRING THAN A TEN-DIGIT ONE. The window
  // predicate compares `strftime('%s', …)`, which returns TEXT — so a bare `>=` is a
  // text comparison, right for every 10-digit epoch and inverted below 2001-09-09,
  // where '999907200' sorts ABOVE '1788254160'. A legacy or mis-stamped
  // administration would then be judged INSIDE the trailing window and counted
  // against the ceiling forever, which is the direction that fabricates a
  // "Max reached" nobody earned. Both windows CAST; this is what the CAST is for.
  it("an ancient administration instant falls OUTSIDE the window, not above it", () => {
    vi.setSystemTime(MORNING);
    const p = newProfile("Win24Ancient");
    const med = seedAcetaminophen(p);
    const t = today(p);
    // One real dose this morning, and one stamped in 1999 — a 9-digit epoch.
    logAdmin(med.itemId, med.doseId, t, 5.27, MORNING, "500 mg");
    db.prepare(
      `INSERT INTO intake_item_logs
         (dose_id, item_id, date, recorded_at, occurred_at, status, amount)
       VALUES (?, ?, '1999-06-01', '1999-06-01T08:00:00Z',
               '1999-06-01T08:00:00Z', 'taken', '500 mg')`
    ).run(med.doseId, med.itemId);

    // The window holds the morning dose and nothing else.
    expect(getMedicationFamilyStates(p).get(med.itemId)!.count24h).toBe(1);
    expect(getRedoseArmingState(p, med.itemId).count24h).toBe(1);
  });

  // AN UNTIMED ROW IS JUDGED AT ITS OWN DAY, NEVER AT ITS CAPTURE STAMP. A scheduled
  // check-off states no administration instant, and `applyDoseStatusCore` used to
  // stamp `occurred_at` with the CAPTURE clock — so a parent catching up on the two
  // scheduled days they missed put three "administrations" inside today's trailing
  // window and the card read `Max reached · 3 of 3 in 24h` off ONE real dose. Families
  // union by name, so the scheduled Ibuprofen and the PRN Ibuprofen are one family and
  // one ceiling. "Max reached" is the line that tells a parent not to treat a fevered
  // child, so a restrictive lie is still a lie on a safety surface.
  it("a past-day scheduled check-off does not count against today's ceiling", () => {
    vi.setSystemTime(MORNING);
    const p = newProfile("Win24Catchup");
    const prn = seedMed(p, "Ibuprofen", {
      amount: "200 mg",
      minInterval: 4,
      maxDaily: 3,
    });
    // The scheduled sibling: same ingredient name, so one family and one ceiling.
    const sched = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, active, kind, condition, obligation)
           VALUES (?, 'Ibuprofen', 1, 'medication', 'daily', 'should')`
        )
        .run(p).lastInsertRowid
    );
    const schedDose = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
           VALUES (?, '200 mg', 'anytime', 'any', 0)`
        )
        .run(sched).lastInsertRowid
    );

    // ONE dose was actually given, this morning.
    logAdmin(prn.itemId, prn.doseId, today(p), 5.27, MORNING, "200 mg");
    // …then the parent checks off the two scheduled days they missed.
    const outcomes = [1, 2].map((back) =>
      markDoseTaken(p, schedDose, sched, shiftDateStr(today(p), -back), "page")
    );

    // Both check-offs LANDED (the fixture reaches the state, rather than being
    // refused into a vacuous pass — measured: outcomes were ["logged","logged"] and
    // the two past-day rows carried today's clock in `occurred_at`).
    expect(outcomes).toEqual(["logged", "logged"]);
    const state = getMedicationFamilyStates(p).get(prn.itemId)!;
    // TWO, and two is the rule applied rather than a softened assertion: this
    // morning's real dose, plus YESTERDAY's check-off, whose noon anchor (12:00)
    // genuinely falls inside a window that opened at 09:16 yesterday. The
    // day-before's noon does not, so it is out. Before the fix all THREE counted,
    // because each carried a capture stamp of this morning.
    expect(state.count24h).toBe(2);
    // The claim that matters is unchanged: a catch-up cannot reach the ceiling.
    expect(state.exposure?.atMax).toBe(false);
    const label = redoseCardLabel(
      prnQuickLogRedoseStatus(
        getPrnMedicationsForQuickLog(p).find((m) => m.id === prn.itemId)!,
        MORNING
      ),
      state.memberIds.length
    );
    expect(label).toContain("2 of 3 in 24h");
    expect(label).not.toContain("Max reached");
  });

  // THE SAME RULE ON THE TRANSITION ARM. `applyDoseStatusCore` has two writers: the
  // INSERT for a first resolution and the UPDATE for a correction. The tri-state's
  // ordinary skip→taken on a past day lands in the UPDATE, which stamped
  // `instantNow()` with no day check — so the identical catch-up, reached by
  // correcting a skip instead of by a first tap, put today's clock on a past row and
  // the ceiling counted it. Driven through `setDoseStatusCore` with a non-clear
  // `from`, because `markDoseTaken` is resolveOnly and returns before the UPDATE.
  it("a past-day skip CORRECTED to taken states no administration instant either", () => {
    vi.setSystemTime(MORNING);
    const p = newProfile("Win24Correct");
    const prn = seedMed(p, "Ibuprofen", {
      amount: "200 mg",
      minInterval: 4,
      maxDaily: 3,
    });
    const sched = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, active, kind, condition, obligation)
           VALUES (?, 'Ibuprofen', 1, 'medication', 'daily', 'should')`
        )
        .run(p).lastInsertRowid
    );
    const schedDose = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
           VALUES (?, '200 mg', 'anytime', 'any', 0)`
        )
        .run(sched).lastInsertRowid
    );

    logAdmin(prn.itemId, prn.doseId, today(p), 5.27, MORNING, "200 mg");
    // Skip the two missed days, then CORRECT both to taken — the transition arm.
    for (const back of [1, 2]) {
      const day = shiftDateStr(today(p), -back);
      setDoseStatusCore(p, schedDose, day, "skipped", "page");
      setDoseStatusCore(p, schedDose, day, "taken", "page");
    }

    // No corrected row claims an administration instant it cannot have.
    const stamped = db
      .prepare(
        `SELECT l.date AS date, l.occurred_at AS occurredAt
           FROM intake_item_logs l
          WHERE l.item_id = ? AND l.status = 'taken' ORDER BY l.date`
      )
      .all(sched) as { date: string; occurredAt: string | null }[];
    expect(stamped.map((r) => r.occurredAt)).toEqual([null, null]);

    const state = getMedicationFamilyStates(p).get(prn.itemId)!;
    // As in the first-tap case: this morning's real dose plus yesterday's noon anchor.
    expect(state.count24h).toBe(2);
    expect(state.exposure?.atMax).toBe(false);
  });

  it("five doses spanning midnight inside 24h reach the ceiling", () => {
    vi.setSystemTime(MORNING);
    const p = newProfile("Win24Ceiling");
    const med = seedAcetaminophen(p);
    const t = today(p);
    const y = shiftDateStr(t, -1);
    // 16:00 / 20:00 / 23:45 yesterday, then 01:00 / 04:00 — five doses in 17.3h.
    const sequence: [string, number][] = [
      [y, 17.27],
      [y, 13.27],
      [y, 9.52],
      [t, 8.27],
      [t, 5.27],
    ];
    let latestId = 0;
    for (const [day, hoursAgo] of sequence)
      latestId = logAdmin(
        med.itemId,
        med.doseId,
        day,
        hoursAgo,
        MORNING,
        "500 mg"
      );

    const state = getMedicationFamilyStates(p).get(med.itemId)!;
    expect(state.count24h).toBe(5);
    expect(state.exposure).toMatchObject({
      basis: "count",
      total: 5,
      max: 5,
      atMax: true,
    });

    // The notice's ceiling: the interval (4h) cleared five hours ago, so the ONLY
    // thing standing between this profile and a sixth "you may redose" is the max.
    expect(
      redoseNoticeDecision({
        minIntervalHours: 4,
        maxDailyCount: 5,
        latestAdministrationId: latestId,
        latestGivenAt: parseUtcSql(state.latestGivenAt),
        count24h: state.count24h,
        now: MORNING,
        notifiedAdministrationId: null,
        tickMinutes: 60,
        exposure: state.exposure,
      }).kind
    ).toBe("suppressed-max");

    // …and every card/quick-log/Telegram surface reads the same window.
    expect(cardLabel(p, MORNING)).toBe("Max reached · 5 of 5 in 24h");
  });
});

// ── REGRESSIONS AGAINST main (#4686 pass three) ──────────────────────────────
//
// Both of these are FALSE GOs on a redose interval — the app saying "Redose OK" when
// the minimum interval has not passed — so each asserts what `main` answers, and each
// must fail on the branch that broke it and pass on the commit before. That is what
// "regression" means, and asserting only the corrected value would not have said it.
describe("the arming clock never reads a GO main would refuse (#4686)", () => {
  const AT = (iso: string) => new Date(iso);
  const UNPLACED_NOW = AT("2026-09-02T09:16:00Z");

  function seedPrn(p: number, name: string) {
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, active, kind, condition, obligation,
              min_interval_hours, max_daily_count)
           VALUES (?, ?, 1, 'medication', 'daily', 'may', 6, 4)`
        )
        .run(p, name).lastInsertRowid
    );
    const doseId = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
           VALUES (?, '200 mg', 'anytime', 'any', 0)`
        )
        .run(itemId).lastInsertRowid
    );
    return { itemId, doseId };
  }

  // `date` IS THE ADHERENCE DAY, NOT A CLAIM ABOUT WHEN THE DOSE WAS GIVEN.
  // `restampDoseLogsCore` says so in its own header and returns `crossedMidnight` as a
  // first-class outcome, so narrowing the arming read to MAX(date) can miss the
  // genuinely-latest administration: a row filed to an EARLIER day can carry a LATER
  // stated instant. Four real hours after a 22:00 dose, that narrowing said go.
  it("a dose whose stated instant crossed midnight away from its day still arms it", () => {
    vi.setSystemTime(AT("2026-08-06T02:00:00Z"));
    const p = newProfile("ArmCrossMidnight");
    setProfileSetting(p, "timezone", "UTC");
    const med = seedPrn(p, "Ibuprofen");

    // Two administrations. The one filed to the LATER day was given at 18:00; the one
    // filed to the EARLIER day is restamped to 22:00 — the cross-midnight correction
    // the writer exists for. The true latest is 22:00.
    const early = Number(
      db
        .prepare(
          `INSERT INTO intake_item_logs
             (dose_id, item_id, date, recorded_at, occurred_at, status, amount)
           VALUES (?, ?, '2026-08-04', '2026-08-04T20:00:00Z',
                   '2026-08-04T20:00:00Z', 'taken', '200 mg')`
        )
        .run(med.doseId, med.itemId).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_item_logs
         (dose_id, item_id, date, recorded_at, occurred_at, status, amount)
       VALUES (?, ?, '2026-08-05', '2026-08-05T18:00:00Z',
               '2026-08-05T18:00:00Z', 'taken', '200 mg')`
    ).run(med.doseId, med.itemId);
    expect(
      restampDoseLogsCore(p, early, () => AT("2026-08-05T22:00:00Z"))
    ).toMatchObject({ kind: "restamped", crossedMidnight: true });

    const state = getMedicationFamilyStates(p).get(med.itemId)!;
    expect(state.latestGivenAt).toBe("2026-08-05T22:00:00Z");

    // 4h after a 22:00 dose against a 6h interval: the window is SHUT.
    const status = prnQuickLogRedoseStatus(
      getPrnMedicationsForQuickLog(p).find((m) => m.id === med.itemId)!,
      AT("2026-08-06T02:00:00Z")
    )!;
    expect(redoseCardLabel(status)).toContain("Next dose in ~2h");
    expect(redoseCardLabel(status)).not.toContain("Redose OK");
  });

  // THE COVERAGE THE FIXTURE REWRITE REMOVED. Making the seeded administrations state
  // their instants was right — production's writer states them — but it left the tree
  // with NO taken row carrying `occurred_at IS NULL` on the arming clock, which is
  // precisely the arm that then regressed. These two hold that arm directly: an
  // unplaced row is never a candidate for arming, and while it sits in the window it
  // makes the interval unknown even though a timed row is also present.
  it("an unplaced administration arms nothing and makes the interval unknown", () => {
    vi.setSystemTime(UNPLACED_NOW);
    const p = newProfile("Win24Unplaced");
    setProfileSetting(p, "timezone", "UTC");
    const med = seedPrn(p, "Acetaminophen");
    // A real dose seven hours ago, and an unplaced one filed to YESTERDAY — whose
    // noon anchor is the one inside a window that opened at 09:16 yesterday. (A row
    // dated TODAY would not be in the window until local noon; that boundary is the
    // under-count this PR reports rather than fixes.)
    logAdmin(med.itemId, med.doseId, today(p), 7, UNPLACED_NOW, "500 mg");
    db.prepare(
      `INSERT INTO intake_item_logs
         (dose_id, item_id, date, recorded_at, occurred_at, status, amount)
       VALUES (?, ?, ?, ?, NULL, 'taken', '500 mg')`
    ).run(
      med.doseId,
      med.itemId,
      shiftDateStr(today(p), -1),
      utcInstant(UNPLACED_NOW)
    );

    const state = getMedicationFamilyStates(p).get(med.itemId)!;
    // The unplaced row is IN the window — it counts — and it is not the arming dose.
    expect(state.count24h).toBe(2);
    expect(state.untimedInWindow).toBe(true);
    expect(state.latestGivenAt).toBe(
      utcInstant(new Date(UNPLACED_NOW.getTime() - 7 * 3_600_000))
    );

    // The interval half says so, on the card and to the notice, rather than computing
    // an elapsed time from a row that never said when it happened.
    const status = prnQuickLogRedoseStatus(
      getPrnMedicationsForQuickLog(p).find((m) => m.id === med.itemId)!,
      UNPLACED_NOW
    )!;
    expect(status.interval).toEqual({ known: false });
    expect(redoseCardLabel(status)).toBe(
      "Last dose time not recorded · 2 of 4 in 24h"
    );
    expect(redoseActionIsPrimary(status)).toBe(false);
    expect(
      redoseNoticeDecision({
        minIntervalHours: 6,
        maxDailyCount: 4,
        latestAdministrationId: state.latestId!,
        latestGivenAt: parseUtcSql(state.latestGivenAt),
        count24h: state.count24h,
        now: UNPLACED_NOW,
        notifiedAdministrationId: null,
        tickMinutes: 60,
        exposure: state.exposure,
        untimedInWindow: state.untimedInWindow,
      }).kind
    ).toBe("interval-unknown");
  });

  it("an unplaced row OUTSIDE the window leaves the interval knowable", () => {
    vi.setSystemTime(UNPLACED_NOW);
    const p = newProfile("Win24UnplacedOld");
    setProfileSetting(p, "timezone", "UTC");
    const med = seedPrn(p, "Acetaminophen");
    logAdmin(med.itemId, med.doseId, today(p), 7, UNPLACED_NOW, "500 mg");
    db.prepare(
      `INSERT INTO intake_item_logs
         (dose_id, item_id, date, recorded_at, occurred_at, status, amount)
       VALUES (?, ?, '2026-01-04', '2026-01-04T08:00:00Z', NULL, 'taken', '500 mg')`
    ).run(med.doseId, med.itemId);

    const state = getMedicationFamilyStates(p).get(med.itemId)!;
    expect(state.untimedInWindow).toBe(false);
    const status = prnQuickLogRedoseStatus(
      getPrnMedicationsForQuickLog(p).find((m) => m.id === med.itemId)!,
      UNPLACED_NOW
    )!;
    expect(status.interval).toMatchObject({ known: true, open: true });
  });

  // THE OVERNIGHT TAP, through the shipped tri-state with nothing exotic: a card
  // rendered at 23:58 still holds yesterday's date, the parent gives the dose and taps
  // at 00:15. The row states no instant, and anchoring it at its day's NOON claimed
  // twelve hours had passed — the window read open the moment the dose was logged.
  // An administration whose instant nobody established makes the interval UNKNOWN;
  // unknown is not "go".
  it("a past-dated tap that states no instant never reads as an open window", () => {
    vi.setSystemTime(AT("2026-09-02T00:15:00Z"));
    const p = newProfile("ArmOvernightTap");
    setProfileSetting(p, "timezone", "UTC");
    const med = seedPrn(p, "Acetaminophen");
    setDoseStatusCore(p, med.doseId, "2026-09-01", "taken", "page");

    const status = prnQuickLogRedoseStatus(
      getPrnMedicationsForQuickLog(p).find((m) => m.id === med.itemId)!,
      AT("2026-09-02T00:15:00Z")
    );
    const label = status ? redoseCardLabel(status) : null;
    expect(label).not.toContain("Redose OK");
    expect(label).not.toContain("min interval passed");
  });
});
