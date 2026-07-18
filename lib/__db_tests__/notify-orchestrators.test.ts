// DB INTEGRATION TIER — the notification-tick ORCHESTRATORS (issue #673) against a
// real (in-memory) SQLite handle. The pure decision layers (planRefillNudges /
// planPreventiveNudges / escalationsDue / delivery-status) and telegram-callbacks
// already have coverage; the gather→plan→dispatch→marker orchestrators
// (runRefills / runPreventive / runEscalations) were at ~0%. This generalizes
// home-assistant-notify.test.ts one layer up: instead of asserting one channel's
// POST, it drives the whole orchestrator with a FAKE CHANNEL wired at the network
// seam and pins the episode-marker lifecycle + delivery accounting + the safety-tier
// suppression contract those orchestrators own.
//
// SEAM. dispatch() (lib/notifications/index.ts) fans a message out to the hardcoded
// getChannels() = [telegram, push, home-assistant]; there is no registry to inject a
// test channel into. The LEAST invasive seam is therefore to configure REAL channels
// and stub the one thing every channel bottoms out in — global fetch — routing by URL
// (api.telegram.org vs the HA webhook host). This is exactly the home-assistant-notify
// precedent, so no channel module is mocked: the real isConfigured gates, the real
// dispatch marker fold, and (for escalation) the real chokepoint send all run. push
// stays unconfigured (no VAPID keys / subscriptions) so it never joins the fan-out.
//
// Every value here is synthetic (555-01xx would be a phone; there are none — just
// fake meds, a fake bot token, and a fake HA webhook URL).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db, today } from "@/lib/db";
import {
  setProfileTelegram,
  setTelegramBotConfig,
  setProfileHomeAssistant,
  setProfileSetting,
  getProfileSetting,
  setUserBirthdate,
  setUserSex,
} from "@/lib/settings";
import { runRefills } from "@/lib/notifications/refill";
import { runPreventive } from "@/lib/notifications/preventive";
import { runEscalations } from "@/lib/notifications/escalate";
import { ESCALATION_SUPPRESSION_POLICY } from "@/lib/notifications/escalation";
import { isHiddenUnderPolicy } from "@/lib/lifecycle";
import { escalationMarkerKey } from "@/lib/notifications/escalation-keys";
import { refillMarkerKey } from "@/lib/refill-nudge";
import { getNotifySchedule } from "@/lib/settings";
import { recordPreventiveDone } from "@/lib/queries";
import { buildWorkoutTargetReminder } from "@/lib/notifications/workouts";
import { runEaseBack, easeBackMarkerKey } from "@/lib/notifications/ease-back";
import { gatherCoachingInput } from "@/lib/queries";
import { createEpisodeRow } from "@/lib/illness-episode-store";
import { shiftDateStr } from "@/lib/date";
import { seedProfile } from "./fixtures";

// ---- fixtures ----

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

const HA_URL = "http://homeassistant.local:8123/api/webhook/allos-orch";
const PREVENTIVE_MARKER = (ruleKey: string) =>
  `notify_last_preventive_${ruleKey}`;
const SUPP_SENT_MARKER = "notify_last_supp_Morning";

// Enable the profile's Home Assistant channel (a dispatch() channel).
function configureHA(profileId: number): void {
  setProfileHomeAssistant(profileId, {
    enabled: true,
    webhookUrl: HA_URL,
    secret: "",
    disabledKinds: [],
  });
}

