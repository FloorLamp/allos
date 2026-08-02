import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  SETTINGS_GROUPS,
  SETTINGS_GROUP_IDS,
  settingsGroup,
  settingsRegistryRoutes,
  visibleSettingsGroups,
  isSettingsGroupActive,
  tierBlurb,
  tierChip,
} from "../settings-groups";

// The settings group registry (#1462) is the single source of truth for how Settings
// is organized, navigated, and gated. These tests pin the three ways it could rot:
//
//   1. The registry disagrees with the real App-Router page tree (a group route with
//      no page → a nav link that 404s; a settings page with no group → an orphan).
//   2. Only ONE of the two navigation renderings reads it (the /settings index rows
//      and the group pages' left nav), which is how the old surface grew three
//      hand-kept navigation systems in the first place.
//   3. Role/relevance filtering drifts — a member seeing an admin group in nav.
//
// It never asserts AUTH: `adminOnly` is a navigation hint, and each admin page's own
// requireAdmin() is what actually gates it (covered by the admin-access e2e specs).

const SETTINGS_DIR = join(process.cwd(), "app", "(app)", "settings");

// Settings routes that legitimately have a page but NO registry entry.
const NON_GROUP_ROUTES = new Set([
  // The index itself — it renders the registry rather than being an entry in it.
  "/settings",
]);

function pageRoutes(dir: string, prefix: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (!statSync(full).isDirectory()) {
      if (name === "page.tsx") out.push(prefix);
      continue;
    }
    // Route groups `(x)` and private folders `_x` don't contribute a segment; there
    // are none under settings today, but the walker shouldn't invent routes if one
    // appears.
    if (name.startsWith("(") || name.startsWith("_")) {
      out.push(...pageRoutes(full, prefix));
      continue;
    }
    out.push(...pageRoutes(full, `${prefix}/${name}`));
  }
  return out;
}

function realSettingsRoutes(): string[] {
  return pageRoutes(SETTINGS_DIR, "/settings").sort();
}

describe("settings group registry ↔ real pages (#1462)", () => {
  it("discovers pages (the walker isn't silently empty)", () => {
    const routes = realSettingsRoutes();
    expect(routes).toContain("/settings");
    expect(routes.length).toBeGreaterThan(8);
  });

  it("every registry route resolves to a real settings page", () => {
    const real = new Set(realSettingsRoutes());
    const missing = settingsRegistryRoutes().filter((r) => !real.has(r));
    expect(
      missing,
      `registry routes with no page under app/(app)/settings: ${missing.join(", ")}`
    ).toEqual([]);
  });

  it("every settings page belongs to a group (no orphan surfaces)", () => {
    const registered = new Set(settingsRegistryRoutes());
    const orphans = realSettingsRoutes().filter(
      (r) => !registered.has(r) && !NON_GROUP_ROUTES.has(r)
    );
    expect(
      orphans,
      `settings pages missing from the group registry: ${orphans.join(", ")}`
    ).toEqual([]);
  });

  it("the removed tier-first routes are gone (the #1462 §2 no-redirect decision)", () => {
    // /settings/profile was the old "Profile" tab. #1462 split it into topic groups
    // and deliberately did NOT redirect it — this pins that it stays deleted, and
    // that nothing quietly re-adds a page under the old name.
    expect(realSettingsRoutes()).not.toContain("/settings/profile");
  });
});

