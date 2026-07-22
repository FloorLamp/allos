// DB INTEGRATION TIER — the MERGED morning digest (issue #1108). The morning digest
// and the old "what's due" upcoming digest fired on the SAME digest-hour slot as two
// back-to-back messages with two markers; #1108 merges them into ONE message whose
// Today section is a formatter over collectUpcoming (one engine, #221), so snooze/
// dismiss (the findings bus) and the #558 predicted-training-day dose logic govern the
// whole message, and a single per-day marker (notify_last_digest) gates it.
//
// This harness pins the four behaviors the pure tier structurally can't see: ONE send
// when both digests would have fired, the bus finally suppressing a digest item, the
// #558 dose flowing through collectUpcoming, and the retired notify_last_upcoming
// marker being swept by migration 093. It reuses the notify-orchestrators fetch seam
// (stub global fetch, route by URL) so the real dispatch marker fold runs.
//
// Every value is synthetic (fake supplements, a fake bot token, no phones).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  setProfileTelegram,
  setTelegramBotConfig,
  setProfileSetting,
  getProfileSetting,
} from "@/lib/settings";
import { runDigest, gatherDigestInput } from "@/lib/notifications/digest-data";
import { buildDigest, renderDigestMessage } from "@/lib/notifications/digest";
import { up as retireUpcomingMarker } from "@/lib/migrations/versions/093-retire-notify-last-upcoming";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// A due daily supplement dose (no supply tracking → no refill). Returns the dose id.
function seedDailyDose(profileId: number, name = "Vitamin D"): number {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, priority, qty_per_dose)
         VALUES (?, ?, 1, 'supplement', 'daily', 'high', 1)`
      )
      .run(profileId, name).lastInsertRowid
  );
  return Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '1 cap', 'morning', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
}

// A pre_workout supplement + dose — due only on a training day (logged OR #558
// predicted). Returns the dose id.
function seedPreWorkoutDose(profileId: number, name = "Creatine"): number {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, priority, qty_per_dose)
         VALUES (?, ?, 1, 'supplement', 'pre_workout', 'high', 1)`
      )
      .run(profileId, name).lastInsertRowid
  );
  return Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '5 g', 'morning', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
}