// Enable the global bot + this profile's Telegram delivery target (a dispatch()
// channel AND the escalation send target).
function configureTelegram(profileId: number, chatId = "555001"): void {
  setTelegramBotConfig({
    telegramBotToken: "orch-test-token",
    telegramMode: "poll",
  });
  setProfileTelegram(profileId, {
    telegramEnabled: true,
    telegramChatId: chatId,
  });
}

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// Stub global fetch, routing by URL so the two real channels can be made to
// independently succeed/fail. Telegram's raw transport parses JSON and requires
// {ok:true}; the HA channel only inspects the HTTP status.
function stubFetch(
  opts: { telegramOk?: boolean; haOk?: boolean } = {}
): ReturnType<typeof vi.fn> {
  const { telegramOk = true, haOk = true } = opts;
  const mock = vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) {
      return telegramOk
        ? jsonResponse({ ok: true, result: {} })
        : jsonResponse({ ok: false, description: "forced telegram failure" });
    }
    // The HA webhook host.
    return new Response(null, { status: haOk ? 200 : 404 });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

// A tracked, low-supply active supplement (8 on hand, 1/dose, one daily morning
// dose → ≈8 days left, under the 10-day threshold). Returns its id.
function seedLowSupplement(profileId: number, name = "Vitamin D"): number {
  const id = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, priority, quantity_on_hand, qty_per_dose)
         VALUES (?, ?, 1, 'supplement', 'daily', 'high', 8, 1)`
      )
      .run(profileId, name).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '1 cap', 'morning', 'any', 0)`
  ).run(id);
  return id;
}

