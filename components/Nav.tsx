"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  IconLayoutDashboard,
  IconTimelineEvent,
  IconTrendingUp,
  IconMoon,
  IconHourglass,
  IconCalendarClock,
  IconUsersGroup,
  IconBarbell,
  IconChartLine,
  IconPill,
  IconVirus,
  IconDroplet,
  IconDatabase,
  IconSettings,
  IconId,
  IconReportMedical,
  IconChevronRight,
  IconSalad,
  type TablerIcon,
} from "@tabler/icons-react";
import { isRouteActive, isGroupActive, isNavLeafVisible } from "@/lib/nav";
import {
  DEFAULT_NAV_RELEVANCE,
  type NavRelevance,
  type NavRelevanceKey,
} from "@/lib/nav-relevance";
import type { AppRoute } from "@/lib/hrefs";

type Leaf = {
  href: AppRoute;
  label: string;
  icon: TablerIcon;
  // `adminOnly` entries are dropped for non-admins. Hiding the link is cosmetic —
  // the page itself calls requireAdmin(), which is the real gate. (No top-level
  // entry uses this today; kept for future admin-only surfaces.)
  adminOnly?: boolean;
  // `requiresMultiProfile` entries are dropped unless the caller has more than
  // one ACCESSIBLE profile (issue #31): the Household cross-profile overview is
  // meaningless with a single profile, so a single-profile login (member or a
  // one-profile instance) never sees it, while any login granted 2+ profiles does.
  requiresMultiProfile?: boolean;
  // `requiresFoodLogging` entries are dropped for an infant profile (< 1 y) — the
  // adult food-group serving catalog is meaningless there (issue #591). Cosmetic;
  // the page re-checks isFoodLoggingRelevant server-side. Eligible on unknown age.
  requiresFoodLogging?: boolean;
  // Entries carrying a `relevanceKey` are dropped when the server-resolved
  // relevance bitset (lib/nav-relevance.ts, issue #1042) reads false for that
  // key. In nav today only Cycle uses it (the data/life-stage gate); the
  // Vision/Dental data-presence bits from the SAME bitset now gate their folded
  // /records specialty sections instead. Cosmetic — every gated page still renders
  // on a direct URL.
  relevanceKey?: NavRelevanceKey;
};

type Group = {
  // A collapsible submenu. Its `children` are leaves that live one level down;
  // adding a new child (e.g. Visits/Encounters) is a
  // one-line array edit here.
  group: string;
  icon: TablerIcon;
  children: Leaf[];
};

type Entry = Leaf | Group;

const isGroup = (e: Entry): e is Group => "group" in e;

// The medical-record pages, grouped under a single collapsible "Medical" entry
// so the sidebar stays uncluttered. Passport is the LAST child — it
// is the summary of these records — so it lives here rather than top-level; the
// children array is the only place the records live — append here to add another.
const RECORDS: Group = {
  group: "Medical",
  icon: IconReportMedical,
  children: [
    // Health record (#1042, retabbed #1079): the core Medical index pages —
    // Conditions, Allergies, Procedures, Immunizations, Family history, Visits,
    // Providers, Background, Care plan, Health goals, AND the four specialty surfaces
    // Vision, Dental, Skin, Mental health — merged into ONE surface, now organized as
    // two-level tabs (group → section → pane) under /records (History / Problems /
    // Care / Specialty). One "Health record" leaf, FIRST in the group, replaces them
    // all; bare /records lands on /records/history/visits. The removed index routes
    // 308-redirect to their owning pane (next.config.js); their DETAIL routes
    // (/providers/[id], /encounters/[id], /immunizations/[vaccine]) survive. The
    // Vision/Dental panes are data-gated (getNavRelevance) — a hidden sub-tab's route
    // re-gates server-side; Skin/Mental health always render.
    { href: "/records", label: "Health record", icon: IconReportMedical },
    // Results (#1042 phase 5, retabbed #1079): the Biomarkers / Imaging / Genomics
    // index pages merged into ONE surface, now route-per-tab under /results
    // (/results/biomarkers|/imaging|/genomics) — one leaf replaces the three; bare
    // /results lands on /results/biomarkers. The per-biomarker detail route
    // (/biomarkers/view) survives at its own URL; like other unlinked detail pages it
    // highlights no nav entry.
    { href: "/results", label: "Results", icon: IconChartLine },
    // Supplements left this group for the Nutrition → Supplements tab (#746);
    // Medications kept a Medical-group home of their own. The old combined
    // "/medicine" surface now redirects to the Supplements tab.
    { href: "/medications", label: "Medications", icon: IconPill },
    { href: "/medical/episodes", label: "Illness episodes", icon: IconVirus },
    // Cycle shows when cycle tracking is relevant for the active profile —
    // logged cycles always win; else female + premenopausal (explicit status or
    // the #494 age fallback). See cycleTrackingRelevant (lib/nav-relevance.ts);
    // the page itself never hard-blocks (#1042).
    {
      href: "/medical/cycles",
      label: "Cycle",
      icon: IconDroplet,
      relevanceKey: "cycle",
    },
    // Substance use folded into Health record › Specialty (#1175, beside Mental
    // health) — the standalone leaf became the /records/specialty/substance-use
    // section + its jump-link, life-stage-gated to adults (#1174). The old
    // /medical/substance-use route was removed with NO redirect (standing
    // preference); typed AppRoute (#285) build-errors any surviving literal.
    // Mental health folded into Health record (#1042 final tail): its crisis line
    // travels WITH the /records/specialty/mental-health pane (the safety contract is
    // content, not route), so the standalone "Crisis support" nav slot was removed
    // too — /crisis-resources stays a reachable route (the section's calm link + the
    // non-dismissible escalation notice both point at it), only the nav leaf is gone.
    // Passport also carries the Emergency Card as its #emergency section
    // (#1042 phase 3) — the old /emergency route 308-redirects there
    // (next.config.js), so one entry covers both print artifacts.
    { href: "/profile", label: "Passport", icon: IconId },
  ],
};

