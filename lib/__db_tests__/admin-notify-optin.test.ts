// DB INTEGRATION TIER — the admin notification opt-in, end to end over the real
// schema, the real reminder builder and the real fan-out (issue #2345).
//
// This reproduces the SHAPE of the instance the defect was found on, which is also
// the shape of the overwhelmingly common install: ONE admin login, `own_profile_id`
// pointing at their own profile, and a household member on another profile carrying
// a live dose. The fan-out deliberately does not inherit admin-sees-all, so before
// the opt-in that member's reminder is BUILT and delivered to nobody — for weeks, on
// the real instance, including a `must`-tier medication on a toddler. What made that
// unrecoverable was that `setGrants` refused to write the row the policy names.
//
// The action tier proves the WRITE now lands (lib/__action_tests__/grants.actions.test.ts);
// this proves what the row BUYS: a real recipient, on a real channel, attributed.
//
// Every value is synthetic — reserved-range fake chat ids, obviously fictional names.

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { setTelegramBotConfig, setTimezone } from "@/lib/settings";
import { buildIntakeReminderForSlots } from "@/lib/notifications/supplements";
import { prefixForProfile } from "@/lib/notifications/attribution";
import { prefixMessage } from "@/lib/notifications/types";
import {
  managingLoginIdsForProfile,
  resolveTelegramRecipients,
} from "@/lib/notifications/fan-out";

const ADMIN_CHAT = "5551234";

function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setTimezone(id, "UTC");
  return id;
}

// A daily `should` supplement with one morning dose — the #2173 fixture's shape:
// obligation `should` reminds and counts, so there is genuinely something to send.
function seedMorningDose(profileId: number, name: string): void {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation)
         VALUES (?, ?, 1, 'supplement', 'daily', 'should')`
      )
      .run(profileId, name).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '1 cap', 'morning', 'any', 0)`
  ).run(itemId);
}

describe("a lone admin can be reached about another profile only after opting in (#2345)", () => {
  let adminLoginId: number;
  let adminSelf: number;
  let ward: number;

  beforeEach(() => {
    setTelegramBotConfig({
      telegramBotToken: "bot-for-tests",
      telegramMode: "poll",
    });
    // A clean instance: the bootstrap admin + its grant row are what boot writes, and
    // this file is about a DIFFERENT admin's opt-in, so start from no logins at all.
    db.prepare("DELETE FROM login_settings").run();
    db.prepare("DELETE FROM login_profiles").run();
    db.prepare("DELETE FROM logins").run();

    adminSelf = newProfile("Admin Ashling");
    ward = newProfile("Ward Wilhelmina");
    seedMorningDose(ward, "Ward Vitamin D (fixture)");

    adminLoginId = Number(
      db
        .prepare(
          "INSERT INTO logins (username, password_hash, role) VALUES ('lone-admin', 'x', 'admin')"
        )
        .run().lastInsertRowid
    );
    // The instance's own shape: the admin's own profile is the ONLY thing they are in
    // the recipient union for — one grant row, plus own_profile_id on the same profile.
    db.prepare("UPDATE logins SET own_profile_id = ? WHERE id = ?").run(
      adminSelf,
      adminLoginId
    );
    db.prepare(
      "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')"
    ).run(adminLoginId, adminSelf);
    db.prepare(
      "INSERT INTO login_settings (login_id, key, value) VALUES (?, 'telegram_enabled', '1'), (?, 'telegram_chat_id', ?)"
    ).run(adminLoginId, adminLoginId, ADMIN_CHAT);
  });

  it("builds the ward's reminder and fans it out to NOBODY before the opt-in", () => {
    // There IS something to say — this is not a quiet profile.
    const built = buildIntakeReminderForSlots(ward, ["Morning"]);
    expect(built).not.toBeNull();
    expect(built!.message.title.length).toBeGreaterThan(0);

    // And nobody hears it. The admin sees this profile in the UI all day; the push
    // reaches no channel, and there is no other login on the instance.
    expect(managingLoginIdsForProfile(ward)).toEqual([]);
    expect(resolveTelegramRecipients(ward)).toEqual([]);

    // Their OWN profile is unaffected — that half always worked, which is exactly why
    // the gap read as "notifications work" while three profiles went silent.
    expect(managingLoginIdsForProfile(adminSelf)).toEqual([adminLoginId]);
  });

  it("delivers to the admin's chat, attributed, once the row exists", () => {
    // The opt-in row setGrants now writes (its write path is pinned in the action
    // tier). For an admin it means exactly "notify me about this profile"; the
    // 'write' level is the inert column default nothing reads back for them.
    db.prepare(
      "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')"
    ).run(adminLoginId, ward);

    expect(managingLoginIdsForProfile(ward)).toEqual([adminLoginId]);
    expect(resolveTelegramRecipients(ward)).toEqual([
      { loginId: adminLoginId, chatId: ADMIN_CHAT },
    ]);

    // And it arrives attributed (#377): the admin's chat now carries two profiles'
    // otherwise-identical reminders, so the "[Name] " prefix is what keeps them apart.
    const built = buildIntakeReminderForSlots(ward, ["Morning"]);
    expect(built).not.toBeNull();
    const attributed = prefixMessage(built!.message, prefixForProfile(ward));
    expect(attributed.title).toContain("[Ward Wilhelmina]");
  });

  it("adds the ward only — the admin is not subscribed to anything else", () => {
    const bystander = newProfile("Bystander Bex");
    seedMorningDose(bystander, "Bystander D3 (fixture)");
    db.prepare(
      "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')"
    ).run(adminLoginId, ward);

    // Opting into one profile is not opting into the instance. A new profile has no
    // recipient until someone chooses one — admins are never auto-granted — and its
    // silence really is a routing absence, not an empty day: the reminder builds.
    expect(buildIntakeReminderForSlots(bystander, ["Morning"])).not.toBeNull();
    expect(managingLoginIdsForProfile(bystander)).toEqual([]);
    expect(resolveTelegramRecipients(bystander)).toEqual([]);
  });
});
