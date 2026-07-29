// DB INTEGRATION TIER — the household dose round's BUILDER (issue #1459).
//
// Per the #448 rule, a builder that GATHERS DB state and hands it to a pure engine
// ships a realistic fixture test, because every confirmed engine defect in this repo
// has lived in the builder's INPUT layer — which the pure tier structurally cannot
// see (it takes pre-gathered arrays). The exposed layers here are exactly that:
//
//   • per-member CONTEXT — each member's due set is computed in THAT member's own
//     timezone/today(), never the receiver's (the two-timezone fixture below);
//   • the §1 ACCESS filter — a read-only grant, a revoked grant and an unselected
//     profile must all drop out, resolved against LIVE grants, not the stored list;
//   • what counts as DUE — PRN excluded, already-taken/skipped excluded.
//
// It also drives the inbound TAP through the real callback dispatcher (with only the
// raw Telegram transport stubbed) so the access re-check and the typed-outcome answer
// are asserted, not assumed.
//
// Every fixture value is synthetic: made-up household names, made-up supplements,
// chat ids in the reserved 555-01xx range. No PHI.

import { vi, describe, it, expect, beforeEach } from "vitest";

// The shared action-tier setup (lib/__action_tests__/setup.ts, a setupFile for this
// whole config) replaces @/lib/auth with a session-shaped stub. This suite must
// exercise the REAL access resolution — `accessForProfile`/`accessibleProfilesForLogin`
// over genuine login_profiles rows, the same functions the in-app cross-profile confirm
// gates on — so restore the actual module for this file. A file-level vi.mock wins over
// the setup file's, and nothing here drives a Server Action, so nothing needs the stub.
vi.mock("@/lib/auth", async (importActual) => await importActual());

// Stub ONLY the raw transport; the chokepoint, the pure render and every decision
// stay real.
vi.mock("@/lib/notifications/telegram-api", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/notifications/telegram-api")>();
  return {
    ...actual,
    answerCallbackQuery: vi.fn(async () => {}),
    editMessageTextRaw: vi.fn(async () => {}),
    editMessageReplyMarkupRaw: vi.fn(async () => {}),
    sendMessageRaw: vi.fn(async () => {}),
  };
});

import { db, today } from "@/lib/db";
import { setProfileHouseholdRound } from "@/lib/settings";
import {
  buildHouseholdRound,
  collectHouseholdRound,
  householdRoundMarkerKey,
} from "@/lib/notifications/household-round";
import {
  householdRoundOfferableMembers,
  resolveHouseholdTapAccess,
} from "@/lib/notifications/household-round-access";
import { householdDoseCallback } from "@/lib/notifications/callback-data";
import { handleCallbackQuery } from "@/lib/notifications/telegram-callbacks";
import { answerCallbackQuery } from "@/lib/notifications/telegram-api";

// Reserved-range synthetic chat ids (never dialable).
const CAREGIVER_CHAT = "5550101";
const STRANGER_CHAT = "5550199";

function newProfile(name: string, timezone?: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  if (timezone) {
    db.prepare(
      "INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'timezone', ?)"
    ).run(id, timezone);
  }
  return id;
}

// A login whose OWN profile is `ownProfileId`, with a Telegram chat.
function newCaregiverLogin(
  ownProfileId: number,
  chatId: string,
  role: "admin" | "member" = "member"
): number {
  const loginId = Number(
    db
      .prepare(
        "INSERT INTO logins (username, password_hash, role, own_profile_id) VALUES (?, 'x', ?, ?)"
      )
      .run(`hh_${ownProfileId}_${chatId}_${Math.random()}`, role, ownProfileId)
      .lastInsertRowid
  );
  grant(loginId, ownProfileId, "write");
  db.prepare(
    "INSERT INTO login_settings (login_id, key, value) VALUES (?, 'telegram_enabled', '1')"
  ).run(loginId);
  db.prepare(
    "INSERT INTO login_settings (login_id, key, value) VALUES (?, 'telegram_chat_id', ?)"
  ).run(loginId, chatId);
  return loginId;
}

function grant(loginId: number, profileId: number, access: "read" | "write") {
  db.prepare(
    `INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, ?)
       ON CONFLICT(login_id, profile_id) DO UPDATE SET access = excluded.access`
  ).run(loginId, profileId, access);
}

function revoke(loginId: number, profileId: number) {
  db.prepare(
    "DELETE FROM login_profiles WHERE login_id = ? AND profile_id = ?"
  ).run(loginId, profileId);
}

