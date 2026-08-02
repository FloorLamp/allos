import { describe, expect, it } from "vitest";
import {
  portalChecklist,
  portalSetupStage,
  type PortalSetupFacts,
} from "@/lib/portal-setup-stage";

// The stage derivation behind the guided Patient portals page (#1826). The page is a
// formatter over this decision, so every branch — and every ordering choice that makes
// one fact outrank another — is pinned here rather than in a browser test.
//
// The e2e tier drives the stages it can reach deterministically against a SHARED worker
// database (first-run → steady → map-patients → steady, plus the empty registry a
// household with no reachable portal sees). "create-token" is deliberately NOT among
// them: whether a live `upload:documents` token exists is instance-global state that
// other specs mint into and never revoke, so a browser assertion on its ABSENCE would
// pass or fail on test scheduling. It is pinned here instead, where the fact is an
// argument.
function facts(over: Partial<PortalSetupFacts> = {}): PortalSetupFacts {
  return {
    portalCount: 1,
    hasUploadToken: true,
    reportCount: 1,
    pendingCount: 0,
    ...over,
  };
}

describe("portalSetupStage", () => {
  it("starts at the empty registry", () => {
    expect(portalSetupStage(facts({ portalCount: 0 }))).toBe("no-portals");
  });

  it("asks for a token once a portal exists and nothing has run", () => {
    expect(
      portalSetupStage(
        facts({ hasUploadToken: false, reportCount: 0, portalCount: 2 })
      )
    ).toBe("create-token");
  });

  it("asks for the first run once a token exists", () => {
    expect(portalSetupStage(facts({ reportCount: 0 }))).toBe("first-run");
  });

  it("hands the page to the pending list as soon as one patient waits", () => {
    expect(portalSetupStage(facts({ pendingCount: 1 }))).toBe("map-patients");
  });

  it("settles into steady state once a run has reported and nothing waits", () => {
    expect(portalSetupStage(facts())).toBe("steady");
  });

  // A pending row cannot exist without a run having reported it, so ranking it above the
  // pre-run stages never skips a step — it only stops a revoked token from hiding
  // patients whose records are being refused right now.
  it("keeps waiting patients in front of a household whose token was revoked", () => {
    expect(
      portalSetupStage(
        facts({ hasUploadToken: false, reportCount: 0, pendingCount: 3 })
      )
    ).toBe("map-patients");
  });

  // The token and first-run cards are first-contact guidance. A household that has been
  // syncing for a year must never be told to "create a token for the computer that will
  // run the tool" because one was rotated; that shows up as a failing run instead.
  it("does not send a running household back to the token card", () => {
    expect(
      portalSetupStage(facts({ hasUploadToken: false, reportCount: 4 }))
    ).toBe("steady");
  });

  // A viewer who can see no portal has no next step on this page, whatever else the
  // instance holds — the registry read is already scoped to them, so an empty one means
  // "nothing here is yours", not "nothing exists".
  it("stays on the empty registry even when other facts are set", () => {
    expect(
      portalSetupStage(
        facts({ portalCount: 0, pendingCount: 2, reportCount: 5 })
      )
    ).toBe("no-portals");
  });
});

// The checklist (#1874): the same facts, rendered as the strip/guide items. The page
// only formats these — done/current per item and the vanish-at-steady rule live here.
describe("portalChecklist", () => {
  it("is gone at steady state — a finished checklist is clutter, not reassurance", () => {
    expect(portalChecklist(facts())).toBeNull();
  });

  it("marks exactly the stage as current, with earlier steps done", () => {
    const items = portalChecklist(
      facts({ hasUploadToken: false, reportCount: 0 })
    )!;
    expect(items.map((i) => i.key)).toEqual([
      "portal",
      "token",
      "first-run",
      "map",
    ]);
    expect(items.map((i) => i.done)).toEqual([true, false, false, false]);
    expect(items.filter((i) => i.current).map((i) => i.key)).toEqual(["token"]);
  });

  it("counts the patients waiting to be mapped in the item's own label", () => {
    const items = portalChecklist(facts({ pendingCount: 2 }))!;
    const map = items.find((i) => i.key === "map")!;
    expect(map.label).toBe("2 patients to map");
    expect(map.current).toBe(true);
    expect(map.done).toBe(false);
    expect(portalChecklist(facts({ pendingCount: 1 }))!.at(-1)!.label).toBe(
      "1 patient to map"
    );
  });

  it("never claims the map step is done before a run has reported anything", () => {
    const items = portalChecklist(facts({ reportCount: 0 }))!;
    expect(items.find((i) => i.key === "map")!.done).toBe(false);
    expect(items.find((i) => i.key === "map")!.label).toBe("Map patients");
  });
});
