"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import PendingNavLink from "@/components/PendingNavLink";
import {
  IconCamera,
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
  IconSparkles,
  IconCalendarStats,
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
  // Workout-oriented Training stands down through early childhood. Existing
  // activity facts remain reachable from their record links.
  requiresTraining?: boolean;
  // Entries carrying a `relevanceKey` are dropped when the server-resolved
  // relevance bitset (lib/nav-relevance.ts, issue #1042) reads false for that
  // key. Cycle, Sleep, Progress photos, and Wellness use it in nav; the
  // Vision/Dental data-presence bits from the SAME bitset gate their folded
  // /records specialty sections instead. Cosmetic — every gated page still renders
  // on a direct URL.
  relevanceKey?: NavRelevanceKey;
  // Entries carrying a `badgeKey` render the matching count from the `badges`
  // record as a pill on the right of the row (issue #1801). Only `review` exists:
  // the import-review count moved here from the retired profile menu, because it
  // is Data → Review's number and belongs on the Data entry.
  badgeKey?: NavBadgeKey;
};

export type NavBadgeKey = "review";
export type NavBadges = Partial<Record<NavBadgeKey, number>>;

// How each badge announces itself. The pill's digits alone say "3"; the label is
// what a screen reader hears.
const BADGE_LABEL: Record<NavBadgeKey, (n: number) => string> = {
  review: (n) => `${n} import ${n === 1 ? "item" : "items"} need attention`,
};

