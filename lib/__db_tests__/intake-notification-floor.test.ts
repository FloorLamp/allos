// DB INTEGRATION TIER — the #1156 notification priority floor end-to-end:
// a LOW-priority SUPPLEMENT is tracked (Upcoming/dose reads unchanged) but never
// notified (window reminder, merged send, digest count), an all-low send goes
// silent BY DESIGN, a mixed send keeps its mandatory/high doses, and the SAFETY
// carve-out holds — a low-priority MEDICATION's scheduled reminder and a
// critical med's missed-dose escalation are never priority-gated.
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
    priority?: "mandatory" | "high" | "low";
    critical?: 0 | 1;
    timeOfDay?: string;
  } = {}
): { itemId: number; doseId: number } {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, priority, as_needed, critical)
         VALUES (?, ?, 1, ?, 'daily', ?, 0, ?)`
      )
      .run(
        profileId,
        name,
        opts.kind ?? "supplement",
        opts.priority ?? "high",
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

describe("#1156 — low-priority supplements: tracked, not nagged", () => {
  it("a window whose only due dose is a low supplement sends NO reminder — but the dose stays in-app", () => {
    const p = createProfile("Floor AllLow (test)");
    const { doseId } = seedItem(p, "Ashwagandha (test)", { priority: "low" });

    // No notification…
    expect(buildSupplementReminder(p, "Morning")).toBeNull();
    expect(buildIntakeReminderForSlots(p, ["Morning"])).toBeNull();

    // …but fully visible in-app: the Upcoming dose item still surfaces.
    const upcoming = collectUpcoming(p, today(p));
    expect(upcoming.some((i) => i.key === `dose:${doseId}`)).toBe(true);
  });

  it("a mixed window still fires — WITHOUT the low doses (body or buttons)", () => {
    const p = createProfile("Floor Mixed (test)");
    seedItem(p, "Ashwagandha (test)", { priority: "low" });
    seedItem(p, "Vitamin D (test)", { priority: "high" });

    const msg = buildSupplementReminder(p, "Morning");
    expect(msg).not.toBeNull();
    expect(msg!.body).toContain("Vitamin D (test)");
    expect(msg!.body).not.toContain("Ashwagandha (test)");
    expect(
      (msg!.actions ?? []).every((a) => !a.label.includes("Ashwagandha"))
    ).toBe(true);
  });

  it("a LOW-priority MEDICATION still notifies (the safety carve-out)", () => {
    const p = createProfile("Floor LowMed (test)");
    seedItem(p, "Testoprim (test med)", {
      kind: "medication",
      priority: "low",
    });
    const msg = buildSupplementReminder(p, "Morning");
    expect(msg).not.toBeNull();
    expect(msg!.body).toContain("Testoprim (test med)");
  });

  it("the morning digest's dose count excludes low supplements but keeps everything else", () => {
    const p = createProfile("Floor Digest (test)");
    seedItem(p, "Ashwagandha (test)", { priority: "low" });
    seedItem(p, "Vitamin D (test)", { priority: "high" });
    seedItem(p, "Testoprim (test med)", {
      kind: "medication",
      priority: "low",
    });
    const input = gatherDigestInput(p, "Floor Digest (test)");
    // high supplement + low medication notify; the low supplement is silent.
    expect(input.doseCount).toBe(2);
  });

  it("escalation is NEVER priority-gated: a critical low-priority med still escalates", async () => {
    const p = createProfile("Floor Escalate (test)");
    const { doseId } = seedItem(p, "Warfarin (test)", {
      kind: "medication",
      priority: "low",
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

  it("a critical LOW supplement stays in the (unfiltered) escalation gather even though the send excluded it", () => {
    const p = createProfile("Floor EscGather (test)");
    seedItem(p, "Critical Low Supp (test)", {
      priority: "low",
      critical: 1,
    });
    // The safety-tier gather (collectWindowDoses) is deliberately unfiltered…
    const gathered = collectWindowDoses(p, "Morning", today(p));
    expect(
      gathered.some((e) => e.supp.name === "Critical Low Supp (test)")
    ).toBe(true);
    // …while the send assembly excludes it.
    expect(buildSupplementReminder(p, "Morning")).toBeNull();
  });
});
