import { describe, it, expect } from "vitest";
import {
  isRouteActive,
  isGroupActive,
  isNavLeafVisible,
  navParentFor,
  navParentIn,
  NAV_PARENT_ROUTES,
} from "../nav";
import { DEFAULT_NAV_RELEVANCE } from "../nav-relevance";

describe("isRouteActive", () => {
  it("matches the dashboard only on an exact '/'", () => {
    expect(isRouteActive("/", "/")).toBe(true);
    expect(isRouteActive("/", "/biomarkers")).toBe(false);
    expect(isRouteActive("/", "/training")).toBe(false);
  });

  it("matches non-root entries by prefix so nested routes stay lit", () => {
    expect(isRouteActive("/biomarkers", "/biomarkers")).toBe(true);
    expect(isRouteActive("/biomarkers", "/biomarkers/123")).toBe(true);
    expect(isRouteActive("/profile", "/profile")).toBe(true);
  });

  it("does not match an unrelated route", () => {
    expect(isRouteActive("/biomarkers", "/conditions")).toBe(false);
    expect(isRouteActive("/allergies", "/")).toBe(false);
  });
});

// The physical-registry surfaces reached from their consumers rather than from a
// nav row (#1522): /equipment and the medicine cabinet at /supplies. Neither is a
// nav leaf, so without this map they would light up NOTHING and the sidebar would
// stop saying where you are.
describe("registry parent highlighting (#1522)", () => {
  it("maps each parent-less registry route to the entry that owns it", () => {
    expect(navParentFor("/equipment")).toBe("/training");
    expect(navParentFor("/supplies")).toBe("/medications");
    // Nested registry routes (an equipment detail page) delegate the same way.
    expect(navParentFor("/equipment/12")).toBe("/training");
  });

  // The map's own doc promises "longest-prefix wins, so a future `/x` + `/x/y`
  // pair can't be ambiguous" — and the tiebreak did not keep that promise: it
  // compared the candidate CHILD's length against the winning PARENT's, so the
  // more specific child lost whenever the incumbent parent string happened to be
  // longer. The production map has no nested pair, so the case is pinned through
  // navParentIn with a fixture map (#1644 drive-by).
  it("prefers the LONGEST matching child, not the longest parent", () => {
    const nested: Readonly<Record<string, string>> = {
      "/gear": "/training-and-recovery",
      "/gear/cases": "/data",
    };
    // Both children match; the deeper one owns the route. Under the old tiebreak
    // "/gear/cases".length (11) > "/training-and-recovery".length (22) was false,
    // so the first entry's parent stuck.
    expect(navParentIn(nested, "/gear/cases")).toBe("/data");
    expect(navParentIn(nested, "/gear/cases/9")).toBe("/data");
    // The shallower route still resolves to its own parent, in either key order.
    expect(navParentIn(nested, "/gear")).toBe("/training-and-recovery");
    expect(
      navParentIn(
        { "/gear/cases": "/data", "/gear": "/training-and-recovery" },
        "/gear/cases"
      )
    ).toBe("/data");
    // No match is still null.
    expect(navParentIn(nested, "/gearbox")).toBeNull();
  });

  it("resolves the production map through the same helper", () => {
    for (const child of Object.keys(NAV_PARENT_ROUTES)) {
      expect(navParentFor(child)).toBe(navParentIn(NAV_PARENT_ROUTES, child));
    }
  });

  it("leaves every ordinary route alone", () => {
    expect(navParentFor("/")).toBeNull();
    expect(navParentFor("/training")).toBeNull();
    expect(navParentFor("/medications")).toBeNull();
    // Prefix-safe: a route that merely STARTS with a child's name is not that child.
    expect(navParentFor("/equipmentary")).toBeNull();
    expect(navParentFor("/suppliesx")).toBeNull();
  });

  it("lights the parent entry — and only the parent — on a registry route", () => {
    expect(isRouteActive("/training", "/equipment")).toBe(true);
    expect(isRouteActive("/training", "/equipment/12")).toBe(true);
    expect(isRouteActive("/medications", "/supplies")).toBe(true);
    // The child never lights itself (it has no nav row to light), and no unrelated
    // entry is dragged along by the plain prefix rule.
    expect(isRouteActive("/supplies", "/supplies")).toBe(false);
    expect(isRouteActive("/equipment", "/equipment")).toBe(false);
    expect(isRouteActive("/", "/supplies")).toBe(false);
    expect(isRouteActive("/nutrition", "/supplies")).toBe(false);
  });

  it("expands the owning GROUP too, so the lit child is on screen", () => {
    const medical = ["/records", "/results", "/medications", "/profile"];
    expect(isGroupActive(medical, "/supplies")).toBe(true);
    // …and does not expand a group that owns neither.
    expect(isGroupActive(medical, "/equipment")).toBe(false);
  });

  it("declares a real parent for every mapped child", () => {
    // A typo'd parent would silently highlight nothing, which is the exact wart
    // this map exists to fix. Both parents are top-level/Medical nav hrefs.
    expect(Object.values(NAV_PARENT_ROUTES).sort()).toEqual([
      "/medications",
      "/training",
    ]);
  });
});

