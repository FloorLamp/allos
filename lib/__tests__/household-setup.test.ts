import { describe, expect, it } from "vitest";
import {
  HOUSEHOLD_SETUP_CHECK_IDS,
  HOUSEHOLD_SETUP_PREFIX,
  detectHouseholdSetup,
  hasSendSource,
  householdSetupDedupeKey,
  routingGap,
  unroutable,
  type HouseholdSetupFacts,
  type RoutingFacts,
  type SendSourceFacts,
} from "@/lib/household-setup";
import {
  dedupeKeyHasKnownPrefix,
  tierForDedupeKey,
} from "@/lib/rule-finding-prefixes";

const NO_SENDS: SendSourceFacts = {
  scheduledMedications: 0,
  scheduledSupplements: 0,
  digestEnabled: false,
  weeklyRecapEnabled: false,
  workoutNudgeScheduled: false,
  preventiveNudges: 0,
};

// No route to THIS profile, on an instance that HAS channel technology configured
// somewhere — the state the check exists to name. The bare-instance case (nothing
// configured anywhere) is `BARE_INSTANCE` below.
const NO_ROUTE: RoutingFacts = {
  managingLoginIds: [],
  channelledLoginIds: [],
  profileChannelConfigured: false,
  instanceHasAnyChannel: true,
};

// A fresh install: no Telegram bot, no Web Push, no Home Assistant, no email.
const BARE_INSTANCE: RoutingFacts = { ...NO_ROUTE, instanceHasAnyChannel: false };

function facts(over: Partial<HouseholdSetupFacts> = {}): HouseholdSetupFacts {
  return {
    sendSources: NO_SENDS,
    routing: NO_ROUTE,
    onboardingStarted: true,
    hasStoredData: true,
    undosedItems: [],
    preventiveUnactioned: [],
    roster: { active: 1, inactive: 0, inactiveObligated: 0 },
    ...over,
  };
}

describe("the unroutable predicate (#2173)", () => {
  it("fires on the found instance: a dosed non-`may` item, an EMPTY edge set", () => {
    const f = facts({
      sendSources: { ...NO_SENDS, scheduledSupplements: 1 },
      routing: NO_ROUTE,
    });
    expect(unroutable(f)).toBe("no-managing-login");
  });

  it("fires on a NON-empty edge set whose logins have no channel", () => {
    const f = facts({
      sendSources: { ...NO_SENDS, scheduledMedications: 5 },
      routing: { ...NO_ROUTE, managingLoginIds: [3, 7] },
    });
    expect(unroutable(f)).toBe("no-channel");
  });

  it("never fires with ZERO send sources — a quiet profile is quiet, correctly", () => {
    expect(
      unroutable(facts({ sendSources: NO_SENDS, routing: NO_ROUTE }))
    ).toBe(null);
  });

  it("never fires for a `may`-only roster (no scheduled item is counted)", () => {
    // A `may` item is never scheduled-due, so the gather contributes nothing to the
    // scheduled counts — expressed here as the zero those counts hold.
    const f = facts({
      sendSources: NO_SENDS,
      routing: NO_ROUTE,
      roster: { active: 4, inactive: 0, inactiveObligated: 0 },
    });
    expect(unroutable(f)).toBe(null);
  });

  it("clears the moment one granted login has a channel", () => {
    const f = facts({
      sendSources: { ...NO_SENDS, scheduledSupplements: 1 },
      routing: {
        managingLoginIds: [3, 7],
        channelledLoginIds: [7],
        profileChannelConfigured: false,
      },
    });
    expect(unroutable(f)).toBe(null);
  });

  it("clears on the PROFILE-scoped Home Assistant channel even with an empty edge set", () => {
    const f = facts({
      sendSources: { ...NO_SENDS, digestEnabled: true },
      routing: { ...NO_ROUTE, profileChannelConfigured: true },
    });
    expect(unroutable(f)).toBe(null);
  });

  it("counts each send source the tick has", () => {
    for (const over of [
      { scheduledMedications: 1 },
      { scheduledSupplements: 1 },
      { digestEnabled: true },
      { weeklyRecapEnabled: true },
      { workoutNudgeScheduled: true },
      { preventiveNudges: 2 },
    ] as Partial<SendSourceFacts>[]) {
      expect(hasSendSource({ ...NO_SENDS, ...over })).toBe(true);
    }
    expect(hasSendSource(NO_SENDS)).toBe(false);
  });

  // Constraint 4 — "one row, whichever applies". `notify_lifecycle` records a channel
  // that was ATTEMPTED and FAILED; a channel can only be attempted if it is configured.
  // So the two states are disjoint BY CONSTRUCTION, not by a filter.
  it("cannot double-fire with a delivery-status error: any configured channel clears it", () => {
    const withChannel: RoutingFacts[] = [
      {
        managingLoginIds: [1],
        channelledLoginIds: [1],
        profileChannelConfigured: false,
        instanceHasAnyChannel: true,
      },
      {
        managingLoginIds: [],
        channelledLoginIds: [],
        profileChannelConfigured: true,
        instanceHasAnyChannel: true,
      },
      {
        managingLoginIds: [1, 2],
        channelledLoginIds: [2],
        profileChannelConfigured: true,
        instanceHasAnyChannel: true,
      },
    ];
    for (const routing of withChannel) expect(routingGap(routing)).toBe(null);
  });
});