// The sidebar consolidation (folding Insights → Trends "Insights" tab, Body
// Metrics → Trends "Body" tab, and Integrations → the Import hub) trimmed three
// standalone entries. The old routes were REMOVED outright — next.config.js
// defines no redirects — so anything still linking one 404s. Since #285 that
// can't reach production: `href` here is typed `AppRoute`, and with `typedRoutes`
// on (next.config.js) an href to a page that no longer exists is a `tsc` (⇒
// `npm run build`) error. The nav-routes / due-signal source guards
// (lib/__tests__/nav-routes.test.ts) remain as a redundant belt-and-braces check.
//
// ORDER (#1042 design principle 1): frequency earns nav position; urgency earns
// dashboard promotion; NEITHER earns both. The nav is a directory, ordered by
// how often each surface is deliberately visited — the daily loop deliberately
// does NOT run through it (dose confirms = dashboard widget/Telegram; activity
// log = the sidebar's pinned LogActivityButton; live workout = the dock), and
// episodic surfaces (illness, cycle) get contextual promotion via the existing
// heroes, not permanent prominence. Reference surfaces (Medical, Data, Settings)
// sit at the bottom regardless of how important their content is.
const entries: Entry[] = [
  { href: "/", label: "Dashboard", icon: IconLayoutDashboard },
  { href: "/training", label: "Training", icon: IconBarbell },
  {
    href: "/nutrition",
    label: "Nutrition",
    icon: IconSalad,
    // Hidden for an infant profile (< 1 y); the page also gates server-side (#591).
    requiresFoodLogging: true,
  },
  { href: "/timeline", label: "Timeline", icon: IconTimelineEvent },
  { href: "/trends", label: "Trends", icon: IconTrendingUp },
  // Sleep (#1066): a data-gated READING surface between Trends and Upcoming — it
  // heads the reading cluster (a one-morning-glance page), and its adjacency to
  // Trends fails-soft the old muscle-memory path (sleep is being extracted FROM
  // Trends → Body). Gate = any recorded sleep session (the `sleep` relevance bit);
  // like every relevance gate it's cosmetic — the page stays reachable by URL (the
  // pillar deep-link and dashboard tile both point here).
  {
    href: "/sleep",
    label: "Sleep",
    icon: IconMoon,
    relevanceKey: "sleep",
  },
  { href: "/upcoming", label: "Upcoming", icon: IconCalendarClock },
  {
    href: "/household",
    label: "Household",
    icon: IconUsersGroup,
    // Open to any login with 2+ accessible profiles (admin or caregiver member) —
    // issue #31. The page re-checks the accessible-profile count server-side.
    requiresMultiProfile: true,
  },
  // Longevity took over Protocols' slot in #1042 phase 4: the healthspan-pillar
  // page whose #protocols section absorbed the old Protocols hub (the /protocols
  // URL 308-redirects there). Ungated, exactly as Protocols was.
  { href: "/longevity", label: "Longevity", icon: IconHourglass },
  RECORDS,
  // One "Data" umbrella covering both halves — bringing data in (upload/paste/
  // connect) and managing/exporting what's logged. The former standalone /import
  // hub folded into /data as its "Import" tab; nav label and URL match.
  { href: "/data", label: "Data", icon: IconDatabase },
  { href: "/settings", label: "Settings", icon: IconSettings },
];

// Nav entries FULLY hidden for age-restricted profiles (see lib/age-gate.ts).
// Empty since #489: Training is no longer all-or-nothing — a restricted profile
// keeps a lightweight sport/cardio activity log there (the page swaps in
// RestrictedActivityView and gates only the adult strength/analytics content), so
// the nav link must stay reachable. AI Insights already folded into the Trends
// "Insights" tab (server-gated), and no other top-level route is age-gated. The
// mechanism is retained (and group children are still filtered against it) so a
// future genuinely-gated route is one array entry away.
const RESTRICTED_HREFS = new Set<string>([]);

const leafClass = (active: boolean, nested: boolean) =>
  `flex items-center gap-3 rounded-lg py-2 text-sm font-medium transition ${
    nested ? "pl-10 pr-3" : "px-3"
  } ${
    active
      ? "bg-gradient-to-r from-brand-500 to-brand-600 text-white shadow-sm"
      : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-ink-750"
  }`;

