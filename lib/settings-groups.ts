// The Settings group registry (issue #1462) — the ONE source of truth for how the
// Settings surface is organized, navigated, and gated.
//
// Why a registry. Settings had grown THREE navigation systems on one surface (a top
// tab strip, the Profile tab's anchor jump-nav, and the admin pill row) wrapped
// around scroll walls (the Profile page measured ~4,900px on a phone). #1462
// replaced them with topic-first GROUPS, each a real route of 1–4 cards, and every
// rendering of settings navigation — the /settings index rows and the group pages'
// persistent left nav — derives from this list. One question, one computation: a new
// group can't appear in one nav and not the other, and the reflection test in
// lib/__tests__/settings-groups.test.ts pins registry ⇄ real App-Router pages.
//
// TIER vs TOPIC. The three STORAGE tiers (global `settings`, per-login
// `login_settings`, per-profile `profile_settings`) are unchanged — this registry
// reorganizes SURFACES only. What changed is the presentation: tier used to BE the
// architecture (the "settings UI mirrors the tiers as tabs" principle), and is now a
// per-page LABEL (`tierBlurb`) stated in each group page's subtitle. No setting moved
// between stores, and no gate moved: `adminOnly` here is a NAVIGATION hint only —
// every admin group page still calls requireAdmin() itself, so a direct URL redirects
// a member exactly as before.

import type { AppRoute } from "./hrefs";

// The scope a group's header states. Three of these name ONE storage tier; `mixed`
// (#1868 §4) names the honest fourth case — a group whose cards genuinely span tiers,
// which today is exactly Notifications (AGENTS.md documents it as intentionally
// mixed-scope: delivery channels follow the login, schedules and content follow the
// profile, and the matrix writes login and profile keys in adjacent columns). Before
// this, that page claimed "Applies to ⟨profile⟩" in its header and then contradicted
// itself with a second, page-local scope-labeling system per section. `mixed` makes
// the header true; the per-section strings stay as the fine-grained layer.
export type SettingsTier = "login" | "profile" | "mixed" | "server";

export const SETTINGS_GROUP_IDS = [
  "account",
  "display",
  "health",
  "training",
  "nutrition",
  "coaching",
  "notifications",
  "privacy",
  "people",
  "server",
  "logs",
] as const;

export type SettingsGroupId = (typeof SETTINGS_GROUP_IDS)[number];

// A group whose relevance depends on the active profile, not on the login's role:
// Training is hidden for an age-restricted profile and Nutrition for a profile too
// young for food-group logging — the same predicates the old Profile tab used to drop
// those sections. The group's PAGE still exists (it renders an explanatory empty
// state); only the nav entry is dropped, so no link can 404.
export type SettingsGroupRelevance = "training" | "nutrition";

export type SettingsGroupPage = {
  href: AppRoute;
  label: string;
};

export type SettingsGroup = {
  id: SettingsGroupId;
  label: string;
  route: AppRoute;
  tier: SettingsTier;
  // Navigation visibility only — never the auth check (see the header note).
  adminOnly: boolean;
  // One sentence, shown under the label on the /settings index. Per the copy
  // standard (docs/internals/copy.md, #945) these stay to a single sentence.
  summary: string;
  relevance?: SettingsGroupRelevance;
  // Sub-pages rendered by the group nav when the group is active. Three groups have
  // them: Logs & audit (AI logs / Errors / Audit are three diagnostic VIEWERS that
  // share one topic but can't sensibly share one page), Account & security (API
  // tokens, #1734 — a credential REGISTRY with its own mint/revoke lifecycle, which
  // does not belong stacked under the password and 2FA forms), and Server (AI,
  // #1870 — the provider tiers + automation cards, split off the ten-card Server
  // page). They come from this same registry, so they are part of the one nav, not
  // a fourth system.
  pages?: readonly SettingsGroupPage[];
};