// The owner ruling on PR #2362. "Notifications are not set up yet" and "notifications
// are set up, and this member cannot be reached by them" are different states, and only
// the second is a household setup-health defect — so the check is silent while NO channel
// technology is configured anywhere on the instance, and fires the moment any exists.
describe("the INSTANCE gate on unroutable (#2362 ruling)", () => {
  const SENDS: SendSourceFacts = { ...NO_SENDS, scheduledMedications: 3 };

  it("is silent on a bare instance — a fresh install warns about nothing on day one", () => {
    expect(unroutable(facts({ sendSources: SENDS, routing: BARE_INSTANCE }))).toBe(
      null
    );
    // …and the row it would have carried is gone with it, not merely re-worded.
    expect(
      detectHouseholdSetup(facts({ sendSources: SENDS, routing: BARE_INSTANCE }))
    ).toBe(null);
  });

  it("fires the moment ANY channel technology exists anywhere on the instance", () => {
    // The SAME member, the same empty edge set, the same send sources — only the
    // instance-wide fact moved.
    expect(unroutable(facts({ sendSources: SENDS, routing: NO_ROUTE }))).toBe(
      "no-managing-login"
    );
    expect(
      unroutable(
        facts({
          sendSources: SENDS,
          routing: { ...NO_ROUTE, managingLoginIds: [4] },
        })
      )
    ).toBe("no-channel");
  });

  // THE ASSERTION THAT SEPARATES THE TWO PREDICATES, and the reason the ruling names the
  // shape at all. The gate is an instance-wide fact, NOT the fold "every profile came
  // back unroutable, therefore suppress" — that fold would also silence a fully
  // configured instance on which every member happens to be unreachable, which is the
  // LOUDEST true case. Here every member of a three-profile household is unroutable on
  // an instance that HAS a channel: all three must still report it.
  it("stays loud on a CONFIGURED instance where every member is unreachable", () => {
    const household = [
      { ...NO_ROUTE },
      { ...NO_ROUTE, managingLoginIds: [2] },
      { ...NO_ROUTE, managingLoginIds: [2, 5] },
    ];
    const verdicts = household.map((routing) =>
      unroutable(facts({ sendSources: SENDS, routing }))
    );
    expect(verdicts).toEqual(["no-managing-login", "no-channel", "no-channel"]);
    // The bare-instance twin of the same household: identical per-profile facts,
    // opposite answer — so the gate can only be reading the instance-wide fact.
    expect(
      household.map((routing) =>
        unroutable(
          facts({
            sendSources: SENDS,
            routing: { ...routing, instanceHasAnyChannel: false },
          })
        )
      )
    ).toEqual([null, null, null]);
  });

  it("gates the OTHER four checks not at all — only unroutable is instance-conditional", () => {
    const row = detectHouseholdSetup(
      facts({
        sendSources: SENDS,
        routing: BARE_INSTANCE,
        onboardingStarted: false,
        hasStoredData: false,
      })
    );
    expect(row?.checks.map((c) => c.id)).toEqual(["never-onboarded"]);
    // With unroutable gone from the set the row is dismissible again, and its episode
    // key is the never-onboarded one — the gate removes a check, it does not mask one.
    expect(row?.dismissible).toBe(true);
    expect(row?.dedupeKey).toBe(`${HOUSEHOLD_SETUP_PREFIX}never-onboarded`);
  });
});

