// DB INTEGRATION TIER — whether a member's reminders reach anyone, over the real schema
// (issue #2173).
//
// The fixture is the REAL four-profile household the scope was audited on, reproduced
// in shape:
//
//   • the admin's own profile — routable through `own_profile_id` + a channel;
//   • an adult member — a dosed `should` supplement, UNROUTABLE (no grant, no
//     own-profile link, and the admin ROLE deliberately is not a source);
//   • a child — five active dosed MEDICATIONS, also unroutable;
//   • a toddler — the entire intake roster inactive, so nothing would send.
//
// Every value is synthetic: obviously fictional names, a reserved-range fake chat id.

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import {
  setTelegramBotConfig,
  setTimezone,
  setLoginTelegram,
  setProfileHomeAssistant,
} from "@/lib/settings";
import { getChannels } from "@/lib/notifications";
import {
  instanceHasAnyChannel,
  profileRoutingFacts,
} from "@/lib/notifications/routing";
import { profileUnroutableReason } from "@/lib/queries/household-setup";

const CAREGIVER_CHAT = "5550101";
const TODAY = "2026-08-09";

function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setTimezone(id, "UTC");
  return id;
}

function addItem(
  profileId: number,
  name: string,
  opts: {
    kind?: "supplement" | "medication";
    obligation?: "must" | "should" | "may";
    active?: 0 | 1;
  } = {}
): void {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation)
         VALUES (?, ?, ?, ?, 'daily', ?)`
      )
      .run(
        profileId,
        name,
        opts.active ?? 1,
        opts.kind ?? "supplement",
        opts.obligation ?? "should"
      ).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '1 cap', 'morning', 'any', 0)`
  ).run(itemId);
}