// A daily scheduled supplement with one morning dose — due every day, in the
// profile's own timezone.
function addDailyDose(
  profileId: number,
  name: string,
  opts: { amount?: string; asNeeded?: boolean; time?: string } = {}
): { itemId: number; doseId: number } {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation)
         VALUES (?, ?, 1, 'supplement', 'daily', 'should')`
      )
      .run(profileId, name, opts.asNeeded ? 1 : 0).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, ?, ?, 'any', 0)`
      )
      .run(itemId, opts.amount ?? "1 cap", opts.time ?? "morning")
      .lastInsertRowid
  );
  return { itemId, doseId };
}

function logDose(
  profileId: number,
  doseId: number,
  itemId: number,
  status: "taken" | "skipped"
): void {
  db.prepare(
    `INSERT INTO intake_item_logs (dose_id, item_id, date, status)
     VALUES (?, ?, ?, ?)`
  ).run(doseId, itemId, today(profileId), status);
}

// The standing household: a caregiver (the receiver) plus two members they hold write
// access to, deliberately in a DIFFERENT timezone from the receiver — ~21h apart, so
// the member's own `today()` can differ from the receiver's.
function household(tag: string) {
  const receiver = newProfile(`${tag} Caregiver`, "Pacific/Kiritimati"); // UTC+14
  const ada = newProfile(`${tag} Ada`, "Pacific/Niue"); // UTC-11
  const kai = newProfile(`${tag} Kai`, "Pacific/Kiritimati");
  const loginId = newCaregiverLogin(receiver, CAREGIVER_CHAT);
  grant(loginId, ada, "write");
  grant(loginId, kai, "write");
  return { receiver, ada, kai, loginId };
}

const SLOTS = ["Morning"] as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("householdRoundOfferableMembers — the §1 offer set", () => {
  it("offers the write-granted members, never the receiver itself", () => {
    const h = household("Offer");
    expect(
      householdRoundOfferableMembers(h.receiver).map((m) => m.profileId)
    ).toEqual([h.ada, h.kai]);
  });

  it("excludes a READ-only grant — the round must never confirm across one", () => {
    const h = household("ReadOnly");
    grant(h.loginId, h.kai, "read");
    expect(
      householdRoundOfferableMembers(h.receiver).map((m) => m.profileId)
    ).toEqual([h.ada]);
  });

  it("offers nothing when the profile is no login's OWN profile", () => {
    // A profile that merely has a granted login is not a receiver: the round is a
    // push into the receiver's own pocket.
    const orphan = newProfile("Orphan");
    const other = newProfile("Other");
    const loginId = Number(
      db
        .prepare(
          "INSERT INTO logins (username, password_hash, role) VALUES (?, 'x', 'member')"
        )
        .run(`no_own_${Math.random()}`).lastInsertRowid
    );
    grant(loginId, orphan, "write");
    grant(loginId, other, "write");
    expect(householdRoundOfferableMembers(orphan)).toEqual([]);
  });
});

