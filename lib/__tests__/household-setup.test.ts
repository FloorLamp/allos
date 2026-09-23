import { describe, expect, it } from "vitest";
import {
  hasSendSource,
  routingGap,
  unroutable,
  type RoutingFacts,
  type SendSourceFacts,
} from "@/lib/household-setup";

const NO_SENDS: SendSourceFacts = {
  scheduledIntake: 0,
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
const BARE_INSTANCE: RoutingFacts = {
  ...NO_ROUTE,
  instanceHasAnyChannel: false,
};

function facts(
  over: { sendSources?: SendSourceFacts; routing?: RoutingFacts } = {}
) {
  return { sendSources: NO_SENDS, routing: NO_ROUTE, ...over };
}

describe("the unroutable predicate (#2173)", () => {
  it("fires on the found instance: a dosed non-`may` item, an EMPTY edge set", () => {
    const f = facts({
      sendSources: { ...NO_SENDS, scheduledIntake: 1 },
      routing: NO_ROUTE,
    });
    expect(unroutable(f)).toBe("no-managing-login");
  });

  it("fires on a NON-empty edge set whose logins have no channel", () => {
    const f = facts({
      sendSources: { ...NO_SENDS, scheduledIntake: 5 },
      routing: { ...NO_ROUTE, managingLoginIds: [3, 7] },
    });
    expect(unroutable(f)).toBe("no-channel");
  });

  it("never fires with ZERO send sources — a quiet profile is quiet, correctly", () => {
    expect(
      unroutable(facts({ sendSources: NO_SENDS, routing: NO_ROUTE }))
    ).toBe(null);
  });

  it("clears the moment one granted login has a channel", () => {
    const f = facts({
      sendSources: { ...NO_SENDS, scheduledIntake: 1 },
      routing: {
        ...NO_ROUTE,
        managingLoginIds: [3, 7],
        channelledLoginIds: [7],
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
      { scheduledIntake: 1 },
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
// the second is a routing defect — so the check is silent while NO channel
// technology is configured anywhere on the instance, and fires the moment any exists.
describe("the INSTANCE gate on unroutable (#2362 ruling)", () => {
  const SENDS: SendSourceFacts = { ...NO_SENDS, scheduledIntake: 3 };

  it("is silent on a bare instance — a fresh install warns about nothing on day one", () => {
    expect(
      unroutable(facts({ sendSources: SENDS, routing: BARE_INSTANCE }))
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
});
