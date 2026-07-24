// DB INTEGRATION TIER — login-scoped notification channels (issue #1072). Covers the
// two load-bearing halves the pure tier can't see:
//
//   1. The migration (profile channel → login channel) over a realistic
//      pre-migration fixture: the clean single-caregiver case derives ONE login
//      channel and retires the old keys; the ambiguous multi-chat case preserves
//      delivery AND raises the review flag.
//   2. The fan-out DELIVERY resolution: a per-profile event reaches every managing
//      login (deduped by shared chat), a muted profile is held for THAT login only,
//      and an admin with no explicit grant is NOT fanned the event (no admin bypass).
//
// Every value is synthetic (fake chat ids in the reserved 5550xxx range, obviously
// fictional names, no phones).

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { up as migrateChannels } from "@/lib/migrations/versions/105-login-notification-channels";
import {
  getLoginTelegram,
  getLoginTelegramDisabledKinds,
  getNotifyReviewNeeded,
  getProfileSetting,
  setProfileSetting,
  setProfileMutedForLogin,
  getProfilesByTelegramChatId,
} from "@/lib/settings";
import {
  managingLoginIdsForProfile,
  resolveTelegramRecipients,
} from "@/lib/notifications/fan-out";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}
function newLogin(role: "admin" | "member", name: string): number {
  return Number(
    db
      .prepare(
        "INSERT INTO logins (username, password_hash, role) VALUES (?, 'x', ?)"
      )
      .run(name, role).lastInsertRowid
  );
}
function grant(loginId: number, profileId: number): void {
  db.prepare(
    "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write') ON CONFLICT(login_id, profile_id) DO NOTHING"
  ).run(loginId, profileId);
}
function setProfileChannel(
  profileId: number,
  chatId: string,
  disabled: string[] = []
): void {
  setProfileSetting(profileId, "telegram_chat_id", chatId);
  setProfileSetting(profileId, "telegram_enabled", "1");
  if (disabled.length)
    setProfileSetting(
      profileId,
      "telegram_notify_disabled_kinds",
      JSON.stringify(disabled)
    );
}

function setLoginChannel(loginId: number, chatId: string): void {
  db.prepare(
    "INSERT INTO login_settings (login_id, key, value) VALUES (?, 'telegram_enabled', '1'), (?, 'telegram_chat_id', ?)"
  ).run(loginId, loginId, chatId);
}
function setOwnProfile(loginId: number, profileId: number): void {
  db.prepare("UPDATE logins SET own_profile_id = ? WHERE id = ?").run(
    profileId,
    loginId
  );
}

// A clean instance for each migration case: wipe the tables the migration reads/writes.
beforeEach(() => {
  db.prepare("DELETE FROM login_settings").run();
  db.prepare("DELETE FROM login_profiles").run();
  db.prepare("DELETE FROM logins").run();
  db.prepare(
    "DELETE FROM profile_settings WHERE key LIKE 'telegram_%' OR key LIKE 'notify_%'"
  ).run();
});

describe("channel migration — clean single-caregiver case", () => {
  it("derives one login channel from the granted profiles' shared chat and retires the old keys", () => {
    // One caregiver login managing two family profiles, both delivering to the SAME
    // family chat (the overwhelming common case — the model's own workaround).
    const parent = newProfile("Parent (mig)");
    const kid = newProfile("Kid (mig)");
    const caregiver = newLogin("member", "caregiver-mig");
    grant(caregiver, parent);
    grant(caregiver, kid);
    setProfileChannel(parent, "5550001", ["milestone"]);
    setProfileChannel(kid, "5550001");

    migrateChannels(db);

    const chan = getLoginTelegram(caregiver);
    expect(chan.telegramEnabled).toBe(true);
    expect(chan.telegramChatId).toBe("5550001");
    // Disabled-kinds carried from the winning chat's contributing profile.
    expect(getLoginTelegramDisabledKinds(caregiver)).toEqual(["milestone"]);
    // Clean case → NO review flag.
    expect(getNotifyReviewNeeded(caregiver)).toBe(false);
    // Old per-profile keys are retired.
    expect(getProfileSetting(parent, "telegram_chat_id")).toBeUndefined();
    expect(getProfileSetting(kid, "telegram_enabled")).toBeUndefined();
    // Delivery preserved: both profiles fan out to the caregiver's chat.
    expect(resolveTelegramRecipients(parent)).toEqual([
      { loginId: caregiver, chatId: "5550001" },
    ]);
    expect(resolveTelegramRecipients(kid)).toEqual([
      { loginId: caregiver, chatId: "5550001" },
    ]);
  });
});