describe("collectHouseholdRound — per-member context (#1095)", () => {
  it("gathers each member's doses in THAT member's own day, not the receiver's", () => {
    const h = household("TZ");
    addDailyDose(h.ada, "Iron", { amount: "65 mg" });
    setProfileHouseholdRound(h.receiver, {
      enabled: true,
      memberIds: [h.ada, h.kai],
    });

    const sections = collectHouseholdRound(h.receiver, SLOTS);
    expect(sections).toHaveLength(1);
    // The section's date is Ada's own profile-local day — the token stamped on her
    // confirm button — and the fixture's zones are far enough apart that it can
    // differ from the receiver's. Either way it must be ADA's.
    expect(sections[0].profileId).toBe(h.ada);
    expect(sections[0].date).toBe(today(h.ada));
    expect(sections[0].date).not.toBe(today(h.receiver));
  });

  it("omits members with nothing due; an empty round builds no message", () => {
    const h = household("Empty");
    setProfileHouseholdRound(h.receiver, {
      enabled: true,
      memberIds: [h.ada, h.kai],
    });
    expect(collectHouseholdRound(h.receiver, SLOTS)).toEqual([]);
    expect(buildHouseholdRound(h.receiver, SLOTS)).toBeNull();
  });

  it("excludes PRN items — a PRN dose is never scheduled-due", () => {
    const h = household("Prn");
    addDailyDose(h.ada, "Paracetamol PRN", { asNeeded: true });
    setProfileHouseholdRound(h.receiver, { enabled: true, memberIds: [h.ada] });
    expect(collectHouseholdRound(h.receiver, SLOTS)).toEqual([]);
  });

  it("excludes doses already taken OR deliberately skipped (#232)", () => {
    const h = household("Resolved");
    const taken = addDailyDose(h.ada, "Vitamin D3", { amount: "2000 IU" });
    const skipped = addDailyDose(h.ada, "Magnesium");
    const pending = addDailyDose(h.ada, "Iron");
    setProfileHouseholdRound(h.receiver, { enabled: true, memberIds: [h.ada] });
    logDose(h.ada, taken.doseId, taken.itemId, "taken");
    logDose(h.ada, skipped.doseId, skipped.itemId, "skipped");

    const sections = collectHouseholdRound(h.receiver, SLOTS);
    expect(sections[0].doses.map((d) => d.doseId)).toEqual([pending.doseId]);
  });

  it("covers only SELECTED members, and drops one whose grant was revoked", () => {
    const h = household("Revoked");
    addDailyDose(h.ada, "Iron");
    addDailyDose(h.kai, "Melatonin");
    // Kai has a due dose but was never ticked.
    setProfileHouseholdRound(h.receiver, { enabled: true, memberIds: [h.ada] });
    expect(
      collectHouseholdRound(h.receiver, SLOTS).map((s) => s.profileId)
    ).toEqual([h.ada]);

    // Now tick both, then revoke Ada: the STORED selection still names her, but live
    // grants are the authority, so she drops out silently.
    setProfileHouseholdRound(h.receiver, {
      enabled: true,
      memberIds: [h.ada, h.kai],
    });
    revoke(h.loginId, h.ada);
    expect(
      collectHouseholdRound(h.receiver, SLOTS).map((s) => s.profileId)
    ).toEqual([h.kai]);
  });

  it("sends nothing while the subscription is off", () => {
    const h = household("Off");
    addDailyDose(h.ada, "Iron");
    setProfileHouseholdRound(h.receiver, {
      enabled: false,
      memberIds: [h.ada],
    });
    expect(collectHouseholdRound(h.receiver, SLOTS)).toEqual([]);
  });

  it("builds a message with one confirm button per due dose", () => {
    const h = household("Msg");
    const ada = addDailyDose(h.ada, "Iron", { amount: "65 mg" });
    setProfileHouseholdRound(h.receiver, { enabled: true, memberIds: [h.ada] });
    const msg = buildHouseholdRound(h.receiver, SLOTS)!;
    expect(msg.kind).toBe("dose");
    expect(msg.actions).toHaveLength(1);
    expect(msg.actions![0].data).toBe(
      householdDoseCallback({
        receiverProfileId: h.receiver,
        memberProfileId: h.ada,
        doseId: ada.doseId,
        itemId: ada.itemId,
        date: today(h.ada),
      })
    );
  });

  it("keys its per-day marker on the receiver's own slot", () => {
    expect(householdRoundMarkerKey("Morning")).toBe(
      "notify_last_household_Morning"
    );
  });
});