describe("the four-profile household's routing (#2173)", () => {
  let adminLoginId: number;
  let adminSelf: number;
  let adult: number;
  let child: number;
  let toddler: number;

  beforeEach(() => {
    setTelegramBotConfig({
      telegramBotToken: "bot-for-tests",
      telegramMode: "poll",
    });
    // A clean instance — this file is about ONE admin's household, and the bootstrap
    // admin's own grant row would otherwise put a second login in every edge set.
    db.prepare("DELETE FROM login_settings").run();
    db.prepare("DELETE FROM login_profiles").run();
    db.prepare("DELETE FROM logins").run();

    adminSelf = newProfile("Admin Ashling (fixture)");
    adult = newProfile("Adult Aurelia (fixture)");
    child = newProfile("Child Caspian (fixture)");
    toddler = newProfile("Toddler Tamsin (fixture)");

    adminLoginId = Number(
      db
        .prepare(
          "INSERT INTO logins (username, password_hash, role) VALUES ('household-admin', 'x', 'admin')"
        )
        .run().lastInsertRowid
    );
    // The instance's own shape: the admin is in the recipient union for their OWN
    // profile alone (#1013), and the admin ROLE is deliberately not a source for the
    // other three (lib/notifications/fan-out.ts).
    db.prepare("UPDATE logins SET own_profile_id = ? WHERE id = ?").run(
      adminSelf,
      adminLoginId
    );
    setLoginTelegram(adminLoginId, {
      telegramEnabled: true,
      telegramChatId: CAREGIVER_CHAT,
    });

    addItem(adminSelf, "Admin D3 (fixture)");
    addItem(adult, "Adult Magnesium (fixture)", { obligation: "should" });
    for (let i = 0; i < 5; i++)
      addItem(child, `Child Med ${i} (fixture)`, {
        kind: "medication",
        obligation: "must",
      });
    addItem(toddler, "Toddler Multivitamin (fixture)", {
      obligation: "should",
      active: 0,
    });
  });

  it("the admin's OWN profile is routable", () => {
    expect(profileUnroutableReason(adminSelf, TODAY)).toBe(null);
  });

  it("the adult member is unroutable — a dosed `should` item, an EMPTY edge set", () => {
    expect(profileRoutingFacts(adult).managingLoginIds).toEqual([]);
    expect(profileUnroutableReason(adult, TODAY)).toBe("no-managing-login");
  });

  it("a granted-but-channel-less member is unroutable for want of a channel", () => {
    db.prepare(
      "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')"
    ).run(adminLoginId, adult);
    setLoginTelegram(adminLoginId, {
      telegramEnabled: false,
      telegramChatId: "",
    });
    expect(profileUnroutableReason(adult, TODAY)).toBe("no-channel");
  });

  it("an all-inactive roster has nothing to say, so it is NOT unroutable", () => {
    expect(profileUnroutableReason(toddler, TODAY)).toBe(null);
  });

  it("a `login_profiles` grant makes a member routable", () => {
    expect(profileUnroutableReason(child, TODAY)).toBe("no-managing-login");
    db.prepare(
      "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')"
    ).run(adminLoginId, child);
    expect(profileUnroutableReason(child, TODAY)).toBe(null);
  });

  it("the PROFILE-scoped Home Assistant webhook alone makes a member routable", () => {
    setProfileHomeAssistant(adult, {
      enabled: true,
      webhookUrl: "https://ha.example.com/api/webhook/fixture",
      secret: "",
      disabledKinds: [],
    });
    expect(profileUnroutableReason(adult, TODAY)).toBe(null);
  });

  // Anti-drift: the routing reader is NOT `getChannels().some(isConfigured)` (it needs
  // the shape of the gap, and it deliberately ignores mute), but with no mute in play
  // the two must agree about whether ANY route exists — or Settings and the tick would
  // disagree about the same profile.
  it("agrees with the real channel registry about whether a route exists", () => {
    for (const p of [adminSelf, adult, child, toddler]) {
      const facts = profileRoutingFacts(p);
      const routed =
        facts.profileChannelConfigured || facts.channelledLoginIds.length > 0;
      expect(getChannels().some((c) => c.isConfigured(p))).toBe(routed);
      // The instance-wide gate is one fact about the SERVER: identical on every
      // profile's facts, whatever that profile's own routing looks like. This fixture
      // configures the Telegram bot token, so it is open here.
      expect(facts.instanceHasAnyChannel).toBe(true);
    }
  });

  // The owner ruling on PR #2362, over the real settings tiers: with NO channel
  // technology configured anywhere — no Telegram bot, no VAPID keys, no SMTP, no Home
  // Assistant webhook on any profile — the check is silent for every member, and it
  // comes back the moment one exists again.
  describe("the instance gate", () => {
    beforeEach(() => {
      // A BARE instance: no bot token, no VAPID keys, no SMTP (the DB tier configures
      // neither) and no Home Assistant webhook on ANY profile — the HA sweep is
      // instance-wide, so an earlier test's webhook on an earlier profile would still
      // count, correctly.
      setTelegramBotConfig({ telegramBotToken: "", telegramMode: "poll" });
      db.prepare(
        "DELETE FROM profile_settings WHERE key LIKE 'ha_notify_%'"
      ).run();
      expect(instanceHasAnyChannel()).toBe(false);
    });

    it("silences unroutable for EVERY member on a bare instance", () => {
      for (const p of [adult, child])
        expect(profileUnroutableReason(p, TODAY)).toBe(null);
    });

    it("comes back when any ONE technology is configured again", () => {
      // Each of the four, one at a time, from the bare state.
      setTelegramBotConfig({
        telegramBotToken: "bot-for-tests",
        telegramMode: "poll",
      });
      expect(instanceHasAnyChannel()).toBe(true);
      expect(profileUnroutableReason(adult, TODAY)).toBe("no-managing-login");
      setTelegramBotConfig({ telegramBotToken: "", telegramMode: "poll" });

      // Home Assistant has no instance-level half, so its instance question is whether
      // ANY profile has a webhook — here the ADMIN's own profile, which is routable and
      // is not the member being reported on.
      setProfileHomeAssistant(adminSelf, {
        enabled: true,
        webhookUrl: "https://ha.example.com/api/webhook/fixture",
        secret: "",
        disabledKinds: [],
      });
      expect(instanceHasAnyChannel()).toBe(true);
      expect(profileUnroutableReason(adult, TODAY)).toBe("no-managing-login");
    });

    // The fold this must NOT be. Every member of this household is unroutable, and the
    // instance IS configured — the loudest true case, which the "all profiles came back
    // unroutable, therefore suppress" shape would silence.
    it("stays loud when every member is unreachable on a configured instance", () => {
      setTelegramBotConfig({
        telegramBotToken: "bot-for-tests",
        telegramMode: "poll",
      });
      // Take the admin's own channel away: now NO profile on the instance has a route,
      // while the instance's channel technology is plainly configured.
      setLoginTelegram(adminLoginId, {
        telegramEnabled: false,
        telegramChatId: "",
      });
      for (const p of [adminSelf, adult, child]) {
        expect(profileRoutingFacts(p).channelledLoginIds).toEqual([]);
        expect(profileUnroutableReason(p, TODAY)).not.toBe(null);
      }
    });
  });

  it("a quiet profile with no send source is never unroutable", () => {
    const quiet = newProfile("Quiet Quilla (fixture)");
    expect(profileRoutingFacts(quiet).managingLoginIds).toEqual([]);
    expect(profileUnroutableReason(quiet, TODAY)).toBe(null);
  });

  it("a `may`-only roster is not a send source, so it is never unroutable", () => {
    const prn = newProfile("PRN Perrine (fixture)");
    addItem(prn, "PRN Ibuprofen (fixture)", {
      kind: "medication",
      obligation: "may",
    });
    expect(profileUnroutableReason(prn, TODAY)).toBe(null);
  });
});
