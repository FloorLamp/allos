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
import { setProfileHomeAssistant, getProfileSetting } from "@/lib/settings";
import { utcSqlString } from "@/lib/date";
import { runRedoseNotices, redoseMarkerKey } from "@/lib/notifications/redose";
import {
  collectUpcoming,
  getMedicationFamilyStates,
  getPrnOverMaxItems,
} from "@/lib/queries";
import { prnMaxSignalKey } from "@/lib/prn-redose";
import { buildMedicationDuplicationFindings } from "@/lib/rule-findings";
import {
  dedupeKeyHasKnownPrefix,
  tierForDedupeKey,
} from "@/lib/rule-finding-prefixes";
import { MED_DUP_PREFIX } from "@/lib/medication-family";

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
  } = {}
): { itemId: number; doseId: number } {
  const {
    amount = "200 mg",
    redoseNotice = 0,
    minInterval = null,
    maxDaily = null,
  } = opts;
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, priority, as_needed,
            redose_notice, min_interval_hours, max_daily_count)
         VALUES (?, ?, 1, 'medication', 'daily', 'high', 1, ?, ?, ?)`
      )
      .run(profileId, name, redoseNotice, minInterval, maxDaily).lastInsertRowid
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
  now: Date
): number {
  const givenAt = utcSqlString(new Date(now.getTime() - hoursAgo * 3_600_000));
  return Number(
    db
      .prepare(
        `INSERT INTO intake_item_logs (dose_id, item_id, date, given_at, status)
         VALUES (?, ?, ?, ?, 'taken')`
      )
      .run(doseId, itemId, date, givenAt).lastInsertRowid
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

    const states = getMedicationFamilyStates(p, date);
    const state = states.get(otc.itemId)!;
    expect(state).toBeTruthy();
    expect(states.get(rx.itemId)!.familyKey).toBe(state.familyKey);
    expect(state.memberIds.sort()).toEqual([otc.itemId, rx.itemId].sort());
    // The family's latest administration is the Rx dose an hour ago, and the
    // combined count spans both items.
    expect(state.latestId).toBe(rxAdmin);
    expect(state.latestItemId).toBe(rx.itemId);
    expect(state.countToday).toBe(2);
    expect(state.minConfirmedMax).toBe(4);
  });

  it("an unrelated med stays its own family", () => {
    const p = newProfile("FamUnrelated");
    seedIbuprofenPair(p);
    const other = seedMed(p, "Acetaminophen");
    const states = getMedicationFamilyStates(p, today(p));
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
    expect(items[0].count).toBe(5);
    expect(items[0].maxDailyCount).toBe(4);
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
    expect(items[0]).toMatchObject({ id: itemId, count: 2, maxDailyCount: 1 });
    expect(items[0].memberNames).toBeUndefined();
  });
});

describe("therapeutic-duplication note (#1027 ask 3, coaching tier)", () => {
  it("emits ONE hideable observation per multi-item family with a registry-parsing key", () => {
    const p = newProfile("FamDup");
    seedIbuprofenPair(p);
    seedMed(p, "Acetaminophen"); // solo — no note

    const findings = buildMedicationDuplicationFindings(p);
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toContain("Ibuprofen appears in 2 active");
    expect(findings[0].dedupeKey.startsWith(MED_DUP_PREFIX)).toBe(true);
    expect(dedupeKeyHasKnownPrefix(findings[0].dedupeKey)).toBe(true);
    // Coaching tier (#449): calm — never a notification, never the hero.
    expect(tierForDedupeKey(findings[0].dedupeKey)).toBe("coaching");
    // And it is NOT an Upcoming item (coaching findings stay off Upcoming).
    expect(
      collectUpcoming(p, today(p)).some((u) => u.key.startsWith(MED_DUP_PREFIX))
    ).toBe(false);
  });
});