function NavLink({ leaf, nested }: { leaf: Leaf; nested: boolean }) {
  const pathname = usePathname();
  const active = isRouteActive(leaf.href, pathname);
  const Icon = leaf.icon;
  return (
    <Link href={leaf.href} className={leafClass(active, nested)}>
      <Icon className="h-5 w-5 shrink-0" stroke={1.75} />
      {leaf.label}
    </Link>
  );
}

function NavGroup({
  group,
  restricted,
  isAdmin,
  multiProfile,
  foodLoggingRelevant,
  hasIntakeItems,
  relevance,
}: {
  group: Group;
  restricted: boolean;
  isAdmin: boolean;
  multiProfile: boolean;
  foodLoggingRelevant: boolean;
  hasIntakeItems: boolean;
  relevance: NavRelevance;
}) {
  const pathname = usePathname();
  // Reuse the same visibility predicate as the top-level entries so a group
  // child honors the age-gate (RESTRICTED_HREFS), `adminOnly`,
  // `requiresMultiProfile`, `requiresFoodLogging`, and the relevance bitset
  // identically — otherwise appending a gated leaf to a group's children (which
  // the array shape invites) would leak it in the sidebar.
  const children = group.children.filter((c) =>
    isNavLeafVisible(c, {
      isAdmin,
      restricted,
      multiProfile,
      foodLoggingRelevant,
      hasIntakeItems,
      relevance,
      restrictedHrefs: RESTRICTED_HREFS,
    })
  );
  // Force-expanded whenever a child route is active so the active item is always
  // visible; otherwise honor the user's manual toggle. Deriving `expanded` this
  // way (rather than syncing state in an effect) keeps the active child on
  // screen after navigation without an extra render.
  const active = isGroupActive(
    children.map((c) => c.href),
    pathname
  );
  const [open, setOpen] = useState(false);
  const expanded = open || active;
  if (children.length === 0) return null;
  const Icon = group.icon;
  const panelId = `nav-group-${group.group.replace(/\s+/g, "-").toLowerCase()}`;
  return (
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={expanded}
        aria-controls={panelId}
        className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
          active
            ? "text-slate-900 dark:text-white"
            : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-ink-750"
        }`}
      >
        <Icon className="h-5 w-5 shrink-0" stroke={1.75} />
        <span className="flex-1 text-left">{group.group}</span>
        <IconChevronRight
          aria-hidden
          className={`h-4 w-4 shrink-0 transition-transform ${
            expanded ? "rotate-90" : ""
          }`}
          stroke={1.75}
        />
      </button>
      {expanded && (
        <div id={panelId} className="flex flex-col gap-0.5">
          {children.map((c) => (
            <NavLink key={c.href} leaf={c} nested />
          ))}
        </div>
      )}
    </div>
  );
}

export default function Nav({
  restricted = false,
  isAdmin = false,
  multiProfile = false,
  foodLoggingRelevant = true,
  hasIntakeItems = false,
  relevance = DEFAULT_NAV_RELEVANCE,
}: {
  restricted?: boolean;
  isAdmin?: boolean;
  // True when the caller has more than one ACCESSIBLE profile; gates entries
  // flagged `requiresMultiProfile` (e.g. the Household cross-profile overview).
  multiProfile?: boolean;
  // True unless the active profile is an infant (< 1 y); gates entries flagged
  // `requiresFoodLogging` (Nutrition). Defaults true so a caller that doesn't
  // thread it never over-hides.
  foodLoggingRelevant?: boolean;
  // True when the active profile tracks any intake item (#746). Keeps the
  // Nutrition entry (→ Supplements tab) visible for an infant who takes a
  // supplement even though food-group logging isn't relevant. Defaults false so
  // the Food-logging gate stands on its own when a caller doesn't thread it.
  hasIntakeItems?: boolean;
  // The server-resolved relevance bitset (issue #1042) gating entries flagged
  // with a `relevanceKey` (Cycle in nav; the Vision/Dental bits now gate the
  // /records specialty sections). Defaults all-true so a caller that doesn't thread
  // it never over-hides.
  relevance?: NavRelevance;
}) {
  const visible = entries.filter((e) =>
    isGroup(e)
      ? true
      : isNavLeafVisible(e, {
          isAdmin,
          restricted,
          multiProfile,
          foodLoggingRelevant,
          hasIntakeItems,
          relevance,
          restrictedHrefs: RESTRICTED_HREFS,
        })
  );
  return (
    <nav className="flex flex-col gap-0.5">
      {visible.map((e) =>
        isGroup(e) ? (
          <NavGroup
            key={e.group}
            group={e}
            restricted={restricted}
            isAdmin={isAdmin}
            multiProfile={multiProfile}
            foodLoggingRelevant={foodLoggingRelevant}
            hasIntakeItems={hasIntakeItems}
            relevance={relevance}
          />
        ) : (
          <NavLink key={e.href} leaf={e} nested={false} />
        )
      )}
    </nav>
  );
}