describe("channel migration — ambiguous multi-chat case", () => {
  it("assigns the most-common chat, preserves delivery, and raises the review flag", () => {
    // One login manages three profiles: two on chat A, one on chat B → chat A wins,
    // but the divergent chat B makes it ambiguous.
    const a1 = newProfile("Amb A1");
    const a2 = newProfile("Amb A2");
    const b1 = newProfile("Amb B1");
    const login = newLogin("member", "amb-login");
    grant(login, a1);
    grant(login, a2);
    grant(login, b1);
    setProfileChannel(a1, "5550010");
    setProfileChannel(a2, "5550010");
    setProfileChannel(b1, "5550099");

    migrateChannels(db);

    const chan = getLoginTelegram(login);
    expect(chan.telegramChatId).toBe("5550010"); // most common wins
    expect(getNotifyReviewNeeded(login)).toBe(true); // ambiguity flagged
    // Delivery preserved for the profiles on the winning chat.
    expect(resolveTelegramRecipients(a1)).toEqual([
      { loginId: login, chatId: "5550010" },
    ]);
  });
});

describe("channel migration — bootstrap admin continuity", () => {
  it("materializes an explicit grant so a single admin keeps receiving (no admin bypass)", () => {
    // The single-user install: ONE admin login (no grant rows) acting as profile 1
    // with a chat on that profile. The fan-out drops admin-bypass, so the migration
    // must create an explicit grant to preserve delivery.
    const p1 = newProfile("Solo (mig)");
    const admin = newLogin("admin", "solo-admin");
    setProfileChannel(p1, "5550500");

    migrateChannels(db);

    expect(getLoginTelegram(admin).telegramChatId).toBe("5550500");
    // The grant was materialized → fan-out reaches the admin.
    expect(managingLoginIdsForProfile(p1)).toContain(admin);
    expect(resolveTelegramRecipients(p1)).toEqual([
      { loginId: admin, chatId: "5550500" },
    ]);
  });
});

describe("channel migration — multi-admin household (#1365 gap 2)", () => {
  // Two admin logins that each pointed a DIFFERENT profile's chat at their own
  // personal chat. Migration 105 derives every admin's channel over the SAME set
  // (all profiles), so the global majority chat wins for BOTH admins — one admin
  // silently inherits the other's chat. This pins that KNOWN, immutable-migration
  // behavior AND its safety net: because ≥2 distinct chats exist across the instance,
  // the derivation is ambiguous for both admins, so BOTH are flagged for review and
  // nudged to reconfigure on next login. (Migration 105 is shipped/one-shot and had
  // already DELETED the per-profile source chats, and own_profile_id is unpopulated
  // at migration time — migration 104 adds the column but never backfills it — so no
  // corrective migration can re-derive the correct per-admin chat; the review nudge
  // is the recovery path. See PR for the full argument.)
  it("collapses distinct admins onto the majority chat but flags both for review", () => {
    // Three profiles: two carry admin-A's personal chat, one carries admin-B's.
    // Chat A is the global majority → wins for BOTH admins.
    const pA1 = newProfile("Fam A1 (multi-admin)");
    const pA2 = newProfile("Fam A2 (multi-admin)");
    const pB1 = newProfile("Fam B1 (multi-admin)");
    const adminA = newLogin("admin", "admin-a-multi");
    const adminB = newLogin("admin", "admin-b-multi");
    setProfileChannel(pA1, "5550301");
    setProfileChannel(pA2, "5550301");
    setProfileChannel(pB1, "5550302");

    migrateChannels(db);

    // Known collapse: BOTH admins get the instance-majority chat (A), not their own.
    expect(getLoginTelegram(adminA).telegramChatId).toBe("5550301");
    expect(getLoginTelegram(adminB).telegramChatId).toBe("5550301");
    // Safety net: the ambiguity (≥2 distinct chats over the accessible set) flags
    // BOTH admins to confirm their notification settings.
    expect(getNotifyReviewNeeded(adminA)).toBe(true);
    expect(getNotifyReviewNeeded(adminB)).toBe(true);
  });
});

describe("inbound tap resolution — own_profile_id-only login (#1365 gap 1)", () => {
  // A login whose access to a profile comes ONLY via own_profile_id (#1013), with no
  // explicit login_profiles grant. Outbound fan-out already reaches it; inbound
  // resolution must now agree so its dose-confirm taps / food logging are accepted.
  it("resolves the profile for a chat whose login owns it via own_profile_id only", () => {
    const me = newProfile("Me (inbound own)");
    const login = newLogin("member", "own-inbound-login");
    setOwnProfile(login, me); // NO login_profiles grant
    setLoginChannel(login, "5550333");

    // Both directions now agree on the own-profile-only login.
    expect(managingLoginIdsForProfile(me)).toContain(login);
    expect(getProfilesByTelegramChatId("5550333")).toEqual([me]);
  });

  it("unions own-profile and granted profiles, and honors the per-(login,profile) mute", () => {
    const own = newProfile("Own (inbound union)");
    const granted = newProfile("Granted (inbound union)");
    const login = newLogin("member", "union-inbound-login");
    setOwnProfile(login, own);
    grant(login, granted);
    setLoginChannel(login, "5550344");

    expect(
      getProfilesByTelegramChatId("5550344").sort((a, b) => a - b)
    ).toEqual([own, granted].sort((a, b) => a - b));

    // Muting the own profile for THIS login holds it out of inbound scope too.
    setProfileMutedForLogin(login, own, true);
    expect(getProfilesByTelegramChatId("5550344")).toEqual([granted]);
  });
});