// A critical, scheduled medication with an untaken morning dose. Returns
// { itemId, doseId } so the test can drive escalation markers/confirmations.
function seedCriticalMed(
  profileId: number,
  name = "Warfarin"
): { itemId: number; doseId: number } {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, priority, as_needed, critical)
         VALUES (?, ?, 1, 'medication', 'daily', 'mandatory', 0, 1)`
      )
      .run(profileId, name).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '5 mg', 'morning', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
  return { itemId, doseId };
}

function dismiss(profileId: number, signalKey: string): void {
  db.prepare(
    `INSERT INTO upcoming_dismissals (profile_id, signal_key, dismissed_at)
       VALUES (?, ?, datetime('now'))`
  ).run(profileId, signalKey);
}

beforeEach(() => {
  // Reset the GLOBAL delivery-health marker between cases (it's set/cleared by the
  // real dispatch fold, shared across profiles).
  // The delivery-health marker is now the notify_lifecycle row (issue #942), not the
  // legacy notify_last_error* settings keys — reset both so a prior case cannot leak.
  db.prepare("DELETE FROM notify_lifecycle").run();
  db.prepare("DELETE FROM settings WHERE key LIKE 'notify_last_error%'").run();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// =====================================================================
// runRefills — bus-gated nudge
// =====================================================================
describe("runRefills orchestrator", () => {
  it("marker lifecycle: sent → per-item marker set", async () => {
    const p = newProfile("RefillSend");
    const supp = seedLowSupplement(p);
    configureHA(p);
    const fetchMock = stubFetch();
    const date = today(p);

    const res = await runRefills(p, "RefillSend", date);
    expect(res.failed).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1); // one HA POST
    // Delivered → the item's low-supply episode marker is stamped with the date.
    expect(getProfileSetting(p, refillMarkerKey(supp))).toBe(date);
  });

  it("marker lifecycle: no longer low → stale marker CLEARED", async () => {
    const p = newProfile("RefillRecover");
    const supp = seedLowSupplement(p);
    // Pre-existing episode marker, then refill above threshold.
    setProfileSetting(p, refillMarkerKey(supp), "2020-01-01");
    db.prepare(
      "UPDATE intake_items SET quantity_on_hand = 300 WHERE id = ?"
    ).run(supp);
    configureHA(p);
    const fetchMock = stubFetch();

    const res = await runRefills(p, "RefillRecover", today(p));
    expect(res.failed).toBe(false);
    // Episode ended (not low) → marker swept, and nothing sent.
    expect(getProfileSetting(p, refillMarkerKey(supp))).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marker lifecycle: page-suppressed → FROZEN (neither sent nor cleared)", async () => {
    const p = newProfile("RefillFrozen");
    const supp = seedLowSupplement(p);
    // A live episode marker AND a page dismissal on the SAME refill:<id> signal.
    setProfileSetting(p, refillMarkerKey(supp), "2020-01-01");
    dismiss(p, `refill:${supp}`);
    configureHA(p);
    const fetchMock = stubFetch();

    const res = await runRefills(p, "RefillFrozen", today(p));
    expect(res.failed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled(); // held out of the send
    // The marker is the third "frozen" state: still low, still marked, but untouched
    // (neither re-stamped to today nor cleared) while the suppression stands.
    expect(getProfileSetting(p, refillMarkerKey(supp))).toBe("2020-01-01");
  });

  it("delivery accounting: no channel configured → no marker, retries next tick", async () => {
    const p = newProfile("RefillNoChannel");
    const supp = seedLowSupplement(p);
    const fetchMock = stubFetch();

    const res = await runRefills(p, "RefillNoChannel", today(p));
    expect(res.failed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    // No marker written, so the nudge is retried once a channel is configured.
    expect(getProfileSetting(p, refillMarkerKey(supp))).toBeUndefined();
  });

  it("delivery accounting: one channel fails + one succeeds → marker set, failed aggregated", async () => {
    const p = newProfile("RefillPartial");
    const supp = seedLowSupplement(p);
    configureHA(p);
    configureTelegram(p);
    const fetchMock = stubFetch({ telegramOk: true, haOk: false });
    const date = today(p);

    const res = await runRefills(p, "RefillPartial", date);
    // At least one channel delivered → the marker is set; the failed channel is
    // aggregated into the tick's exit signal.
    expect(res.failed).toBe(true);
    expect(getProfileSetting(p, refillMarkerKey(supp))).toBe(date);
    expect(fetchMock).toHaveBeenCalledTimes(2); // telegram + HA both attempted
  });

  it("delivery accounting: all channels fail → no marker", async () => {
    const p = newProfile("RefillAllFail");
    const supp = seedLowSupplement(p);
    configureHA(p);
    configureTelegram(p);
    stubFetch({ telegramOk: false, haOk: false });

    const res = await runRefills(p, "RefillAllFail", today(p));
    expect(res.failed).toBe(true);
    // Nothing delivered → marker stays unset so the episode re-fires next tick.
    expect(getProfileSetting(p, refillMarkerKey(supp))).toBeUndefined();
  });
});

// =====================================================================
// runPreventive — bus-gated nudge, per-item markers (#665)
// =====================================================================

// A ~46-year-old male, so the assessor emits due preventive items (adult_physical,
// blood_pressure, lipid_screening, …) with no history on record.
function preventiveProfile(name: string): number {
  const p = newProfile(name);
  setUserBirthdate(p, "1980-01-01");
  setUserSex(p, "male");
  return p;
}

describe("runPreventive orchestrator", () => {
  it("marker lifecycle: sent → PER-ITEM marker set", async () => {
    const p = preventiveProfile("PrevSend");
    configureHA(p);
    const fetchMock = stubFetch();
    const date = today(p);

    const res = await runPreventive(p, "PrevSend", date);
    expect(res.failed).toBe(false);
    // One message PER newly-due item, each stamping its OWN rule marker (#665).
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(getProfileSetting(p, PREVENTIVE_MARKER("adult_physical"))).toBe(
      date
    );
  });

  it("marker lifecycle: no longer actionable → marker CLEARED", async () => {
    const p = preventiveProfile("PrevRecover");
    const date = today(p);
    // A live episode marker for a rule that is then satisfied (marked done).
    setProfileSetting(p, PREVENTIVE_MARKER("adult_physical"), "2020-01-01");
    recordPreventiveDone(p, "adult_physical", date);
    configureHA(p);
    stubFetch();

    await runPreventive(p, "PrevRecover", date);
    // adult_physical is no longer due → its stale marker is swept.
    expect(
      getProfileSetting(p, PREVENTIVE_MARKER("adult_physical"))
    ).toBeUndefined();
  });

  it("marker lifecycle: page-suppressed → FROZEN (neither sent nor cleared)", async () => {
    const p = preventiveProfile("PrevFrozen");
    const date = today(p);
    setProfileSetting(p, PREVENTIVE_MARKER("adult_physical"), "2020-01-01");
    // Dismiss the SAME visit:adult_physical signal the Upcoming item carries.
    dismiss(p, "visit:adult_physical");
    configureHA(p);
    stubFetch();

    await runPreventive(p, "PrevFrozen", date);
    // Still due, but held out of the send with its marker frozen at the old value.
    expect(getProfileSetting(p, PREVENTIVE_MARKER("adult_physical"))).toBe(
      "2020-01-01"
    );
  });

  it("delivery accounting: no channel configured → no marker, retries next tick", async () => {
    const p = preventiveProfile("PrevNoChannel");
    const date = today(p);
    const fetchMock = stubFetch();

    const res = await runPreventive(p, "PrevNoChannel", date);
    expect(res.failed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      getProfileSetting(p, PREVENTIVE_MARKER("adult_physical"))
    ).toBeUndefined();
  });

  it("delivery accounting: all channels fail → no marker", async () => {
    const p = preventiveProfile("PrevAllFail");
    const date = today(p);
    configureHA(p);
    stubFetch({ haOk: false });

    const res = await runPreventive(p, "PrevAllFail", date);
    expect(res.failed).toBe(true);
    expect(
      getProfileSetting(p, PREVENTIVE_MARKER("adult_physical"))
    ).toBeUndefined();
  });

  it("domain toggle off → no nudge, no marker churn", async () => {
    const p = preventiveProfile("PrevOff");
    const date = today(p);
    setProfileSetting(p, "notify_preventive", "0");
    const fetchMock = stubFetch();

    const res = await runPreventive(p, "PrevOff", date);
    expect(res.failed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      getProfileSetting(p, PREVENTIVE_MARKER("adult_physical"))
    ).toBeUndefined();
  });
});

// =====================================================================
// runEscalations — safety tier (NEVER bus-gated), Telegram-only send
// =====================================================================

// Wire an escalation-ready fixture: a critical med with an untaken morning dose,
// the Morning reminder marked delivered today. Returns the dose id + local date.
function escalationFixture(profileId: number): {
  doseId: number;
  date: string;
} {
  const { doseId } = seedCriticalMed(profileId);
  const date = today(profileId);
  // The Morning window's reminder went out today (the notify_last_supp_Morning
  // dedup marker) — an undelivered window never escalates.
  setProfileSetting(profileId, SUPP_SENT_MARKER, date);
  return { doseId, date };
}

// Default Morning slot hour = 8; default wait = 120 min → threshold 10:00. Any tick
// hour ≥ 10 escalates. Use 12.
const LATE_HOUR = 12;

describe("runEscalations orchestrator", () => {
  it("marker lifecycle + ack flow: escalated → per-dose marker written", async () => {
    const p = newProfile("EscSend");
    const { doseId, date } = escalationFixture(p);
    configureTelegram(p);
    const fetchMock = stubFetch();

    const res = await runEscalations(
      p,
      "EscSend",
      date,
      LATE_HOUR,
      getNotifySchedule(p)
    );
    expect(res.failed).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1); // one Telegram escalation
    expect(getProfileSetting(p, escalationMarkerKey(doseId))).toBe(date);
  });

  it("ack flow: FAILED send → marker NOT written", async () => {
    const p = newProfile("EscFail");
    const { doseId, date } = escalationFixture(p);
    configureTelegram(p);
    stubFetch({ telegramOk: false });

    const res = await runEscalations(
      p,
      "EscFail",
      date,
      LATE_HOUR,
      getNotifySchedule(p)
    );
    expect(res.failed).toBe(true);
    // A failed escalation must NOT burn the per-dose dedup marker — it retries.
    expect(getProfileSetting(p, escalationMarkerKey(doseId))).toBeUndefined();
  });

  it("delivery accounting: no channel configured → no marker, retries next tick", async () => {
    const p = newProfile("EscNoChannel");
    const { doseId, date } = escalationFixture(p);
    const fetchMock = stubFetch();

    const res = await runEscalations(
      p,
      "EscNoChannel",
      date,
      LATE_HOUR,
      getNotifySchedule(p)
    );
    expect(res.failed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getProfileSetting(p, escalationMarkerKey(doseId))).toBeUndefined();
  });

  it("timing: before the escalate-after threshold → nothing escalates", async () => {
    const p = newProfile("EscEarly");
    const { doseId, date } = escalationFixture(p);
    configureTelegram(p);
    const fetchMock = stubFetch();

    // 09:00 < the 10:00 threshold (slot 8 + 120 min) → not yet due.
    const res = await runEscalations(
      p,
      "EscEarly",
      date,
      9,
      getNotifySchedule(p)
    );
    expect(res.failed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getProfileSetting(p, escalationMarkerKey(doseId))).toBeUndefined();
  });

  it("safety tier: a confirmed dose is NOT escalated", async () => {
    const p = newProfile("EscConfirmed");
    const { doseId, date } = escalationFixture(p);
    // Log the dose as taken today.
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, status)
       SELECT ?, item_id, ?, 'taken' FROM intake_item_doses WHERE id = ?`
    ).run(doseId, date, doseId);
    configureTelegram(p);
    const fetchMock = stubFetch();

    const res = await runEscalations(
      p,
      "EscConfirmed",
      date,
      LATE_HOUR,
      getNotifySchedule(p)
    );
    expect(res.failed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getProfileSetting(p, escalationMarkerKey(doseId))).toBeUndefined();
  });

  it("safety tier: bus suppression is IGNORED — a page-dismissed dose still escalates (#942)", async () => {
    const p = newProfile("EscSuppressed");
    const { doseId, date } = escalationFixture(p);
    // Dismiss the dose's Upcoming signal on the shared bus. Escalation is the first
    // lifecycle tenant (#942) and declares the "safety-ungated" policy, so it
    // DELIBERATELY does not consult the bus — a page dismissal must never silence a
    // possibly-critical medication signal.
    dismiss(p, `dose:${doseId}`);
    configureTelegram(p);
    const fetchMock = stubFetch();

    const res = await runEscalations(
      p,
      "EscSuppressed",
      date,
      LATE_HOUR,
      getNotifySchedule(p)
    );
    expect(res.failed).toBe(false);
    // Unaffected by the dismissal: it still escalates and marks the episode.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getProfileSetting(p, escalationMarkerKey(doseId))).toBe(date);
    // The end-to-end behavior above and the shared lifecycle gate AGREE: escalation's
    // declared policy, run against that very dismissal, is never hidden. If tenancy
    // ever weakened the carve-out (policy flipped off "safety-ungated"), this fails.
    expect(ESCALATION_SUPPRESSION_POLICY).toBe("safety-ungated");
    expect(
      isHiddenUnderPolicy(
        ESCALATION_SUPPRESSION_POLICY,
        { snooze_until: null, dismissed_at: `${date}T00:00:00Z` },
        date
      )
    ).toBe(false);
  });

  it("escalation routes to the supplement's escalate_chat_id when set", async () => {
    const p = newProfile("EscOverride");
    const { itemId, doseId } = seedCriticalMed(p, "Insulin");
    const date = today(p);
    setProfileSetting(p, SUPP_SENT_MARKER, date);
    db.prepare(
      "UPDATE intake_items SET escalate_chat_id = '555999' WHERE id = ?"
    ).run(itemId);
    configureTelegram(p, "555001");
    const fetchMock = stubFetch();

    const res = await runEscalations(
      p,
      "EscOverride",
      date,
      LATE_HOUR,
      getNotifySchedule(p)
    );
    expect(res.failed).toBe(false);
    expect(getProfileSetting(p, escalationMarkerKey(doseId))).toBe(date);
    // The POST body carries the override chat id, not the profile's own.
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(String(body.chat_id)).toBe("555999");
  });
});