describe("the five setup checks (#2173)", () => {
  it("returns null for a healthy member", () => {
    expect(detectHouseholdSetup(facts())).toBe(null);
  });

  it("never-onboarded needs BOTH no onboarding row and thin presence", () => {
    expect(
      detectHouseholdSetup(
        facts({ onboardingStarted: false, hasStoredData: false })
      )?.checks[0].id
    ).toBe("never-onboarded");
    // A profile with real data in it was plainly set up by hand.
    expect(
      detectHouseholdSetup(
        facts({ onboardingStarted: false, hasStoredData: true })
      )
    ).toBe(null);
    expect(
      detectHouseholdSetup(
        facts({ onboardingStarted: true, hasStoredData: false })
      )
    ).toBe(null);
  });

  it("undosed items deep-link the single medication's edit form, else the kind surface", () => {
    const one = detectHouseholdSetup(
      facts({
        undosedItems: [{ id: 42, name: "Albuterol", kind: "medication" }],
      })
    );
    expect(one?.checks[0].cta?.href).toBe("/medications/42?action=edit");
    expect(one?.checks[0].cta?.scope).toBe("member");
    const many = detectHouseholdSetup(
      facts({
        undosedItems: [
          { id: 42, name: "Albuterol", kind: "medication" },
          { id: 43, name: "Fluoride", kind: "supplement" },
        ],
      })
    );
    expect(many?.checks[0].cta?.href).toBe("/medications");
    expect(many?.checks[0].title).toBe("2 items with no dose");
  });

  it("the roster oddity is SUGGEST-only and needs an all-inactive obligated roster", () => {
    const row = detectHouseholdSetup(
      facts({ roster: { active: 0, inactive: 6, inactiveObligated: 2 } })
    );
    expect(row?.checks[0].id).toBe("roster-inactive");
    expect(row?.checks[0].title).toBe("6 items inactive — intended?");
    // No CTA at all: the app asks, it never reactivates.
    expect(row?.checks[0].cta).toBe(null);
    // One still-active item means the roster is in use, not swept.
    expect(
      detectHouseholdSetup(
        facts({ roster: { active: 1, inactive: 6, inactiveObligated: 2 } })
      )
    ).toBe(null);
    // An all-`may` inactive roster is exactly what `may` is for.
    expect(
      detectHouseholdSetup(
        facts({ roster: { active: 0, inactive: 6, inactiveObligated: 0 } })
      )
    ).toBe(null);
  });

  it("preventive fires off the planner's outstanding set", () => {
    const row = detectHouseholdSetup(
      facts({
        preventiveUnactioned: [
          { ruleKey: "adult_physical", name: "Adult physical" },
          { ruleKey: "skin_check", name: "Skin check" },
        ],
      })
    );
    expect(row?.checks[0].id).toBe("preventive-unactioned");
    expect(row?.checks[0].title).toBe("2 preventive items unactioned");
  });
});

