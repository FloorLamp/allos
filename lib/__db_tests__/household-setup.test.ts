// DB INTEGRATION TIER — per-member setup health over the real schema (issue #2173).
//
// The fixture is the REAL four-profile household the expanded scope was audited on,
// reproduced in shape:
//
//   • the admin's own profile — routable through `own_profile_id` + a channel, nothing
//     wrong with it;
//   • an adult member — a dosed `should` supplement, UNROUTABLE (no grant, no
//     own-profile link, and the admin ROLE deliberately is not a source), plus an
//     overdue preventive item;
//   • a child — five active dosed MEDICATIONS, also unroutable (the stronger case), and
//     one active item with NO dose row;
//   • a toddler — the entire intake roster inactive, including obligated items.
//
// It then pins the two fixes as SURGICAL: adding a `login_profiles` grant clears the
// UNROUTABLE line and nothing else, and adding a dose clears the UNDOSED line and
// nothing else. That is the whole regression surface — a check that clears something it
// does not own is how a derived setup row starts lying.
//
// Every value is synthetic: obviously fictional names, a reserved-range fake chat id.

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import {
  setTelegramBotConfig,
  setTimezone,
  setLoginTelegram,
  setOnboardingState,
  setProfileHomeAssistant,
} from "@/lib/settings";
import { initialOnboardingState } from "@/lib/onboarding";
import { getChannels } from "@/lib/notifications";
import { profileRoutingFacts } from "@/lib/notifications/routing";
import { dismissFinding } from "@/lib/queries";
import {
  gatherHouseholdSetupFacts,
  householdSetupForProfile,
  profileUnroutableReason,
} from "@/lib/queries/household-setup";
import type { HouseholdSetupCheckId } from "@/lib/household-setup";

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
    dosed?: boolean;
  } = {}
): number {
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
  if (opts.dosed !== false) addDose(itemId);
  return itemId;
}

