// DB INTEGRATION TIER — the shared push predicate end-to-end, notification half:
// a `may` item is never notified (window reminder, merged send, digest count), an
// all-may slot goes silent BY DESIGN, a mixed slot keeps its must/should doses, and
// escalation stays `must` + `critical` — never widened by a display filter. The
// predicate's reach past the notification tier (Upcoming, hero, refills, the
// availability disclosure) is covered in intake-obligation-lifecycle.test.ts.
// All fixture values synthetic — no real PHI.

import { describe, it, expect, afterEach, vi } from "vitest";
import { db, today } from "@/lib/db";
import {
  buildSupplementReminder,
  buildIntakeReminderForSlots,
  collectWindowDoses,
} from "@/lib/notifications/supplements";
import { gatherDigestInput } from "@/lib/notifications/digest-data";
import { collectUpcoming } from "@/lib/queries/upcoming";
import { runEscalations } from "@/lib/notifications/escalate";
import { escalationMarkerKey } from "@/lib/notifications/escalation-keys";
import {
  getNotifySchedule,
  setProfileSetting,
  getProfileSetting,
  setTelegramBotConfig,
} from "@/lib/settings";
import { seedLoginTelegram } from "./fixtures";
import type { IntakeObligation } from "@/lib/types";
import { escalatesOnMiss } from "@/lib/supplement-schedule";

function createProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function seedItem(
  profileId: number,
  name: string,
  opts: {
    kind?: "supplement" | "medication";
    obligation?: IntakeObligation;
    critical?: 0 | 1;
    timeOfDay?: string;
  } = {}
): { itemId: number; doseId: number } {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation, critical)
         VALUES (?, ?, 1, ?, 'daily', ?, ?)`
      )
      .run(
        profileId,
        name,
        opts.kind ?? "supplement",
        opts.obligation ?? "should",
        opts.critical ?? 0
      ).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '1 unit', ?, 'any', 0)`
      )
      .run(itemId, opts.timeOfDay ?? "morning").lastInsertRowid
  );
  return { itemId, doseId };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("#1156/#1505 — `may` items: tracked, never pushed", () => {
  it("a slot whose only due dose is a `may` item sends NO reminder — and it is off the due list too", () => {
    const p = createProfile("Floor AllLow (test)");
    const { doseId } = seedItem(p, "Ashwagandha (test)", { obligation: "may" });

    // No notification…
    expect(buildSupplementReminder(p, "Morning")).toBeNull();
    expect(buildIntakeReminderForSlots(p, ["Morning"])).toBeNull();

    // …and since #1505 no Upcoming row either: the ONE predicate now gates the whole
    // push tier, not just the reminder. (The dose is still tracked — its page
    // presence and adherence accounting are asserted in
    // supplement-priority-lifecycle.test.ts.)
    const upcoming = collectUpcoming(p, today(p));
    expect(upcoming.some((i) => i.key === `dose:${doseId}`)).toBe(false);
  });

  it("a mixed slot still fires — WITHOUT the `may` doses (body or buttons)", () => {
    const p = createProfile("Floor Mixed (test)");
    seedItem(p, "Ashwagandha (test)", { obligation: "may" });
    seedItem(p, "Vitamin D (test)", { obligation: "should" });

    const msg = buildSupplementReminder(p, "Morning");
    expect(msg).not.toBeNull();
    expect(msg!.body).toContain("Vitamin D (test)");
    expect(msg!.body).not.toContain("Ashwagandha (test)");
    expect(
      (msg!.actions ?? []).every((a) => !a.label.includes("Ashwagandha"))
    ).toBe(true);
  });

  it("a `must` MEDICATION notifies; the kind carve-out is gone (obligation decides)", () => {
    const p = createProfile("Floor Med (test)");
    seedItem(p, "Testoprim (test med)", {
      kind: "medication",
      obligation: "must",
    });
    // Before #1505 a medication was pushed BECAUSE it was a medication. Now it is
    // pushed because it is `must` — its default, and one it can only leave through an
    // explicit consequence-stating confirm.
    seedItem(p, "Testoprim PRN (test med)", {
      kind: "medication",
      obligation: "may",
    });
    const msg = buildSupplementReminder(p, "Morning");
    expect(msg).not.toBeNull();
    expect(msg!.body).toContain("Testoprim (test med)");
    expect(msg!.body).not.toContain("Testoprim PRN (test med)");
  });

  it("the morning digest's dose count excludes `may` items but keeps everything else", () => {
    const p = createProfile("Floor Digest (test)");
    seedItem(p, "Ashwagandha (test)", { obligation: "may" });
    seedItem(p, "Vitamin D (test)", { obligation: "should" });
    seedItem(p, "Testoprim (test med)", {
      kind: "medication",
      obligation: "must",
    });
    const input = gatherDigestInput(p, "Floor Digest (test)");
    // The should supplement + the must medication count; the `may` supplement does
    // not — it has no dueness to count.
    expect(input.doseCount).toBe(2);
  });

  it("escalation needs BOTH `must` and `critical` — a critical must med escalates", async () => {
    const p = createProfile("Floor Escalate (test)");
    const { doseId } = seedItem(p, "Warfarin (test)", {
      kind: "medication",
      obligation: "must",
      critical: 1,
    });
    const date = today(p);
    // The Morning reminder went out today (the escalation precondition).
    setProfileSetting(p, "notify_last_supp_Morning", date);
    setTelegramBotConfig({
      telegramBotToken: "floor-test-token",
      telegramMode: "poll",
    });
    seedLoginTelegram(p, "555002");
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, result: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    // Default slot 8 + default 120-min wait → due from 10:00; use 12.
    const res = await runEscalations(
      p,
      "Floor Escalate (test)",
      date,
      12,
      getNotifySchedule(p)
    );
    expect(res.failed).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getProfileSetting(p, escalationMarkerKey(doseId))).toBe(date);
  });

  it("the escalation gather stays UNFILTERED by the send floor (the safety tier is never display-gated)", () => {
    const p = createProfile("Floor EscGather (test)");
    // A `should` critical item: it is DUE (so it reaches the gather) and it is sent,
    // but escalatesOnMiss refuses it — `should` never escalates, which is the
    // distinction the old two-value model could not express.
    seedItem(p, "Critical Should Supp (test)", {
      obligation: "should",
      critical: 1,
    });
    // The safety-tier gather (collectWindowDoses) is deliberately unfiltered by the
    // SEND floor — the floor is applied at assembly, never here.
    const gathered = collectWindowDoses(p, "Morning", today(p));
    expect(
      gathered.some((e) => e.supp.name === "Critical Should Supp (test)")
    ).toBe(true);
    // …and the send DOES go out (a `should` is pushed) — but escalation refuses it,
    // because escalation asks obligation, not the send floor.
    expect(buildSupplementReminder(p, "Morning")).not.toBeNull();
    expect(escalatesOnMiss({ obligation: "should" })).toBe(false);

    // A `may` item, by contrast, is not even due, so it never reaches the gather.
    const q = createProfile("Floor EscGather May (test)");
    seedItem(q, "Critical May Supp (test)", {
      obligation: "may",
      critical: 1,
    });
    expect(collectWindowDoses(q, "Morning", today(q))).toEqual([]);
    expect(buildSupplementReminder(q, "Morning")).toBeNull();
  });
});
