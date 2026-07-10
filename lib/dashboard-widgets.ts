// Dashboard widget registry — PURE data + merge logic, no JSX and no
// DB, so it's importable by both the server page and the client grid and fully
// unit-tested. The catalog is the source of truth for which widgets exist, their
// default order (array index), whether they're fitness-gated (hidden for
// age-restricted profiles), whether they're on by default, and their grid span.
// The per-profile customization (order + hidden ids) is stored elsewhere
// (lib/settings.ts) as a DashboardLayout blob and merged against this catalog by
// the resolve* functions here, so a stored layout survives the catalog gaining or
// losing widgets between releases.
//
// TWO widgets are special (issue #171):
//   - `pinned` widgets (the "Needs attention" hero) live OUTSIDE the customizable
//     grid: they're never listed in Customize, never hideable, and always render
//     first. The catalog still carries the entry so the pin is a single source of
//     truth (and the registry test asserts it can't be hidden/reordered away).
//   - `dataAware` widgets show an onboarding CTA when their domain has no data yet,
//     extending the fitness/age gate from role-aware to data-aware. Emptiness never
//     hides the widget (that would bury the CTA that fills it) — it flips the
//     resolved item's `empty` flag so the page renders the CTA instead of a
//     blank card.

export type WidgetSpan = "full" | "two-thirds" | "third" | "half";

export interface WidgetDef {
  id: string;
  label: string;
  description: string;
  // On by default for a fresh profile (or a widget the stored layout has never
  // seen). Off-by-default widgets stay hidden until the user opts in.
  defaultOn: boolean;
  // Fitness-oriented: never rendered or listed for age-restricted profiles,
  // replacing the old per-card `!restricted` JSX guards.
  fitness: boolean;
  span: WidgetSpan;
  // Pinned above the customizable grid, non-hideable, always first (the hero).
  // Excluded from every resolve* output — it's rendered directly by the page.
  pinned?: boolean;
  // Renders an onboarding CTA (not a blank card) when its domain has no data yet.
  // The page decides emptiness and passes it to resolveWidgetList.
  dataAware?: boolean;
}

// Per-profile customization. `order` is the display order of widget ids; `hidden`
// is the set of ids the user has toggled off. Both are merged defensively against
// the registry, so unknown/removed ids never corrupt the resolved layout.
export interface DashboardLayout {
  order: string[];
  hidden: string[];
}

// The catalog. Array order is the default display order; new widgets appended to
// the end appear automatically for existing profiles (see resolveWidgetList).
//
// Order posture (issue #171): the medical differentiators (recent labs, next
// appointment, care plan) lead, the coaching next-workout recommendation is
// promoted near the top ("what should I do today" is core content — the promoted
// slot's suggestion quality is tightened separately in #185), and the vanity
// defaults (quick stats, streak) are demoted lower. Defaults are the product;
// customization is the valve.
export const DASHBOARD_WIDGETS: WidgetDef[] = [
  {
    id: "needs-attention",
    label: "Needs attention",
    description:
      "Everything that needs you today — doses, flagged labs, appointments, low supply, and more. Always shown, can't be hidden.",
    defaultOn: true,
    fitness: false,
    span: "full",
    pinned: true,
  },
  {
    id: "recent-labs",
    label: "Recent labs",
    description:
      "Your latest lab panel — flagged and recently-changed markers.",
    defaultOn: true,
    fitness: false,
    span: "two-thirds",
    dataAware: true,
  },
  {
    id: "next-appointment",
    label: "Next appointment",
    description: "Your soonest scheduled medical visit.",
    defaultOn: true,
    fitness: false,
    span: "third",
    dataAware: true,
  },
  {
    id: "care-plan-due",
    label: "Care plan",
    description: "Provider-ordered care items coming due.",
    defaultOn: true,
    fitness: false,
    span: "half",
    dataAware: true,
  },
  {
    id: "coaching",
    label: "Coaching",
    description:
      "One focused suggestion — train or rest — from your routine and recovery.",
    defaultOn: true,
    fitness: true,
    span: "third",
  },
  {
    id: "healthspan-pillars",
    label: "Healthspan pillars",
    description:
      "Evidence-backed longevity signals — VO₂ Max percentile, sleep regularity, biological age, and biomarkers in optimal range. Each pillar appears only when its data exists.",
    // On by default: the differentiator headline. Data-aware so a profile with no
    // pillar data yet gets an onboarding CTA instead of a blank card. Not fitness-
    // gated wholesale — individual pillars self-hide, and a child profile can still
    // show sleep/biomarker pillars.
    defaultOn: true,
    fitness: false,
    span: "full",
    dataAware: true,
  },
  {
    id: "starred-biomarkers",
    label: "Starred biomarkers",
    description: "Your pinned biomarkers with latest values and trends.",
    defaultOn: true,
    fitness: false,
    span: "full",
  },
  {
    id: "bio-age",
    label: "Biological age",
    description:
      "Your PhenoAge biological-age estimate and its gap to your calendar age.",
    // Off by default (issue #171 growth-valve): a specialized medical signal that
    // only lands for adults with a complete nine-analyte panel — opt in from
    // Customize. Data-aware so an incomplete panel shows an import CTA, not a blank.
    defaultOn: false,
    fitness: false,
    span: "third",
    dataAware: true,
  },
  {
    id: "weight-trend",
    label: "Weight trend",
    description: "Your recent body-weight chart.",
    defaultOn: true,
    fitness: false,
    span: "two-thirds",
    dataAware: true,
  },
  {
    id: "active-goals",
    label: "Active goals",
    description: "Progress toward your active goals.",
    defaultOn: true,
    fitness: true,
    span: "half",
  },
  {
    id: "weekly-routine",
    label: "Weekly routine",
    description: "This week's frequency targets and how you're tracking.",
    defaultOn: true,
    fitness: true,
    span: "full",
  },
  {
    id: "recent-activity",
    label: "Recent activity",
    description: "Your most recently logged workouts.",
    defaultOn: true,
    fitness: true,
    span: "half",
    dataAware: true,
  },
  {
    id: "immunizations",
    label: "Immunizations",
    description: "Next-due and overdue vaccines against the schedule.",
    defaultOn: true,
    fitness: false,
    span: "full",
  },
  {
    id: "todays-insight",
    label: "Today's insight",
    description: "The AI-generated summary for today.",
    defaultOn: true,
    fitness: true,
    span: "third",
  },
  {
    id: "quick-stats",
    label: "Quick stats",
    description:
      "Activities, weight, active goals, and supplements at a glance.",
    defaultOn: true,
    fitness: false,
    span: "full",
  },
  {
    id: "streak",
    label: "Activity streak",
    description: "Your current consecutive-day activity streak.",
    defaultOn: false,
    fitness: true,
    span: "third",
  },
  {
    id: "low-supply",
    label: "Low supply",
    description: "Supplements and medications running low on refills.",
    defaultOn: false,
    fitness: false,
    span: "half",
  },
  {
    id: "weekly-recap",
    label: "Weekly recap",
    description:
      "Your last seven days — workouts, volume, PRs, adherence, weight, and streak.",
    // Off by default so it stays quiet (issue #32); opt in from Customize.
    defaultOn: false,
    fitness: true,
    span: "half",
  },
];