describe("fan-out delivery resolution", () => {
  it("fans a per-profile event to BOTH co-parent logins, one per distinct chat", () => {
    const kid = newProfile("Kid (fanout)");
    const mom = newLogin("member", "mom-fanout");
    const dad = newLogin("member", "dad-fanout");
    grant(mom, kid);
    grant(dad, kid);
    // Distinct chats → two recipients.
    db.prepare(
      "INSERT INTO login_settings (login_id, key, value) VALUES (?, 'telegram_enabled', '1'), (?, 'telegram_chat_id', '5550700')"
    ).run(mom, mom);
    db.prepare(
      "INSERT INTO login_settings (login_id, key, value) VALUES (?, 'telegram_enabled', '1'), (?, 'telegram_chat_id', '5550701')"
    ).run(dad, dad);

    const recips = resolveTelegramRecipients(kid);
    expect(recips.map((r) => r.chatId).sort()).toEqual(["5550700", "5550701"]);
    expect(recips).toHaveLength(2);
  });

  it("collapses two co-parents on the SAME shared chat to one delivery", () => {
    const kid = newProfile("Kid (shared)");
    const mom = newLogin("member", "mom-shared");
    const dad = newLogin("member", "dad-shared");
    grant(mom, kid);
    grant(dad, kid);
    db.prepare(
      "INSERT INTO login_settings (login_id, key, value) VALUES (?, 'telegram_enabled', '1'), (?, 'telegram_chat_id', '5550800')"
    ).run(mom, mom);
    db.prepare(
      "INSERT INTO login_settings (login_id, key, value) VALUES (?, 'telegram_enabled', '1'), (?, 'telegram_chat_id', '5550800')"
    ).run(dad, dad);

    expect(resolveTelegramRecipients(kid)).toHaveLength(1);
  });

  it("holds a muted profile for THAT login only", () => {
    const kid = newProfile("Kid (mute)");
    const mom = newLogin("member", "mom-mute");
    const dad = newLogin("member", "dad-mute");
    grant(mom, kid);
    grant(dad, kid);
    db.prepare(
      "INSERT INTO login_settings (login_id, key, value) VALUES (?, 'telegram_enabled', '1'), (?, 'telegram_chat_id', '5550900')"
    ).run(mom, mom);
    db.prepare(
      "INSERT INTO login_settings (login_id, key, value) VALUES (?, 'telegram_enabled', '1'), (?, 'telegram_chat_id', '5550901')"
    ).run(dad, dad);

    // Dad mutes the kid → only mom's chat remains; mom is unaffected.
    setProfileMutedForLogin(dad, kid, true);
    const recips = resolveTelegramRecipients(kid);
    expect(recips.map((r) => r.chatId)).toEqual(["5550900"]);
  });

  it("does NOT fan a per-profile event to an admin with no explicit grant", () => {
    const kid = newProfile("Kid (no-bypass)");
    const admin = newLogin("admin", "admin-no-bypass");
    // Admin has a Telegram chat but NO grant to the kid.
    db.prepare(
      "INSERT INTO login_settings (login_id, key, value) VALUES (?, 'telegram_enabled', '1'), (?, 'telegram_chat_id', '5550111')"
    ).run(admin, admin);

    expect(managingLoginIdsForProfile(kid)).not.toContain(admin);
    expect(resolveTelegramRecipients(kid)).toEqual([]);
  });

  it("fans to a login by its OWN-PROFILE association even without an explicit grant (#1013)", () => {
    const me = newProfile("Me (own)");
    const login = newLogin("member", "own-profile-login");
    // No login_profiles grant — only the own-profile association (#1013).
    db.prepare("UPDATE logins SET own_profile_id = ? WHERE id = ?").run(
      me,
      login
    );
    db.prepare(
      "INSERT INTO login_settings (login_id, key, value) VALUES (?, 'telegram_enabled', '1'), (?, 'telegram_chat_id', '5550222')"
    ).run(login, login);

    expect(managingLoginIdsForProfile(me)).toContain(login);
    expect(resolveTelegramRecipients(me)).toEqual([
      { loginId: login, chatId: "5550222" },
    ]);
  });
});
