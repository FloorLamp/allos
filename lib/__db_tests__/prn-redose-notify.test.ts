// DB INTEGRATION TIER — the PRN redose-notice ORCHESTRATOR (issue #798), following the
// notify-orchestrators (#673/#785) harness: a FAKE CHANNEL wired at the fetch seam
// (Home Assistant webhook), driving runRedoseNotices end-to-end through the real
// gather → pure decision → dispatch → per-item one-shot marker. Pins the full lifecycle
// the acceptance criteria call out: armed → fires ONCE → marker set → second tick no-op
// → daily-max suppression → RE-ARM on the next administration, plus the liability gate
// (unconfirmed fields ⇒ NO notice).
//
// Every value is synthetic (fake meds + a fake HA webhook URL; no phones).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db, today } from "@/lib/db";
import { setProfileHomeAssistant, getProfileSetting } from "@/lib/settings";
import { utcSqlString } from "@/lib/date";
import { runRedoseNotices, redoseMarkerKey } from "@/lib/notifications/redose";
import { collectUpcoming, dismissFinding } from "@/lib/queries";
import { prnMaxSignalKey } from "@/lib/prn-redose";

const HA_URL = "http://homeassistant.local:8123/api/webhook/allos-redose";

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

// A PRN med with CONFIRMED redose fields opted in (interval 6h, max 4/day). Returns
// { itemId, doseId }.
function seedRedoseMed(
  profileId: number,
  opts: {
    redoseNotice?: number;
    minInterval?: number | null;
    maxDaily?: number | null;
  } = {}
): { itemId: number; doseId: number } {
  const { redoseNotice = 1, minInterval = 6, maxDaily = 4 } = opts;
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, priority, as_needed,
            redose_notice, min_interval_hours, max_daily_count)
         VALUES (?, 'Ibuprofen (test)', 1, 'medication', 'daily', 'high', 1, ?, ?, ?)`
      )
      .run(profileId, redoseNotice, minInterval, maxDaily).lastInsertRowid
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

// Insert one administration with a controlled given_at (hoursAgo before `now`), on
// today's local date so the day count sees it. Returns the inserted row id.
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

beforeEach(() => {
  // The delivery-health marker is now the notify_lifecycle row (issue #942), not the
  // legacy notify_last_error* settings keys — reset both so a prior case cannot leak.
  db.prepare("DELETE FROM notify_lifecycle").run();
  db.prepare("DELETE FROM settings WHERE key LIKE 'notify_last_error%'").run();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runRedoseNotices orchestrator", () => {
  it("armed → fires ONCE, stamps the per-item marker with the administration id", async () => {
    const p = newProfile("RedoseFire");
    const { itemId, doseId } = seedRedoseMed(p);
    const now = new Date();
    const date = today(p);
    const adminId = logAdmin(itemId, doseId, date, 7, now); // 7h ago, past the 6h interval
    configureHA(p);
    const fetchMock = stubFetch();

    const r1 = await runRedoseNotices(p, "RedoseFire", date, now);
    expect(r1.failed).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1); // one HA POST
    expect(getProfileSetting(p, redoseMarkerKey(itemId))).toBe(String(adminId));

    // Second tick, same state → one-shot already fired → NO send, marker unchanged.
    const r2 = await runRedoseNotices(p, "RedoseFire", date, now);
    expect(r2.failed).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getProfileSetting(p, redoseMarkerKey(itemId))).toBe(String(adminId));
  });

  it("does NOT fire before the interval elapses", async () => {
    const p = newProfile("RedoseEarly");
    const { itemId, doseId } = seedRedoseMed(p);
    const now = new Date();
    const date = today(p);
    logAdmin(itemId, doseId, date, 3, now); // only 3h ago (< 6h)
    configureHA(p);
    const fetchMock = stubFetch();

    await runRedoseNotices(p, "RedoseEarly", date, now);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getProfileSetting(p, redoseMarkerKey(itemId))).toBeUndefined();
  });

  it("SUPPRESSED at the confirmed daily max even with the window open", async () => {
    const p = newProfile("RedoseMax");
    const { itemId, doseId } = seedRedoseMed(p); // max 4/day
    const now = new Date();
    const date = today(p);
    // Four administrations today, the latest 7h ago (window open) — at the max.
    logAdmin(itemId, doseId, date, 12, now);
    logAdmin(itemId, doseId, date, 10, now);
    logAdmin(itemId, doseId, date, 9, now);
    logAdmin(itemId, doseId, date, 7, now);
    configureHA(p);
    const fetchMock = stubFetch();

    await runRedoseNotices(p, "RedoseMax", date, now);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getProfileSetting(p, redoseMarkerKey(itemId))).toBeUndefined();
  });

  it("RE-ARMS on the NEXT administration (a newer id fires again)", async () => {
    const p = newProfile("RedoseRearm");
    const { itemId, doseId } = seedRedoseMed(p);
    const now = new Date();
    const date = today(p);
    const first = logAdmin(itemId, doseId, date, 8, now);
    configureHA(p);
    const fetchMock = stubFetch();

    await runRedoseNotices(p, "RedoseRearm", date, now);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getProfileSetting(p, redoseMarkerKey(itemId))).toBe(String(first));

    // A newer administration (still past the interval, count 2 < max) re-arms it.
    const second = logAdmin(itemId, doseId, date, 6.5, now);
    expect(second).toBeGreaterThan(first);
    await runRedoseNotices(p, "RedoseRearm", date, now);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getProfileSetting(p, redoseMarkerKey(itemId))).toBe(String(second));
  });

  it("LIABILITY GATE: no opt-in ⇒ no notice, ever", async () => {
    const p = newProfile("RedoseNoOptIn");
    const { itemId, doseId } = seedRedoseMed(p, { redoseNotice: 0 });
    const now = new Date();
    const date = today(p);
    logAdmin(itemId, doseId, date, 8, now);
    configureHA(p);
    const fetchMock = stubFetch();

    await runRedoseNotices(p, "RedoseNoOptIn", date, now);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getProfileSetting(p, redoseMarkerKey(itemId))).toBeUndefined();
  });

  it("LIABILITY GATE: opted in but interval unconfirmed ⇒ no notice", async () => {
    const p = newProfile("RedoseNoInterval");
    // redose_notice=1 but min_interval_hours NULL — the gather query excludes it.
    const { itemId, doseId } = seedRedoseMed(p, { minInterval: null });
    const now = new Date();
    const date = today(p);
    logAdmin(itemId, doseId, date, 8, now);
    configureHA(p);
    const fetchMock = stubFetch();

    await runRedoseNotices(p, "RedoseNoInterval", date, now);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getProfileSetting(p, redoseMarkerKey(itemId))).toBeUndefined();
  });

  it("no channel configured ⇒ no marker, retries next tick", async () => {
    const p = newProfile("RedoseNoChannel");
    const { itemId, doseId } = seedRedoseMed(p);
    const now = new Date();
    const date = today(p);
    logAdmin(itemId, doseId, date, 8, now);
    const fetchMock = stubFetch();

    const r = await runRedoseNotices(p, "RedoseNoChannel", date, now);
    expect(r.failed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getProfileSetting(p, redoseMarkerKey(itemId))).toBeUndefined();
  });
});

// The over-max CARE finding (an Upcoming generator, bus-suppressible — distinct from
// the safety-tier notice above which is NEVER bus-gated).
describe("over-max care finding (Upcoming)", () => {
  it("surfaces on Upcoming only when the count EXCEEDS the confirmed max, and is dismissible", () => {
    const p = newProfile("OverMax");
    const { itemId, doseId } = seedRedoseMed(p); // max 4/day
    const now = new Date();
    const date = today(p);
    // Exactly at max (4) — not YET over, so no finding.
    for (let i = 0; i < 4; i++) logAdmin(itemId, doseId, date, 12 - i, now);
    expect(
      collectUpcoming(p, date).some((u) => u.key === prnMaxSignalKey(itemId))
    ).toBe(false);

    // A 5th administration exceeds the max → the care finding appears (banded today).
    logAdmin(itemId, doseId, date, 1, now);
    const found = collectUpcoming(p, date).find(
      (u) => u.key === prnMaxSignalKey(itemId)
    );
    expect(found).toBeTruthy();
    expect(found!.domain).toBe("prn-max");
    expect(found!.band).toBe("today");

    // Dismissing it on the shared findings bus silences it (dismiss once, silence
    // everywhere).
    dismissFinding(p, prnMaxSignalKey(itemId));
    expect(
      collectUpcoming(p, date).some((u) => u.key === prnMaxSignalKey(itemId))
    ).toBe(false);
  });
});