// =====================================================================
// buildWorkoutTargetReminder / recommendWorkout — the workout slot's message
// builder. NOT a dispatch/marker orchestrator (the tick in scripts/notify.ts owns
// the send + notify_last_workout slot marker); it's a FORMATTER over the shared
// #221 next-workout core, so this harness covers it end-to-end for the "returns a
// message vs null" contract only. The bus-gated suppression → null path (all
// behind-targets dismissed) is unit-tested in isWorkoutNudgeSuppressed, and the
// heavy gather (gatherCoachingInput) has its own coaching DB tests.
// =====================================================================
describe("buildWorkoutTargetReminder", () => {
  it("returns null for a bare profile with nothing to suggest or note", () => {
    const p = newProfile("WorkoutBare");
    expect(buildWorkoutTargetReminder(p)).toBeNull();
  });

  it("returns a workout message once there is training history to reason over", () => {
    // seedProfile logs a strength session today, so the shared core produces a
    // reminder (a rest/on-track note here, since the day is already trained).
    const s = seedProfile("WorkoutSeed");
    const msg = buildWorkoutTargetReminder(s.profileId);
    expect(msg).not.toBeNull();
    expect(msg!.kind).toBe("workout");
    expect(typeof msg!.title).toBe("string");
    expect(msg!.title.length).toBeGreaterThan(0);
  });
});