export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    id: "account",
    label: "Account & security",
    route: "/settings/account",
    tier: "login",
    adminOnly: false,
    summary:
      "Password, two-factor authentication, the devices you're signed in on, and your API tokens.",
    // API tokens (#1734) sit in the LOGIN tier beside sessions and 2FA, because a
    // token is another way to present this login — not a per-profile setting. It
    // earns its own sub-page rather than a fourth card: minting shows a secret
    // exactly once, which needs room and its own explanation.
    pages: [
      { href: "/settings/account", label: "Account & security" },
      { href: "/settings/tokens", label: "API tokens" },
    ],
  },
  {
    id: "display",
    label: "Display & units",
    route: "/settings/display",
    tier: "login",
    adminOnly: false,
    summary: "How weights, distances, dates, and times are shown to you.",
  },
  {
    id: "health",
    label: "Health profile",
    route: "/settings/health",
    tier: "profile",
    adminOnly: false,
    summary:
      "Photo, name, sex, birthdate, timezone, and the week this person's routine follows.",
  },
  {
    id: "training",
    label: "Training",
    route: "/settings/training",
    tier: "profile",
    adminOnly: false,
    summary:
      "Heart-rate zones, the weekly zone-2 target, and your daily step target.",
    relevance: "training",
  },
  {
    id: "nutrition",
    label: "Nutrition",
    route: "/settings/nutrition",
    tier: "profile",
    adminOnly: false,
    summary:
      "The training goal behind the protein band, and food groups to leave out of suggestions and guidance.",
    relevance: "nutrition",
  },
  {
    id: "coaching",
    label: "Coaching & AI",
    route: "/settings/coaching",
    tier: "profile",
    adminOnly: false,
    summary:
      "How often recommendations refresh, and which daily check-in scales are offered.",
  },
  {
    id: "notifications",
    label: "Notifications",
    route: "/settings/notifications",
    // MIXED, and honestly so (#1868 §4): Telegram, Web Push, the digest mirror and the
    // mute follow the LOGIN; the schedule, quiet hours and message content follow the
    // PROFILE; the Home Assistant webhook follows the profile too. Claiming a single
    // tier here is what forced the page to grow its own second labeling system.
    tier: "mixed",
    adminOnly: false,
    summary:
      "Where reminders arrive, when they're sent, and which kinds you get.",
  },
  {
    id: "privacy",
    label: "Privacy",
    route: "/settings/privacy",
    tier: "profile",
    adminOnly: false,
    summary:
      "How much mental-health detail is shared, and which crisis resources are shown.",
  },
  {
    id: "people",
    label: "People & access",
    route: "/settings/family",
    tier: "server",
    adminOnly: true,
    summary: "Profiles, logins, and which logins can see which profiles.",
  },
  {
    id: "server",
    label: "Server",
    route: "/settings/server",
    tier: "server",
    adminOnly: true,
    summary:
      "Instance-wide configuration: public URL, email, the Telegram bot, AI, and backups.",
    // The two AI cards (provider tiers #875 + automation knobs) earn a sub-page
    // rather than staying stacked in a ten-card scroll (#1870 owner ruling — the
    // account→tokens precedent). Same tier, same requireAdmin() gate as the parent.
    pages: [
      { href: "/settings/server", label: "Server" },
      { href: "/settings/ai", label: "AI" },
    ],
  },
  {
    id: "logs",
    label: "Logs & audit",
    route: "/settings/logs",
    tier: "server",
    adminOnly: true,
    summary:
      "Diagnostic viewers: AI calls, server errors, the notification tick, and the audit trail.",
    // A FOURTH viewer rather than a fold into Errors (#2209). Errors is deliberately
    // an SSR snapshot with a Clear button because errors are rare and low-volume; the
    // tick is 96 runs a day times every profile, and its unit is a RUN, not a line.
    // Different volume, different row model, different page.
    pages: [
      { href: "/settings/logs", label: "AI logs" },
      { href: "/settings/errors", label: "Errors" },
      { href: "/settings/notify-log", label: "Notify tick" },
      { href: "/settings/audit", label: "Audit" },
    ],
  },
];

const BY_ID = new Map<SettingsGroupId, SettingsGroup>(
  SETTINGS_GROUPS.map((g) => [g.id, g])
);

export function settingsGroup(id: SettingsGroupId): SettingsGroup {
  const g = BY_ID.get(id);
  /* istanbul ignore next -- unreachable: the id union is the registry's own keys */
  if (!g) throw new Error(`unknown settings group: ${id}`);
  return g;
}

export type SettingsGroupContext = {
  isAdmin: boolean;
  // Whether the active profile is old enough for the training surfaces (the
  // age-gate predicate) and for food-group logging.
  trainingRelevant: boolean;
  nutritionRelevant: boolean;
};

// The groups a given viewer should SEE in navigation. Member logins never see an
// adminOnly group (and each admin page re-gates server-side anyway); an irrelevant
// per-profile group is dropped for this profile only.
export function visibleSettingsGroups(
  ctx: SettingsGroupContext
): SettingsGroup[] {
  return SETTINGS_GROUPS.filter((g) => {
    if (g.adminOnly && !ctx.isAdmin) return false;
    if (g.relevance === "training" && !ctx.trainingRelevant) return false;
    if (g.relevance === "nutrition" && !ctx.nutritionRelevant) return false;
    return true;
  });
}

// Whether a group's nav entry should read as current for a pathname. A group with
// sub-pages lights up for any of them (Logs & audit fronts three viewers).
export function isSettingsGroupActive(
  group: SettingsGroup,
  pathname: string
): boolean {
  if (pathname === group.route) return true;
  return (group.pages ?? []).some((p) => p.href === pathname);
}

// The one-line scope statement each group page prints in its subtitle — the tier as
// a LABEL rather than as the navigation architecture (#1462 §1).
export function tierBlurb(
  tier: SettingsTier,
  names: { username: string; profileName: string }
): string {
  switch (tier) {
    case "login":
      return `Applies to your login (${names.username}) on every profile.`;
    case "profile":
      return `Applies to ${names.profileName}.`;
    case "mixed":
      return `Partly your login (${names.username}) and partly ${names.profileName} — each section below says which.`;
    case "server":
      return "Applies to this server — admins only.";
  }
}

// The SHORT form of the same statement — the chip the /settings index prints beside a
// group label. One vocabulary, two lengths: the index used to decide this inline with
// a `tier === "login" ? … : profileName` ternary, which quietly mislabels any tier the
// registry gains (a mixed group would have read as the profile's name).
export function tierChip(
  tier: SettingsTier,
  names: { username: string; profileName: string }
): string {
  switch (tier) {
    case "login":
      return "your login";
    case "profile":
      return names.profileName;
    case "mixed":
      return `your login + ${names.profileName}`;
    case "server":
      return "this server";
  }
}

// Every route this registry can navigate to (group routes plus sub-pages), which the
// reflection test compares against the real App-Router page tree.
export function settingsRegistryRoutes(): string[] {
  const out: string[] = [];
  for (const g of SETTINGS_GROUPS) {
    out.push(g.route);
    for (const p of g.pages ?? []) out.push(p.href);
  }
  return [...new Set(out)];
}