describe("banding and the episode key (#2173 constraints 2, 3, 9)", () => {
  it("an undeliverable `must` MEDICATION bands above a supplement — in the EXISTING vocabulary", () => {
    const meds = detectHouseholdSetup(
      facts({ sendSources: { ...NO_SENDS, scheduledMedications: 5 } })
    );
    const supps = detectHouseholdSetup(
      facts({ sendSources: { ...NO_SENDS, scheduledSupplements: 1 } })
    );
    expect(meds?.tone).toBe("caution");
    expect(supps?.tone).toBe("action");
    // Both render — severity reflects content, it never filters.
    expect(meds?.checks[0].id).toBe("unroutable");
    expect(supps?.checks[0].id).toBe("unroutable");
  });

  it("the row's tone is the strongest among its checks", () => {
    const row = detectHouseholdSetup(
      facts({
        sendSources: { ...NO_SENDS, scheduledMedications: 1 },
        onboardingStarted: false,
        hasStoredData: false,
      })
    );
    expect(row?.tone).toBe("caution");
  });

  it("the dedupeKey is the FAILING CHECK SET, in declaration order", () => {
    const row = detectHouseholdSetup(
      facts({
        onboardingStarted: false,
        hasStoredData: false,
        undosedItems: [{ id: 1, name: "D3", kind: "supplement" }],
      })
    );
    expect(row?.dedupeKey).toBe(
      `${HOUSEHOLD_SETUP_PREFIX}never-onboarded+undosed-items`
    );
    // Order of the caller's ids is irrelevant — the key is canonical.
    expect(householdSetupDedupeKey(["undosed-items", "never-onboarded"])).toBe(
      row?.dedupeKey
    );
  });

  it("a NEWLY failing check type changes the key, so a dismissal cannot outlive its episode", () => {
    const before = detectHouseholdSetup(
      facts({ onboardingStarted: false, hasStoredData: false })
    );
    const after = detectHouseholdSetup(
      facts({
        onboardingStarted: false,
        hasStoredData: false,
        preventiveUnactioned: [{ ruleKey: "skin_check", name: "Skin check" }],
      })
    );
    expect(before?.dedupeKey).not.toBe(after?.dedupeKey);
  });

  it("a row carrying UNROUTABLE is never dismissible — no standing silence", () => {
    const withUnroutable = detectHouseholdSetup(
      facts({
        sendSources: { ...NO_SENDS, scheduledSupplements: 1 },
        onboardingStarted: false,
        hasStoredData: false,
      })
    );
    expect(withUnroutable?.dismissible).toBe(false);
    const without = detectHouseholdSetup(
      facts({ onboardingStarted: false, hasStoredData: false })
    );
    expect(without?.dismissible).toBe(true);
  });

  it("the key is guardable and declared COACHING — never a push tier", () => {
    const row = detectHouseholdSetup(
      facts({ onboardingStarted: false, hasStoredData: false })
    );
    expect(dedupeKeyHasKnownPrefix(row!.dedupeKey)).toBe(true);
    expect(tierForDedupeKey(row!.dedupeKey)).toBe("coaching");
  });

  it("every declared check id has a detector that can emit it", () => {
    const emitted = new Set([
      detectHouseholdSetup(
        facts({ sendSources: { ...NO_SENDS, digestEnabled: true } })
      )?.checks[0].id,
      detectHouseholdSetup(
        facts({ onboardingStarted: false, hasStoredData: false })
      )?.checks[0].id,
      detectHouseholdSetup(
        facts({
          undosedItems: [{ id: 1, name: "D3", kind: "supplement" }],
        })
      )?.checks[0].id,
      detectHouseholdSetup(
        facts({
          preventiveUnactioned: [{ ruleKey: "skin_check", name: "Skin check" }],
        })
      )?.checks[0].id,
      detectHouseholdSetup(
        facts({ roster: { active: 0, inactive: 3, inactiveObligated: 1 } })
      )?.checks[0].id,
    ]);
    for (const id of HOUSEHOLD_SETUP_CHECK_IDS)
      expect(emitted.has(id)).toBe(true);
  });
});