// =====================================================================
// runEaseBack — the one-shot post-illness ease-back nudge (issue #837). Fires ONCE
// per episode (marker per episode id) the first tick after a flagged-illness episode
// closes, and never re-fires for the same episode.
// =====================================================================
describe("runEaseBack (#837)", () => {
  it("sends once on close and never re-fires for the same episode", async () => {
    const p = newProfile("EaseBack");
    const td = today(p);
    configureTelegram(p, "555001");
    // A closed flagged-illness episode whose exclusive end (first well day) is today.
    const episodeId = createEpisodeRow(p, "Illness", shiftDateStr(td, -4), td);

    const input1 = gatherCoachingInput(p, "kg", "km");
    const fetchMock = stubFetch();
    const res1 = await runEaseBack(p, "EaseBack", input1, td);
    expect(res1.failed).toBe(false);
    // Delivered → the per-episode one-shot marker is set to the send date.
    expect(getProfileSetting(p, easeBackMarkerKey(episodeId))).toBe(td);
    const firstSendCalls = fetchMock.mock.calls.length;
    expect(firstSendCalls).toBeGreaterThan(0);
    // The message carries the ease-back classification.
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(String(body.text)).toContain("Back from being sick");

    // Second tick, same open ease-back window → one-shot: no new send.
    const input2 = gatherCoachingInput(p, "kg", "km");
    const res2 = await runEaseBack(p, "EaseBack", input2, td);
    expect(res2.failed).toBe(false);
    expect(fetchMock.mock.calls.length).toBe(firstSendCalls);
  });

  it("does nothing during an open episode (ease-back is post-close only)", async () => {
    const p = newProfile("EaseBackOpen");
    const td = today(p);
    configureTelegram(p, "555001");
    createEpisodeRow(p, "Illness", shiftDateStr(td, -2), null); // still open

    const input = gatherCoachingInput(p, "kg", "km");
    const fetchMock = stubFetch();
    const res = await runEaseBack(p, "EaseBackOpen", input, td);
    expect(res.failed).toBe(false);
    expect(fetchMock.mock.calls.length).toBe(0);
  });
});