// A tracked low-supply supplement (8 on hand, 1/dose, one daily dose → a refill
// signal AND a due dose). Returns its id.
function seedLowSupplement(profileId: number, name = "Magnesium"): number {
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

function seedActivity(profileId: number, date: string): void {
  db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, duration_min)
     VALUES (?, ?, 'strength', 'Session', 45)`
  ).run(profileId, date);
}

function dismiss(profileId: number, signalKey: string): void {
  db.prepare(
    `INSERT INTO upcoming_dismissals (profile_id, signal_key, dismissed_at)
       VALUES (?, ?, datetime('now'))`
  ).run(profileId, signalKey);
}

function configureTelegram(profileId: number, chatId = "555001"): void {
  setTelegramBotConfig({
    telegramBotToken: "digest-merge-token",
    telegramMode: "poll",
  });
  setProfileTelegram(profileId, {
    telegramEnabled: true,
    telegramChatId: chatId,
  });
}

function stubFetch(): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => {
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

beforeEach(() => {
  db.prepare("DELETE FROM notify_lifecycle").run();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("merged morning digest — one message, one computation (#1108)", () => {
  it("sends ONE message carrying BOTH the what's-due list and the yesterday recap, marks one marker", async () => {
    const p = newProfile("MergeSend");
    const td = today(p);
    seedDailyDose(p, "Vitamin D"); // due dose → glance line
    seedLowSupplement(p, "Magnesium"); // refill signal → a banded what's-due line
    seedActivity(p, shiftDateStr(td, -1)); // yesterday → Yesterday section
    configureTelegram(p);
    const fetchMock = stubFetch();

    const res = await runDigest(p, "MergeSend", td);
    expect(res.failed).toBe(false);
    // ONE Telegram POST — where before #1108 there were two back-to-back messages.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const body = String(
      JSON.parse(fetchMock.mock.calls[0][1].body as string).text
    );
    // The single message merges the morning digest's sections with the what's-due
    // list: the dose glance headline, the banded refill line, and the yesterday recap.
    expect(body).toContain("Today");
    expect(body).toContain("scheduled"); // dose glance line
    expect(body).toContain("refill"); // merged what's-due content
    expect(body).toContain("Yesterday");

    // ONE per-day marker; the retired notify_last_upcoming is never written.
    expect(getProfileSetting(p, "notify_last_digest")).toBe(td);
    expect(getProfileSetting(p, "notify_last_upcoming")).toBeUndefined();

    // A second run the same day is a no-op (marker already set) — no second send.
    const before = fetchMock.mock.calls.length;
    if (getProfileSetting(p, "notify_last_digest") !== td) {
      await runDigest(p, "MergeSend", td);
    }
    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it("the findings bus finally applies: a dismissed dose drops out of the digest (the #1108 fix)", () => {
    const p = newProfile("MergeBus");
    const td = today(p);
    const doseId = seedDailyDose(p, "Vitamin D");
    seedActivity(p, shiftDateStr(td, -1)); // keeps the digest non-null after the dismiss

    // Before: the due dose is counted and appears as a glance line.
    const before = buildDigest(gatherDigestInput(p, "MergeBus"));
    const todayBefore = before?.sections.find((s) => s.heading === "Today");
    expect(gatherDigestInput(p, "MergeBus").doseCount).toBe(1);
    expect(todayBefore?.lines.some((l) => l.includes("scheduled"))).toBe(true);

    // Dismiss the dose's Upcoming signal on the shared bus (the SAME dedupeKey the
    // Upcoming row carries). The OLD digest hand-computed its dose count and ignored
    // this; the merged digest reads collectUpcoming, so it's now honored.
    dismiss(p, `dose:${doseId}`);

    const after = buildDigest(gatherDigestInput(p, "MergeBus"));
    expect(gatherDigestInput(p, "MergeBus").doseCount).toBe(0);
    const todayAfter = after?.sections.find((s) => s.heading === "Today");
    expect(
      todayAfter?.lines.some((l) => l.includes("scheduled")) ?? false
    ).toBe(false);
  });

  it("preserves the #558 predicted-training-day dose through collectUpcoming", () => {
    const p = newProfile("Merge558");
    const td = today(p);
    // A habitual training pattern on today's weekday (≥4 distinct dates in 8 weeks),
    // with NO session logged today — so dueness must come from the PREDICTED day.
    for (const w of [1, 2, 3, 4, 5]) seedActivity(p, shiftDateStr(td, -7 * w));
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM activities WHERE profile_id = ? AND date = ?"
        )
        .get(p, td)
    ).toEqual({ c: 0 });
    seedPreWorkoutDose(p, "Creatine");

    // The pre_workout dose is due on the predicted day and flows through
    // collectUpcoming's dose items into the digest's dose count (#558 not lost).
    expect(gatherDigestInput(p, "Merge558").doseCount).toBeGreaterThanOrEqual(
      1
    );
    const model = buildDigest(gatherDigestInput(p, "Merge558"));
    const todaySection = model?.sections.find((s) => s.heading === "Today");
    expect(todaySection?.lines.some((l) => l.includes("scheduled"))).toBe(true);
  });

  it("renders the four sections in order when all are present", () => {
    const p = newProfile("MergeOrder");
    const td = today(p);
    seedDailyDose(p, "Vitamin D");
    seedActivity(p, shiftDateStr(td, -1));
    const model = buildDigest(gatherDigestInput(p, "MergeOrder"));
    const headings = model?.sections.map((s) => s.heading) ?? [];
    // Today precedes Yesterday (Illness/Sleep/New only when present here).
    expect(headings).toContain("Today");
    expect(headings).toContain("Yesterday");
    expect(headings.indexOf("Today")).toBeLessThan(
      headings.indexOf("Yesterday")
    );
    // Sanity: renders to a single non-empty message.
    const msg = renderDigestMessage(model!);
    expect(msg.kind).toBe("digest");
    expect(msg.body.length).toBeGreaterThan(0);
  });
});

describe("migration 093 — retire notify_last_upcoming (#203 cleanup)", () => {
  it("sweeps the dead marker and leaves notify_last_digest untouched; idempotent", () => {
    const p = newProfile("MergeMarker");
    setProfileSetting(p, "notify_last_upcoming", "2025-01-01");
    setProfileSetting(p, "notify_last_digest", "2025-01-02");

    retireUpcomingMarker(db);
    expect(getProfileSetting(p, "notify_last_upcoming")).toBeUndefined();
    expect(getProfileSetting(p, "notify_last_digest")).toBe("2025-01-02");

    // Replay is a no-op (nothing left to delete).
    expect(() => retireUpcomingMarker(db)).not.toThrow();
    expect(getProfileSetting(p, "notify_last_upcoming")).toBeUndefined();
  });
});