const WIDGETS_BY_ID = new Map(DASHBOARD_WIDGETS.map((w) => [w.id, w]));

// The pinned widgets (the hero), in registry order — rendered directly by the page,
// above the customizable grid.
export function pinnedWidgets(): WidgetDef[] {
  return DASHBOARD_WIDGETS.filter((w) => w.pinned);
}

// A resolved customizable-widget entry: its def, whether it's currently visible,
// and whether it's data-aware-empty (render the onboarding CTA instead of content).
export interface ResolvedWidget {
  def: WidgetDef;
  visible: boolean;
  empty: boolean;
}

// The widgets a profile is eligible to customize, in registry order: everything
// except pinned widgets (rendered separately) and fitness widgets on an
// age-restricted profile.
function eligibleWidgets(restricted: boolean): WidgetDef[] {
  return DASHBOARD_WIDGETS.filter(
    (w) => !w.pinned && !(restricted && w.fitness)
  );
}

// Every eligible widget (visible + hidden) in display order, for the customize
// UI. Algorithm: take the stored order filtered to ids still in the (eligible)
// registry, then append any eligible registry ids not already present in registry
// index order — so a new release's widgets appear automatically. A widget the
// stored layout has never seen (neither in `order` nor `hidden`) falls back to
// its `defaultOn`; a known widget is visible iff it's not in `hidden`.
//
// `emptyIds` is the set of data-aware widget ids whose domain currently has no
// data; a data-aware widget in that set resolves with `empty: true` so the page
// renders its onboarding CTA. Emptiness never changes `visible`.
export function resolveWidgetList(
  layout: DashboardLayout | null,
  restricted: boolean,
  emptyIds: Set<string> = new Set()
): ResolvedWidget[] {
  const eligible = eligibleWidgets(restricted);
  const eligibleIds = new Set(eligible.map((w) => w.id));

  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const id of layout?.order ?? []) {
    if (eligibleIds.has(id) && !seen.has(id)) {
      ordered.push(id);
      seen.add(id);
    }
  }
  for (const w of eligible) {
    if (!seen.has(w.id)) {
      ordered.push(w.id);
      seen.add(w.id);
    }
  }

  const hidden = new Set(layout?.hidden ?? []);
  const known = new Set([...(layout?.order ?? []), ...(layout?.hidden ?? [])]);

  return ordered.map((id) => {
    const def = WIDGETS_BY_ID.get(id)!;
    const visible = layout && known.has(id) ? !hidden.has(id) : def.defaultOn;
    const empty = !!def.dataAware && emptyIds.has(id);
    return { def, visible, empty };
  });
}

// The visible widgets a profile should render, in display order.
export function resolveWidgets(
  layout: DashboardLayout | null,
  restricted: boolean,
  emptyIds: Set<string> = new Set()
): WidgetDef[] {
  return resolveWidgetList(layout, restricted, emptyIds)
    .filter((w) => w.visible)
    .map((w) => w.def);
}