describe("resolveHouseholdTapAccess + the tap handler (#1459 §3)", () => {
  function tapQuery(data: string, chatId: string) {
    return {
      id: "cbq-hh",
      data,
      message: {
        message_id: 55,
        chat: { id: chatId },
        text: "💊 Household doses",
        reply_markup: {
          inline_keyboard: [[{ text: "✓", callback_data: data }]],
        },
      },
    };
  }

  function setup(tag: string) {
    const h = household(tag);
    const dose = addDailyDose(h.ada, "Iron", { amount: "65 mg" });
    setProfileHouseholdRound(h.receiver, { enabled: true, memberIds: [h.ada] });
    const token = householdDoseCallback({
      receiverProfileId: h.receiver,
      memberProfileId: h.ada,
      doseId: dose.doseId,
      itemId: dose.itemId,
      date: today(h.ada),
    });
    return { ...h, dose, token };
  }

  function logsFor(doseId: number): number {
    return (
      db
        .prepare("SELECT COUNT(*) AS n FROM intake_item_logs WHERE dose_id = ?")
        .get(doseId) as { n: number }
    ).n;
  }

  it("HAPPY PATH: writes the member's log and answers from the outcome", async () => {
    const s = setup("TapOk");
    expect(
      resolveHouseholdTapAccess(CAREGIVER_CHAT, {
        receiverProfileId: s.receiver,
        memberProfileId: s.ada,
      })
    ).toEqual({ kind: "allowed", loginId: s.loginId });

    await handleCallbackQuery(tapQuery(s.token, CAREGIVER_CHAT));
    expect(logsFor(s.dose.doseId)).toBe(1);
    // The log lands on the MEMBER's row, on the MEMBER's day.
    const row = db
      .prepare("SELECT date, status FROM intake_item_logs WHERE dose_id = ?")
      .get(s.dose.doseId) as { date: string; status: string };
    expect(row).toEqual({ date: today(s.ada), status: "taken" });
    expect(vi.mocked(answerCallbackQuery).mock.calls[0][1]).toContain(
      "Logged ✅"
    );
  });

  it("IDEMPOTENT re-tap answers honestly and writes nothing more", async () => {
    const s = setup("TapTwice");
    await handleCallbackQuery(tapQuery(s.token, CAREGIVER_CHAT));
    await handleCallbackQuery(tapQuery(s.token, CAREGIVER_CHAT));
    expect(logsFor(s.dose.doseId)).toBe(1);
  });

  it("REVOKED grant: refuses, names the reason, and writes NOTHING", async () => {
    const s = setup("TapRevoked");
    revoke(s.loginId, s.ada);
    expect(
      resolveHouseholdTapAccess(CAREGIVER_CHAT, {
        receiverProfileId: s.receiver,
        memberProfileId: s.ada,
      })
    ).toEqual({ kind: "revoked" });

    await handleCallbackQuery(tapQuery(s.token, CAREGIVER_CHAT));
    expect(logsFor(s.dose.doseId)).toBe(0);
    const answer = vi.mocked(answerCallbackQuery).mock.calls[0][1] ?? "";
    expect(answer).toContain("no longer have access");
    expect(answer).not.toContain("✅");
  });

  it("READ-ONLY grant: refuses — never confirm across a read grant", async () => {
    const s = setup("TapReadOnly");
    grant(s.loginId, s.ada, "read");
    await handleCallbackQuery(tapQuery(s.token, CAREGIVER_CHAT));
    expect(logsFor(s.dose.doseId)).toBe(0);
  });

  it("WRONG CHAT: a token replayed in another chat writes nothing", async () => {
    const s = setup("TapWrongChat");
    // A stranger's chat, mapped to its own unrelated login.
    const stranger = newProfile("Stranger");
    newCaregiverLogin(stranger, STRANGER_CHAT);
    expect(
      resolveHouseholdTapAccess(STRANGER_CHAT, {
        receiverProfileId: s.receiver,
        memberProfileId: s.ada,
      })
    ).toEqual({ kind: "wrong-chat" });

    await handleCallbackQuery(tapQuery(s.token, STRANGER_CHAT));
    expect(logsFor(s.dose.doseId)).toBe(0);
  });

  it("UNSUBSCRIBED: turning the round off refuses in-flight buttons", async () => {
    const s = setup("TapUnsub");
    setProfileHouseholdRound(s.receiver, {
      enabled: false,
      memberIds: [s.ada],
    });
    await handleCallbackQuery(tapQuery(s.token, CAREGIVER_CHAT));
    expect(logsFor(s.dose.doseId)).toBe(0);
    expect(vi.mocked(answerCallbackQuery).mock.calls[0][1]).toContain(
      "no longer set up"
    );
  });

  it("DESELECTED member: refuses even though the grant still holds", async () => {
    const s = setup("TapDeselect");
    setProfileHouseholdRound(s.receiver, { enabled: true, memberIds: [s.kai] });
    await handleCallbackQuery(tapQuery(s.token, CAREGIVER_CHAT));
    expect(logsFor(s.dose.doseId)).toBe(0);
  });

  it("PAUSED item: reaches the write and answers from its typed outcome", async () => {
    const s = setup("TapPaused");
    db.prepare("UPDATE intake_items SET active = 0 WHERE id = ?").run(
      s.dose.itemId
    );
    await handleCallbackQuery(tapQuery(s.token, CAREGIVER_CHAT));
    expect(logsFor(s.dose.doseId)).toBe(0);
    const answer = vi.mocked(answerCallbackQuery).mock.calls[0][1] ?? "";
    expect(answer).toContain("paused");
    expect(answer).not.toContain("✅");
  });

  it("RETIRED dose: refuses at the write, never a reflexive confirm", async () => {
    const s = setup("TapRetired");
    db.prepare("UPDATE intake_item_doses SET retired = 1 WHERE id = ?").run(
      s.dose.doseId
    );
    await handleCallbackQuery(tapQuery(s.token, CAREGIVER_CHAT));
    expect(logsFor(s.dose.doseId)).toBe(0);
    expect(vi.mocked(answerCallbackQuery).mock.calls[0][1]).not.toContain("✅");
  });

  it("a forged dose id belonging to ANOTHER profile writes nothing", async () => {
    const s = setup("TapForged");
    // Kai's dose, presented under Ada's member id.
    const kaiDose = addDailyDose(s.kai, "Melatonin");
    const forged = householdDoseCallback({
      receiverProfileId: s.receiver,
      memberProfileId: s.ada,
      doseId: kaiDose.doseId,
      itemId: kaiDose.itemId,
      date: today(s.ada),
    });
    await handleCallbackQuery(tapQuery(forged, CAREGIVER_CHAT));
    expect(logsFor(kaiDose.doseId)).toBe(0);
  });
});