describe("isGroupActive", () => {
  const medical = [
    "/profile",
    "/biomarkers",
    "/conditions",
    "/allergies",
    "/immunizations",
  ];

  it("is true when the active route is any child (including nested)", () => {
    expect(isGroupActive(medical, "/biomarkers")).toBe(true);
    expect(isGroupActive(medical, "/immunizations/new")).toBe(true);
    expect(isGroupActive(medical, "/profile")).toBe(true);
  });

  it("is false when no child matches the active route", () => {
    expect(isGroupActive(medical, "/training")).toBe(false);
    expect(isGroupActive(medical, "/")).toBe(false);
    expect(isGroupActive([], "/biomarkers")).toBe(false);
  });
});

describe("isNavLeafVisible", () => {
  // The production RESTRICTED_HREFS is EMPTY since #489 (Training is no longer
  // nav-gated — a restricted profile keeps a lightweight sport/cardio log there),
  // so this exercises the pure mechanism against a hypothetical gated route to
  // prove a future gated href would still be hidden.
  const restrictedHrefs = new Set(["/__gated__"]);
  const ctx = (over: Partial<Parameters<typeof isNavLeafVisible>[1]> = {}) => ({
    isAdmin: true,
    restricted: false,
    multiProfile: true,
    foodLoggingRelevant: true,
    hasIntakeItems: false,
    relevance: DEFAULT_NAV_RELEVANCE,
    restrictedHrefs,
    ...over,
  });

  it("shows a plain leaf to everyone", () => {
    expect(isNavLeafVisible({ href: "/biomarkers" }, ctx())).toBe(true);
    expect(
      isNavLeafVisible(
        { href: "/biomarkers" },
        ctx({ isAdmin: false, multiProfile: false })
      )
    ).toBe(true);
  });

  it("hides adminOnly leaves from non-admins", () => {
    const leaf = { href: "/household", adminOnly: true };
    expect(isNavLeafVisible(leaf, ctx({ isAdmin: true }))).toBe(true);
    expect(isNavLeafVisible(leaf, ctx({ isAdmin: false }))).toBe(false);
  });

  it("hides requiresMultiProfile leaves when only one profile exists", () => {
    const leaf = { href: "/household", requiresMultiProfile: true };
    expect(isNavLeafVisible(leaf, ctx({ multiProfile: true }))).toBe(true);
    expect(isNavLeafVisible(leaf, ctx({ multiProfile: false }))).toBe(false);
  });

  it("shows Household to any login with 2+ accessible profiles (issue #31)", () => {
    // Household is gated on multi-profile ONLY (no longer adminOnly): a caregiver
    // member with several grants must see it, while a single-profile login (member
    // or a one-profile instance) must not.
    const household = {
      href: "/household",
      requiresMultiProfile: true,
    };
    expect(
      isNavLeafVisible(household, ctx({ isAdmin: true, multiProfile: true }))
    ).toBe(true);
    expect(
      isNavLeafVisible(household, ctx({ isAdmin: false, multiProfile: true }))
    ).toBe(true); // caregiver member with 2+ grants
    expect(
      isNavLeafVisible(household, ctx({ isAdmin: true, multiProfile: false }))
    ).toBe(false);
    expect(
      isNavLeafVisible(household, ctx({ isAdmin: false, multiProfile: false }))
    ).toBe(false); // single-profile member
  });

  it("hides requiresFoodLogging leaves for an infant profile (issue #591/#746)", () => {
    const leaf = { href: "/nutrition", requiresFoodLogging: true };
    expect(isNavLeafVisible(leaf, ctx({ foodLoggingRelevant: true }))).toBe(
      true
    );
    // Infant, no intake items → hidden.
    expect(
      isNavLeafVisible(
        leaf,
        ctx({ foodLoggingRelevant: false, hasIntakeItems: false })
      )
    ).toBe(false);
    // #746: an infant who tracks any intake item (e.g. vitamin D drops) keeps the
    // Nutrition entry so the Supplements tab stays reachable — food-logging gates
    // the Food tab, not the whole surface.
    expect(
      isNavLeafVisible(
        leaf,
        ctx({ foodLoggingRelevant: false, hasIntakeItems: true })
      )
    ).toBe(true);
    // A plain leaf is unaffected by the food-logging gate.
    expect(
      isNavLeafVisible(
        { href: "/biomarkers" },
        ctx({ foodLoggingRelevant: false })
      )
    ).toBe(true);
  });

  it("honors the age-gate only for hrefs in the restricted set", () => {
    expect(
      isNavLeafVisible({ href: "/__gated__" }, ctx({ restricted: true }))
    ).toBe(false);
    expect(
      isNavLeafVisible({ href: "/biomarkers" }, ctx({ restricted: true }))
    ).toBe(true);
    // Not restricted: even a gated href still shows.
    expect(
      isNavLeafVisible({ href: "/__gated__" }, ctx({ restricted: false }))
    ).toBe(true);
  });

  it("hides relevanceKey leaves when their relevance bit is false (#1042)", () => {
    const cycle = { href: "/medical/cycles", relevanceKey: "cycle" as const };
    const vision = { href: "/vision", relevanceKey: "vision" as const };
    const sleep = { href: "/sleep", relevanceKey: "sleep" as const };
    const progress = { href: "/progress", relevanceKey: "progress" as const };
    const wellness = {
      href: "/wellness",
      relevanceKey: "wellness" as const,
    };
    const off = {
      cycle: false,
      vision: false,
      dental: false,
      sleep: false,
      progress: false,
      wellness: false,
    };
    expect(isNavLeafVisible(cycle, ctx({ relevance: off }))).toBe(false);
    expect(isNavLeafVisible(vision, ctx({ relevance: off }))).toBe(false);
    // The #1066 Sleep gate: hidden when the sleep bit is false, shown when true.
    expect(isNavLeafVisible(sleep, ctx({ relevance: off }))).toBe(false);
    expect(
      isNavLeafVisible(sleep, ctx({ relevance: { ...off, sleep: true } }))
    ).toBe(true);
    // The #1119 Progress-photos gate behaves identically.
    expect(isNavLeafVisible(progress, ctx({ relevance: off }))).toBe(false);
    expect(
      isNavLeafVisible(progress, ctx({ relevance: { ...off, progress: true } }))
    ).toBe(true);
    // The #1620 Wellness gate behaves identically.
    expect(isNavLeafVisible(wellness, ctx({ relevance: off }))).toBe(false);
    expect(
      isNavLeafVisible(wellness, ctx({ relevance: { ...off, wellness: true } }))
    ).toBe(true);
    // Each key gates only its own leaf.
    expect(
      isNavLeafVisible(cycle, ctx({ relevance: { ...off, cycle: true } }))
    ).toBe(true);
    // A leaf without a relevanceKey is unaffected.
    expect(isNavLeafVisible({ href: "/skin" }, ctx({ relevance: off }))).toBe(
      true
    );
    // The all-true default (an un-threaded caller) never over-hides.
    expect(isNavLeafVisible(cycle, ctx())).toBe(true);
  });

  it("keeps /training visible to a restricted profile (#489 is type-aware)", () => {
    // Training is no longer nav-gated — the page adapts (lightweight sport/cardio
    // log) rather than hiding, so a restricted profile must still see the link.
    expect(
      isNavLeafVisible({ href: "/training" }, ctx({ restricted: true }))
    ).toBe(true);
  });
});
