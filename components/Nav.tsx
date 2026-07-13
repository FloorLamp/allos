"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  IconLayoutDashboard,
  IconTimelineEvent,
  IconTrendingUp,
  IconFlask2,
  IconCalendarClock,
  IconUsersGroup,
  IconBarbell,
  IconChartLine,
  IconPill,
  IconVaccine,
  IconCalendarEvent,
  IconAlertTriangle,
  IconStethoscope,
  IconMedicalCross,
  IconHeartHandshake,
  IconClipboardList,
  IconTarget,
  IconDatabase,
  IconSettings,
  IconId,
  IconReportMedical,
  IconEmergencyBed,
  IconChevronRight,
  IconPuzzle,
  IconSalad,
  type TablerIcon,
} from "@tabler/icons-react";
import { isRouteActive, isGroupActive, isNavLeafVisible } from "@/lib/nav";
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
    { href: "/biomarkers", label: "Biomarkers", icon: IconChartLine },
    { href: "/conditions", label: "Conditions", icon: IconStethoscope },
    { href: "/allergies", label: "Allergies", icon: IconAlertTriangle },
    { href: "/procedures", label: "Procedures", icon: IconMedicalCross },
    {
      href: "/family-history",
      label: "Family History",
      icon: IconHeartHandshake,
    },
    { href: "/care-plan", label: "Care Plan", icon: IconClipboardList },
    { href: "/care-goals", label: "Health Goals", icon: IconTarget },
    { href: "/medicine", label: "Supplements & Meds", icon: IconPill },
    { href: "/immunizations", label: "Immunizations", icon: IconVaccine },
    { href: "/encounters", label: "Visits", icon: IconCalendarEvent },
    { href: "/providers", label: "Providers", icon: IconStethoscope },
    { href: "/coverage", label: "Coverage gaps", icon: IconPuzzle },
    { href: "/profile", label: "Passport", icon: IconId },
    { href: "/emergency", label: "Emergency Card", icon: IconEmergencyBed },
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
const entries: Entry[] = [
  { href: "/", label: "Dashboard", icon: IconLayoutDashboard },
  { href: "/timeline", label: "Timeline", icon: IconTimelineEvent },
  { href: "/trends", label: "Trends", icon: IconTrendingUp },
  {
    href: "/nutrition",
    label: "Nutrition",
    icon: IconSalad,
    // Hidden for an infant profile (< 1 y); the page also gates server-side (#591).
    requiresFoodLogging: true,
  },
  { href: "/protocols", label: "Protocols", icon: IconFlask2 },
  { href: "/upcoming", label: "Upcoming", icon: IconCalendarClock },
  {
    href: "/household",
    label: "Household",
    icon: IconUsersGroup,
    // Open to any login with 2+ accessible profiles (admin or caregiver member) —
    // issue #31. The page re-checks the accessible-profile count server-side.
    requiresMultiProfile: true,
  },
  { href: "/training", label: "Training", icon: IconBarbell },
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
}: {
  group: Group;
  restricted: boolean;
  isAdmin: boolean;
  multiProfile: boolean;
  foodLoggingRelevant: boolean;
}) {
  const pathname = usePathname();
  // Reuse the same visibility predicate as the top-level entries so a group
  // child honors the age-gate (RESTRICTED_HREFS), `adminOnly`,
  // `requiresMultiProfile`, and `requiresFoodLogging` identically — otherwise
  // appending a gated leaf to a group's children (which the array shape invites)
  // would leak it in the sidebar.
  const children = group.children.filter((c) =>
    isNavLeafVisible(c, {
      isAdmin,
      restricted,
      multiProfile,
      foodLoggingRelevant,
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
}) {
  const visible = entries.filter((e) =>
    isGroup(e)
      ? true
      : isNavLeafVisible(e, {
          isAdmin,
          restricted,
          multiProfile,
          foodLoggingRelevant,
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
          />
        ) : (
          <NavLink key={e.href} leaf={e} nested={false} />
        )
      )}
    </nav>
  );
}