const BADGE_TESTID: Record<NavBadgeKey, string> = {
  review: "review-badge",
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
    // Results (#1042 phase 5, retabbed #1079): the Clinical results / Imaging /
    // Reports / Genomics
    // index pages merged into ONE surface, now route-per-tab under /results
    // (/results/clinical-results|/imaging|/genomics) — one leaf replaces the three; bare
    // /results lands on /results/clinical-results. The per-analyte detail route
    // (/results/clinical-results/view) survives at its own URL; like other unlinked detail pages it
    // highlights no nav entry.
    { href: "/results", label: "Results", icon: IconChartLine },
    // Supplements left this group for the Nutrition → Supplements tab (#746);
    // Medications kept a Medical-group home of their own. The former combined
    // intake surface was removed outright (#1635) and 404s.
    { href: "/medications", label: "Medications", icon: IconPill },
    // The household medicine cabinet (/supplies, #1374) is NOT a nav leaf (#1522).
    // It is a physical-object REGISTRY — bottles that intake items link to — and the
    // app already navigates to its twin, the /equipment registry, from the consumers
    // that create and use it rather than from the sidebar. Its old row was worse than
    // an ordinary one: `requiresMultiProfile` made it materialize unannounced the
    // moment a second profile was added, wearing the SAME IconPill as the Medications
    // row directly above it — the one signal that could have told them apart.
    // Its doors now: the Medications and Nutrition → Supplements headers (with a
    // count), the shared-bottle chip and the refill section of a linked item, and the
    // Household header (the cabinet is household-scoped). The ROUTE is unchanged, and
    // /supplies highlights Medications through NAV_PARENT_ROUTES (lib/nav.ts).
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

// The episodic group (#3079). Five top-level rows measured at ZERO deliberate
// visits in the owner's 2026-08-17 usage review — Timeline (now History), Upcoming, Household,
// Wellness, Longevity — plus Progress photos, which shares their shape. The
// measurement did not find six redundant pages: each holds writes that exist
// nowhere else (protocol creation only at /longevity#protocols, practice CRUD and
// back-dated logging only at /wellness, member setup only at /household, retro
// symptom entry for an arbitrary past day only at /history?day=, restore /
// preventive-override / care-plan completion only at /upcoming). NOTHING here is
// retired, no URL moves, and every gate below keeps the semantics it had as a
// top-level row.
//
// What the measurement found is FOUR DIFFERENT CAUSES, and the per-child notes
// below are the point of this group — only one of the six is a defect, and a
// uniform "these six scored zero" reading would have removed surfaces that are
// working correctly. The mobile side already made this call: #2651 fixed the dock
// at four slots and ruled explicitly that "Upcoming does not get a slot and stays
// reachable through More", so all of these already sit behind More on a phone.
// This aligns the sidebar with a decision the dock shipped.
const PLAN_REVIEW: Group = {
  group: "Plan & review",
  // Deliberately NOT any child's icon. The #1522 note above records what the
  // duplicate-IconPill row cost when a group child wore its neighbour's glyph:
  // the one signal that could have told them apart.
  icon: IconCalendarStats,
  children: [
    // UPCOMING — the charter working, NOT a defect. #2579 defines this as a
    // PLANNING-CADENCE surface: "the daily job… already has four surfaces closer
    // to the moment." A planning surface nobody opens daily is behaving exactly as
    // designed, and demoting it for scoring zero would be measuring the wrong
    // thing. It is here because a cadence surface is the definition of episodic,
    // not because its zero is a fault. Its real cost (the hero excluding
    // everything past today) is a separate issue and is untouched here.
    { href: "/upcoming", label: "Upcoming", icon: IconCalendarClock },
    // HISTORY — the record, which INHERITED this slot from Timeline when #3958
    // phase 2 retired `/timeline` (#3343, owner 2026-08-29: "when phase 2 absorbs
    // the timeline and vacates its slot, History inherits it"). Everything the note
    // below said about Timeline is now true of it: used constantly, never from the
    // nav, and the target of every DayHistory heatmap cell, every mini-calendar day
    // (components/EventCalendar.tsx, opened from the record's own filter row since
    // #4280), the weekly recap
    // widget, and several sleep and trends surfaces; it holds the same permanent
    // mobile dock slot (lib/mobile-dock.ts, the Q5 half of the same ruling). It is a
    // destination reached FROM CONTEXT — the unused thing was the row, not the page.
    //
    // Its retro symptom entry for an arbitrary past day, named in this group's
    // header note as `/timeline`'s unique write, moved with it to `?day=`.
    { href: "/history", label: "History", icon: IconTimelineEvent },
    // WELLNESS (#1620) — an episodic MANAGEMENT surface whose daily reading is
    // already promoted to the dashboard: a profile opens it to create or edit a
    // practice a few times a year. #2894's doctrine covers it — "tabs for surfaces
    // you live in, destination pages for episodic work."
    //
    // #3079 PROPOSED TAKING THIS OFF THE NAV ENTIRELY (NAV_PARENT_ROUTES
    // "/wellness" -> "/", highlighting Dashboard) ON THE #1522 PATTERN. THAT IS NOT
    // DONE HERE, AND THE REASON IS A FACT ABOUT THE TREE, NOT A DISAGREEMENT WITH
    // THE RULING. #1522 requires a surface reached from THE THING THAT CONSUMES IT.
    // The consumer the issue named — the dashboard habits widget's "Manage
    // practices →" link at components/dashboard/GoalsHabitsWidget.tsx:243 — NO
    // LONGER EXISTS: that widget was replaced by the atomic dashboard, and its
    // successor door (the section header of HabitProgressAtom, in
    // components/dashboard/ProgressAtoms.tsx) renders only when a practice-scope
    // FREQUENCY TARGET exists and that atom wins placement.
    //
    // The `wellness` relevance bit is `hasPracticeTargets || hasPracticeLogs`
    // (lib/queries/nav-relevance.ts) — the OR is deliberate, because a logs-only
    // practice is a real state (see the relevanceKey note above). So for a profile
    // that logs practices without a frequency target, the bit is TRUE, the row
    // shows today, and there is NO dashboard door at all: taking the row away would
    // leave global search and a typed URL, which is deletion with extra steps
    // rather than a surface reached from its consumer. A group child is demoted
    // exactly as far as its five neighbours here and keeps a door in the chrome.
    // Restore a durable consumer link and the off-nav move becomes a two-line
    // follow-up: this placement is chosen to be the reversible half of it.
    {
      href: "/wellness",
      label: "Wellness",
      icon: IconSparkles,
      relevanceKey: "wellness",
    },
    // LONGEVITY — the same episodic-management diagnosis as Wellness, and its
    // protocol picker shares the same practice targets, so the two stay adjacent as
    // #1620 placed them. Still adult-only (ADULT_ONLY_HREFS); NavGroup runs the
    // same isNavLeafVisible predicate as the top level, so the life-stage boundary
    // is unchanged by the move.
    { href: "/longevity", label: "Longevity", icon: IconHourglass },
    // HOUSEHOLD — already role-demoted by #1463 to a STATUS BOARD whose actions
    // cede to Upcoming. A board that needs no reading is a board nobody opens; the
    // nav is only now reflecting a role change that shipped two issues ago.
    // requiresMultiProfile is unchanged (#31) — a single-profile login still never
    // sees it, and with no other child gated out the group simply loses a row.
    {
      href: "/household",
      label: "Household",
      icon: IconUsersGroup,
      requiresMultiProfile: true,
    },
    // PROGRESS PHOTOS (#1119) — not one of the zero-use five, and included on shape
    // rather than on measurement: a data-gated visual review surface opened in
    // bursts around a training block. Its `progress` relevance bit and the
    // always-visible palette action (the un-gated first-capture door) are both
    // unchanged.
    {
      href: "/progress",
      label: "Progress photos",
      icon: IconCamera,
      relevanceKey: "progress",
    },
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
// does NOT run through it (dose confirms = dashboard presentation/Telegram; any
// quick log = the sidebar's pinned "+ Log" panel; live workout = the dock), and
// episodic surfaces (illness, cycle) get contextual promotion via the existing
// heroes, not permanent prominence. Reference surfaces (Medical, Data, Settings)
// sit at the bottom regardless of how important their content is.
//
// THE PRINCIPLE IS UNCHANGED; ITS INPUT IS NOT (#3079). #1042 set this order from
// a REASONED ESTIMATE of frequency, because that was the only input available.
// The owner's 2026-08-17 usage review is a MEASUREMENT, and re-running the same
// rule against it is what produced PLAN_REVIEW above: "how often each surface is
// deliberately visited" now means counted, not guessed. Note what the rule does
// NOT say — it does not say a zero count condemns a page. Timeline scores zero on
// DELIBERATE visits and is opened constantly from context; Upcoming scores zero
// because #2579 built it to be opened on a planning cadence. Both keep every
// route and every door they had; what they lose is a PERMANENT ROW, which is the
// only thing this sentence was ever rationing. The 2026-08-19 viewport census is
// why the rationing matters: at 1280x900 the sidebar showed rows only through
// Wellness in all 102 desktop captures, so the un-visited rows were pushing real
// destinations below the fold.
const entries: Entry[] = [
  { href: "/", label: "Dashboard", icon: IconLayoutDashboard },
  {
    href: "/training",
    label: "Training",
    icon: IconBarbell,
    requiresTraining: true,
  },
  {
    href: "/nutrition",
    label: "Nutrition",
    icon: IconSalad,
    // Hidden for an infant profile (< 1 y); the page also gates server-side (#591).
    requiresFoodLogging: true,
  },
  { href: "/trends", label: "Trends", icon: IconTrendingUp },
  // Year in review (#2179/#2762) remains user-initiated and ungated, but a
  // once-a-year commemorative page does not spend permanent nav chrome. It was
  // reached from the Timeline's header action until #3958 phase 2 deleted that
  // route; the command palette registers it now (lib/queries/search.ts), and
  // since #4102 retired the frequent-shortcut row, the palette is the ONLY door
  // — a sparse first year is reachable by search and by nothing else. Whether
  // the RECORD's header should carry the action the Timeline's did is an open
  // question on #3958 — it is a header addition on the one page with a stated
  // chrome budget.
  // Sleep (#1066): a data-gated READING surface below Trends — it
  // heads the reading cluster (a one-morning-glance page), and its adjacency to
  // Trends fails-soft the old muscle-memory path (sleep is being extracted FROM
  // Trends → Overview → body census). Gate = any recorded sleep session (the `sleep` relevance bit);
  // like every relevance gate it's cosmetic — the page stays reachable by URL (the
  // pillar deep-link and dashboard healthspan readout both point here).
  {
    href: "/sleep",
    label: "Sleep",
    icon: IconMoon,
    relevanceKey: "sleep",
  },
  // The episodic group (#3079) sits between the daily reading surfaces above and
  // the reference surfaces below — exactly where the ORDER note calls for a
  // cluster that is neither. Progress photos, Wellness and Longevity kept their
  // relevance and life-stage gates on the way in; see PLAN_REVIEW for the
  // per-surface diagnosis behind each child.
  PLAN_REVIEW,
  RECORDS,
  // One "Data" umbrella covering both halves — bringing data in (upload/paste/
  // connect) and managing/exporting what's logged. The former standalone /import
  // hub folded into /data as its "Import" tab; nav label and URL match.
  { href: "/data", label: "Data", icon: IconDatabase, badgeKey: "review" },
  { href: "/settings", label: "Settings", icon: IconSettings },
];

// Whole-route adult content. Activity, Timeline, Trends, and Equipment stay
// reachable; only the longevity/protocol content class is hidden here.
const ADULT_ONLY_HREFS = new Set<string>(["/longevity"]);

const leafClass = (active: boolean, nested: boolean) =>
  // Active = accent text on the accent-soft fill, per the palette doctrine
  // (#2701/#2719 review) — the old Vitals gradient turned into a loud solid
  // bar under the re-pointed ramps, and gradients are retired anyway.
  `flex items-center gap-3 rounded-lg py-2 text-sm font-medium transition ${
    nested ? "pl-10 pr-3" : "px-3"
  } ${
    active
      ? "bg-(--accent-soft) text-brand-800 dark:text-brand-400"
      : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-ink-750"
  }`;

function NavLink({
  leaf,
  nested,
  badges,
}: {
  leaf: Leaf;
  nested: boolean;
  badges: NavBadges;
}) {
  const pathname = usePathname();
  const active = isRouteActive(leaf.href, pathname);
  const Icon = leaf.icon;
  const badgeCount = leaf.badgeKey ? (badges[leaf.badgeKey] ?? 0) : 0;
  return (
    // `aria-current` carries what the gradient carries: a screen-reader user is told
    // which entry is the page they're on, and it gives the orphan-highlight fix
    // (#1522) a stable, semantic assertion instead of a class-name match.
    //
    // PendingNavLink, not a bare <Link> (#1956): a router transition under
    // `(app)` has no `loading.tsx` to reveal, so without it the tap has no
    // visible consequence until the whole destination has rendered — which is
    // what made people tap again, and a second tap restarts the navigation.
    <PendingNavLink
      href={leaf.href}
      label={leaf.label}
      current={active}
      icon={<Icon className="h-5 w-5 shrink-0" stroke={1.75} />}
      className={leafClass(active, nested)}
    >
      <span className="flex-1">{leaf.label}</span>
      {leaf.badgeKey && badgeCount > 0 && (
        <span
          data-testid={BADGE_TESTID[leaf.badgeKey]}
          aria-label={BADGE_LABEL[leaf.badgeKey](badgeCount)}
          className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-rose-500 px-1.5 text-xs font-semibold text-white"
        >
          {badgeCount}
        </span>
      )}
    </PendingNavLink>
  );
}

function NavGroup({
  group,
  inDrawer,
  adultContentAvailable,
  isAdmin,
  multiProfile,
  foodLoggingRelevant,
  hasIntakeItems,
  trainingRelevant,
  relevance,
  badges,
}: {
  group: Group;
  // The phone drawer, not the desktop sidebar. See the fold note below.
  inDrawer: boolean;
  adultContentAvailable: boolean;
  isAdmin: boolean;
  multiProfile: boolean;
  foodLoggingRelevant: boolean;
  hasIntakeItems: boolean;
  trainingRelevant: boolean;
  relevance: NavRelevance;
  badges: NavBadges;
}) {
  const pathname = usePathname();
  // Reuse the same visibility predicate as the top-level entries so a group
  // child honors the adult-content boundary (ADULT_ONLY_HREFS), `adminOnly`,
  // `requiresMultiProfile`, `requiresFoodLogging`, and the relevance bitset
  // identically — otherwise appending a gated leaf to a group's children (which
  // the array shape invites) would leak it in the sidebar.
  const children = group.children.filter((c) =>
    isNavLeafVisible(c, {
      isAdmin,
      adultContentAvailable,
      multiProfile,
      foodLoggingRelevant,
      hasIntakeItems,
      trainingRelevant,
      relevance,
      adultOnlyHrefs: ADULT_ONLY_HREFS,
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
  // THE FOLD IS A DESKTOP TRADE, AND THE PHONE MAKES THE OPPOSITE ONE (#3343 Q4).
  // Collapsing spends a TAP to buy back VERTICAL ROOM, which is the right trade
  // in a 1280x900 sidebar where the 2026-08-19 census found real destinations
  // pushed below the fold. In the drawer the scale is reversed — the panel scrolls
  // freely and a tap is the expensive thing — so the group's rows render inline,
  // still under their header and still indented as children of it. #2651 ruled the
  // dock's four slots; this is the drawer's own ruling, and the split is pinned in
  // e2e/nav-consolidation.spec.ts.
  const expanded = inDrawer || open || active;
  if (children.length === 0) return null;
  const Icon = group.icon;
  // Slugified on EVERY non-alphanumeric run, not just whitespace. Ids are only
  // ever consumed through `aria-controls`, which takes them verbatim — but a
  // label like "Plan & review" (#3079) would otherwise put an `&` in the id, and
  // while that is legal HTML it is not a valid CSS id SELECTOR, so anything
  // reaching for the panel by `#id` (a test, a future style hook) breaks on a
  // group whose name has punctuation in it. Group labels are author-controlled
  // ASCII, so a plain [^a-z0-9] run is the whole rule.
  const panelId = `nav-group-${group.group
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;
  const headerId = `${panelId}-label`;
  const headerTone = active
    ? "text-slate-900 dark:text-white"
    : "text-slate-600 dark:text-slate-300";
  const headerLabel = (
    <>
      <Icon className="h-5 w-5 shrink-0" stroke={1.75} />
      <span className="flex-1 text-left">{group.group}</span>
    </>
  );
  return (
    // `data-nav-group` is what makes "grouped" observable: the header and the
    // children share ONE container, so the rows are never siblings of the
    // top-level entries however the group is styled or which surface renders it.
    //
    // AND GROUPED FOR SOMEONE WHO CANNOT SEE THE INDENT. The sidebar's binding is
    // the disclosure button's own `aria-controls`; the drawer has no button, so
    // without this the header would be a bare label followed by loose links.
    // Restated the way this repo already names a container from its own visible
    // header — `aria-labelledby` at the heading's id (TrendsSectionShell,
    // DashboardAhead's Bucket), never a second copy of the label string — over
    // the `role="group"` this repo uses for a set of related controls. Drawer
    // only: adding it on the sidebar would name the group twice.
    <div
      data-nav-group={group.group}
      role={inDrawer ? "group" : undefined}
      aria-labelledby={inDrawer ? headerId : undefined}
      className="flex flex-col gap-0.5"
    >
      {inDrawer ? (
        // No disclosure to operate, so no control: a button that toggles nothing
        // is the tap this ruling exists to stop spending, and the chevron would
        // announce a fold that isn't there.
        <p
          id={headerId}
          className={`flex items-center gap-3 px-3 py-2 text-sm font-medium ${headerTone}`}
        >
          {headerLabel}
        </p>
      ) : (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={expanded}
          aria-controls={panelId}
          className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${headerTone} ${
            active ? "" : "hover:bg-slate-100 dark:hover:bg-ink-750"
          }`}
        >
          {headerLabel}
          <IconChevronRight
            aria-hidden
            className={`h-4 w-4 shrink-0 transition-transform ${
              expanded ? "rotate-90" : ""
            }`}
            stroke={1.75}
          />
        </button>
      )}
      {expanded && (
        <div id={panelId} className="flex flex-col gap-0.5">
          {children.map((c) => (
            <NavLink key={c.href} leaf={c} nested badges={badges} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function Nav({
  inDrawer = false,
  adultContentAvailable = true,
  isAdmin = false,
  multiProfile = false,
  foodLoggingRelevant = true,
  hasIntakeItems = false,
  trainingRelevant = true,
  relevance = DEFAULT_NAV_RELEVANCE,
  reviewCount = 0,
}: {
  // WHICH SURFACE IS RENDERING, not a style knob: true only for the phone
  // drawer (components/MobileNav.tsx), false for the desktop sidebar. Groups
  // fold on one and render inline on the other (#3343 Q4) — see NavGroup.
  inDrawer?: boolean;
  adultContentAvailable?: boolean;
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
  // False through early childhood; hides the workout-oriented Training leaf.
  trainingRelevant?: boolean;
  // The server-resolved relevance bitset (issue #1042) gating entries flagged
  // with a `relevanceKey` (Cycle/Sleep/Progress/Wellness in nav; the
  // Vision/Dental bits gate the /records specialty sections). Defaults all-true
  // so a caller that doesn't thread it never over-hides.
  relevance?: NavRelevance;
  // Integrations needing attention + unresolved import duplicates (Data →
  // Review). Badges the Data entry (issue #1801) — it used to badge the profile
  // menu, which was never where that number lived. Resolved server-side.
  reviewCount?: number;
}) {
  const badges: NavBadges = { review: reviewCount };
  const visible = entries.filter((e) =>
    isGroup(e)
      ? true
      : isNavLeafVisible(e, {
          isAdmin,
          adultContentAvailable,
          multiProfile,
          foodLoggingRelevant,
          hasIntakeItems,
          trainingRelevant,
          relevance,
          adultOnlyHrefs: ADULT_ONLY_HREFS,
        })
  );
  return (
    <nav className="flex flex-col gap-0.5">
      {visible.map((e) =>
        isGroup(e) ? (
          <NavGroup
            key={e.group}
            group={e}
            inDrawer={inDrawer}
            adultContentAvailable={adultContentAvailable}
            isAdmin={isAdmin}
            multiProfile={multiProfile}
            foodLoggingRelevant={foodLoggingRelevant}
            hasIntakeItems={hasIntakeItems}
            trainingRelevant={trainingRelevant}
            relevance={relevance}
            badges={badges}
          />
        ) : (
          <NavLink key={e.href} leaf={e} nested={false} badges={badges} />
        )
      )}
    </nav>
  );
}