function addDose(itemId: number): void {
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '1 cap', 'morning', 'any', 0)`
  ).run(itemId);
}

function checkIds(profileId: number): HouseholdSetupCheckId[] {
  return (householdSetupForProfile(profileId, TODAY)?.checks ?? []).map(
    (c) => c.id
  );
}

describe("the four-profile household's setup rows (#2173)", () => {
  let adminLoginId: number;
  let adminSelf: number;
  let adult: number;
  let child: number;
  let toddler: number;
  let undosedChildItem: number;

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

    // Every profile has been through onboarding EXCEPT the toddler, so the
    // never-onboarded check is isolated to one member.
    for (const p of [adminSelf, adult, child])
      setOnboardingState(p, initialOnboardingState());

    addItem(adminSelf, "Admin D3 (fixture)");
    addItem(adult, "Adult Magnesium (fixture)", { obligation: "should" });
    for (let i = 0; i < 5; i++)
      addItem(child, `Child Med ${i} (fixture)`, {
        kind: "medication",
        obligation: "must",
      });
    undosedChildItem = addItem(child, "Child Undosed (fixture)", {
      kind: "medication",
      obligation: "must",
      dosed: false,
    });
    // The toddler's whole roster is inactive, including obligated items — plausibly a
    // bulk sweep, invisible either way. Supplements ONLY, deliberately: the shared
    // onboarding presence reader counts an intake row of kind `medication` (active or
    // not) as a first value, so a toddler with an inactive inhaler is NOT "thin
    // presence" and would not carry the never-onboarded line. Keeping this roster
    // supplement-only lets one member exercise both checks at once.
    addItem(toddler, "Toddler Multivitamin (fixture)", {
      obligation: "should",
      active: 0,
    });
    addItem(toddler, "Toddler Fluoride (fixture)", {
      obligation: "should",
      active: 0,
    });
  });

  it("the admin's OWN profile is healthy — a routable member renders no row", () => {
    expect(householdSetupForProfile(adminSelf, TODAY)).toBe(null);
  });

  it("the adult member is unroutable — a dosed `should` item, an EMPTY edge set", () => {
    expect(profileRoutingFacts(adult).managingLoginIds).toEqual([]);
    expect(profileUnroutableReason(adult, TODAY)).toBe("no-managing-login");
    expect(checkIds(adult)).toContain("unroutable");
    const row = householdSetupForProfile(adult, TODAY)!;
    // Supplement-only content bands at `action`; the child's medications band above it.
    expect(row.tone).toBe("action");
    // Constraint 3: no dismiss may ever be offered while unroutable is in the set.
    expect(row.dismissible).toBe(false);
    // The CTA lands on the GRANT UI — the form `setGrants` can finally act on for an
    // admin since #2345, which is what makes this deep link worth offering.
    expect(row.checks[0].cta).toEqual({
      scope: "login",
      href: "/settings/family",
      label: "Grant a login",
    });
  });

  it("a granted-but-channel-less member points at the channel form instead", () => {
    db.prepare(
      "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')"
    ).run(adminLoginId, adult);
    // The admin's own Telegram chat is enabled, but the LOGIN is now a recipient of a
    // profile it has a channel for, so nothing fires. Drop the chat to reach case 2.
    setLoginTelegram(adminLoginId, {
      telegramEnabled: false,
      telegramChatId: "",
    });
    expect(profileUnroutableReason(adult, TODAY)).toBe("no-channel");
    expect(householdSetupForProfile(adult, TODAY)!.checks[0].cta?.href).toBe(
      "/settings/notifications"
    );
  });

  it("the child's five MEDICATIONS band above the adult's supplement, and the undosed item is its own line", () => {
    const row = householdSetupForProfile(child, TODAY)!;
    expect(row.tone).toBe("caution");
    expect(row.checks.map((c) => c.id)).toEqual([
      "unroutable",
      "undosed-items",
    ]);
    const undosed = row.checks.find((c) => c.id === "undosed-items")!;
    expect(undosed.cta?.href).toBe(
      `/medications/${undosedChildItem}?action=edit`
    );
  });

  it("the toddler shows never-onboarded and the SUGGEST-only roster question, and is NOT unroutable", () => {
    // Every item is inactive, so nothing would send — a profile with nothing to say is
    // quiet, correctly, even with an empty edge set.
    expect(profileUnroutableReason(toddler, TODAY)).toBe(null);
    expect(checkIds(toddler)).toEqual(["never-onboarded", "roster-inactive"]);
    const roster = householdSetupForProfile(toddler, TODAY)!.checks.find(
      (c) => c.id === "roster-inactive"
    )!;
    // SUGGEST-only: it asks, it offers no write.
    expect(roster.cta).toBe(null);
  });

  it("a `login_profiles` grant clears the UNROUTABLE line ONLY", () => {
    const before = checkIds(child);
    expect(before).toEqual(["unroutable", "undosed-items"]);
    db.prepare(
      "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')"
    ).run(adminLoginId, child);
    expect(checkIds(child)).toEqual(["undosed-items"]);
  });

  it("adding a dose clears the UNDOSED line ONLY", () => {
    addDose(undosedChildItem);
    expect(checkIds(child)).toEqual(["unroutable"]);
  });

  it("the PROFILE-scoped Home Assistant webhook alone makes a member routable", () => {
    setProfileHomeAssistant(adult, {
      enabled: true,
      webhookUrl: "https://ha.example.com/api/webhook/fixture",
      secret: "",
      disabledKinds: [],
    });
    expect(profileUnroutableReason(adult, TODAY)).toBe(null);
    expect(householdSetupForProfile(adult, TODAY)).toBe(null);
  });

  // Anti-drift: the routing reader is NOT `getChannels().some(isConfigured)` (it needs
  // the shape of the gap, and it deliberately ignores mute), but with no mute in play
  // the two must agree about whether ANY route exists — or the household board and the
  // tick would disagree about the same profile.
  it("agrees with the real channel registry about whether a route exists", () => {
    for (const p of [adminSelf, adult, child, toddler]) {
      const facts = profileRoutingFacts(p);
      const routed =
        facts.profileChannelConfigured || facts.channelledLoginIds.length > 0;
      expect(getChannels().some((c) => c.isConfigured(p))).toBe(routed);
    }
  });

  it("a dismissal hides the row until a NEW check type fails", () => {
    // The toddler's row is dismissible (no unroutable in the set).
    const row = householdSetupForProfile(toddler, TODAY)!;
    expect(row.dismissible).toBe(true);
    dismissFinding(toddler, row.dedupeKey);
    expect(householdSetupForProfile(toddler, TODAY)).toBe(null);

    // A newly failing check TYPE re-keys the episode, so the row is offered again.
    addItem(toddler, "Toddler New Undosed (fixture)", {
      obligation: "should",
      dosed: false,
    });
    const after = householdSetupForProfile(toddler, TODAY)!;
    expect(after.checks.map((c) => c.id)).toContain("undosed-items");
    expect(after.dedupeKey).not.toBe(row.dedupeKey);
  });

  it("a dismissal can never silence an unroutable member", () => {
    const row = householdSetupForProfile(adult, TODAY)!;
    // Even with a suppression row hand-written under the current key, the member's
    // unroutable line still renders — the reader never consults the bus for it.
    dismissFinding(adult, row.dedupeKey);
    expect(checkIds(adult)).toContain("unroutable");
  });

  it("a quiet profile with no send source is never unroutable", () => {
    const quiet = newProfile("Quiet Quilla (fixture)");
    setOnboardingState(quiet, initialOnboardingState());
    const facts = gatherHouseholdSetupFacts(quiet, TODAY);
    expect(facts.routing.managingLoginIds).toEqual([]);
    expect(facts.sendSources.scheduledMedications).toBe(0);
    expect(facts.sendSources.scheduledSupplements).toBe(0);
    expect(profileUnroutableReason(quiet, TODAY)).toBe(null);
  });

  it("a `may`-only roster is not a send source, so it is never unroutable", () => {
    const prn = newProfile("PRN Perrine (fixture)");
    setOnboardingState(prn, initialOnboardingState());
    addItem(prn, "PRN Ibuprofen (fixture)", {
      kind: "medication",
      obligation: "may",
    });
    expect(profileUnroutableReason(prn, TODAY)).toBe(null);
    // …and its undosed sibling is not a defect either: `may` has no dueness at all.
    addItem(prn, "PRN Undosed (fixture)", {
      kind: "medication",
      obligation: "may",
      dosed: false,
    });
    expect(checkIds(prn)).not.toContain("undosed-items");
  });
});