describe("settings group registry shape", () => {
  it("ids, routes and labels are unique and complete", () => {
    expect(SETTINGS_GROUPS.map((g) => g.id).sort()).toEqual(
      [...SETTINGS_GROUP_IDS].sort()
    );
    const routes = SETTINGS_GROUPS.map((g) => g.route);
    expect(new Set(routes).size).toBe(routes.length);
    const labels = SETTINGS_GROUPS.map((g) => g.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("every group states a tier and a one-sentence summary", () => {
    for (const g of SETTINGS_GROUPS) {
      expect(["login", "profile", "mixed", "server"]).toContain(g.tier);
      expect(g.summary.length).toBeGreaterThan(10);
      // One sentence (the copy standard, #945): a single terminal period.
      expect(
        g.summary.replace(/\.\.\./g, "").match(/[.?!]/g)?.length ?? 0,
        `group "${g.id}" summary should be one sentence: ${g.summary}`
      ).toBe(1);
    }
  });

  it("settingsGroup() resolves every id", () => {
    for (const id of SETTINGS_GROUP_IDS) {
      expect(settingsGroup(id).id).toBe(id);
    }
  });

  it("admin groups are exactly the server-tier ones", () => {
    for (const g of SETTINGS_GROUPS) {
      expect(g.adminOnly, `group ${g.id}`).toBe(g.tier === "server");
    }
  });
});

describe("visibleSettingsGroups", () => {
  const full = {
    isAdmin: true,
    trainingRelevant: true,
    nutritionRelevant: true,
  };

  it("shows an admin every group", () => {
    expect(visibleSettingsGroups(full)).toHaveLength(SETTINGS_GROUPS.length);
  });

  it("never shows a member an admin group", () => {
    const ids = visibleSettingsGroups({ ...full, isAdmin: false }).map(
      (g) => g.id
    );
    expect(ids).not.toContain("people");
    expect(ids).not.toContain("server");
    expect(ids).not.toContain("logs");
    // …and still shows every member group.
    expect(ids).toContain("account");
    expect(ids).toContain("notifications");
  });

  it("drops per-profile groups that don't apply to this profile", () => {
    const ids = visibleSettingsGroups({
      isAdmin: false,
      trainingRelevant: false,
      nutritionRelevant: false,
    }).map((g) => g.id);
    expect(ids).not.toContain("training");
    expect(ids).not.toContain("nutrition");
    expect(ids).toContain("health");
  });

  it("preserves registry order (member groups before admin ones)", () => {
    const ids = visibleSettingsGroups(full).map((g) => g.id);
    const lastMember = ids.lastIndexOf("privacy");
    const firstAdmin = ids.indexOf("people");
    expect(lastMember).toBeLessThan(firstAdmin);
  });
});

describe("isSettingsGroupActive", () => {
  it("matches a group's own route", () => {
    const g = settingsGroup("account");
    expect(isSettingsGroupActive(g, "/settings/account")).toBe(true);
    expect(isSettingsGroupActive(g, "/settings/display")).toBe(false);
  });

  it("a group with sub-pages lights up for any of them", () => {
    const logs = settingsGroup("logs");
    expect(isSettingsGroupActive(logs, "/settings/logs")).toBe(true);
    expect(isSettingsGroupActive(logs, "/settings/errors")).toBe(true);
    expect(isSettingsGroupActive(logs, "/settings/audit")).toBe(true);
    expect(isSettingsGroupActive(logs, "/settings/server")).toBe(false);
  });
});

describe("tierBlurb", () => {
  const names = { username: "ada", profileName: "Test Patient" };
  it("names the login for a login-tier group", () => {
    expect(tierBlurb("login", names)).toContain("ada");
  });
  it("names the profile for a profile-tier group", () => {
    expect(tierBlurb("profile", names)).toContain("Test Patient");
  });
  it("says server for a server-tier group", () => {
    expect(tierBlurb("server", names)).toMatch(/server/i);
  });
  it("names BOTH for a mixed-tier group, and points at the per-section strings", () => {
    // #1868 §4: the honest fourth case. A mixed group's header may not claim one tier —
    // that is what forced Notifications to grow a second, page-local labeling system.
    const blurb = tierBlurb("mixed", names);
    expect(blurb).toContain("ada");
    expect(blurb).toContain("Test Patient");
    expect(blurb).toMatch(/each section/i);
  });
});

describe("the Notifications group is registered MIXED (#1868 §4)", () => {
  it("does not claim a single tier", () => {
    // The page's cards genuinely span tiers: Telegram/Push/digest-mirror/mute follow
    // the login, the schedule and content follow the profile, and the routing matrix
    // writes login and profile keys in adjacent columns.
    expect(settingsGroup("notifications").tier).toBe("mixed");
  });
});

describe("tierChip — the index's short form of the same statement", () => {
  const names = { username: "ada", profileName: "Test Patient" };
  it("uses one vocabulary with tierBlurb", () => {
    expect(tierChip("login", names)).toBe("your login");
    expect(tierChip("profile", names)).toBe("Test Patient");
    expect(tierChip("server", names)).toMatch(/server/i);
  });
  it("never mislabels a mixed group as belonging to the profile", () => {
    const chip = tierChip("mixed", names);
    expect(chip).toContain("your login");
    expect(chip).toContain("Test Patient");
  });
});

describe("both navigation renderings read the registry (#1462 §5)", () => {
  // The failure this guards against is the one that created the mess: a second
  // navigation surface with its OWN hand-kept list of groups, which then drifts. Both
  // renderings must import the registry, and neither may hard-code a group's label or
  // route as a literal.
  const RENDERERS = [
    join(SETTINGS_DIR, "page.tsx"), // the index rows
    join(SETTINGS_DIR, "SettingsGroupNav.tsx"), // the group pages' left nav
  ];

  it("each rendering imports the registry", () => {
    for (const file of RENDERERS) {
      const src = readFileSync(file, "utf8");
      expect(src, `${file} should read lib/settings-groups`).toMatch(
        /settings-groups/
      );
    }
  });

  it("no rendering hard-codes a group label or route", () => {
    for (const file of RENDERERS) {
      const src = readFileSync(file, "utf8");
      // Strip comments so an explanatory comment naming a group doesn't false-fail.
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const g of SETTINGS_GROUPS) {
        expect(
          code.includes(`"${g.route}"`),
          `${file} hard-codes route ${g.route} instead of reading the registry`
        ).toBe(false);
        expect(
          code.includes(`"${g.label}"`),
          `${file} hard-codes label "${g.label}" instead of reading the registry`
        ).toBe(false);
      }
    }
  });
});
