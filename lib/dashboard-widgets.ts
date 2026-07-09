// Dashboard widget registry (issue #156) — PURE data + merge logic, no JSX and no
// DB, so it's importable by both the server page and the client grid and fully
// unit-tested. The catalog is the source of truth for which widgets exist, their
// default order (array index), whether they're fitness-gated (hidden for
// age-restricted profiles), whether they're on by default, and their grid span.
// The per-profile customization (order + hidden ids) is stored elsewhere
// (lib/settings.ts) as a DashboardLayout blob and merged against this catalog by
// the resolve* functions here, so a stored layout survives the catalog gaining or
// losing widgets between releases.

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
export const DASHBOARD_WIDGETS: WidgetDef[] = [
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
    id: "today-actions",
    label: "Today's actions",
    description: "Doses and goals on deck, yesterday's recap, and what's new.",
    defaultOn: true,
    fitness: false,
    span: "half",
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
    id: "weight-trend",
    label: "Weight trend",
    description: "Your recent body-weight chart.",
    defaultOn: true,
    fitness: false,
    span: "two-thirds",
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
    id: "immunizations",
    label: "Immunizations",
    description: "Next-due and overdue vaccines against the schedule.",
    defaultOn: true,
    fitness: false,
    span: "full",
  },
  {
    id: "recent-activity",
    label: "Recent activity",
    description: "Your most recently logged workouts.",
    defaultOn: true,
    fitness: true,
    span: "half",
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
    id: "coaching",
    label: "Coaching",
    description:
      "One focused suggestion — train or rest — from your routine and recovery.",
    defaultOn: true,
    fitness: true,
    span: "third",
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
    id: "low-supply",
    label: "Low supply",
    description: "Supplements and medications running low on refills.",
    defaultOn: false,
    fitness: false,
    span: "half",
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

// The widgets a profile is eligible to see, in registry order: everything except
// fitness widgets when the profile is age-restricted.
function eligibleWidgets(restricted: boolean): WidgetDef[] {
  return DASHBOARD_WIDGETS.filter((w) => !(restricted && w.fitness));
}

// Every eligible widget (visible + hidden) in display order, for the customize
// UI. Algorithm: take the stored order filtered to ids still in the (eligible)
// registry, then append any eligible registry ids not already present in registry
// index order — so a new release's widgets appear automatically. A widget the
// stored layout has never seen (neither in `order` nor `hidden`) falls back to
// its `defaultOn`; a known widget is visible iff it's not in `hidden`.
export function resolveWidgetList(
  layout: DashboardLayout | null,
  restricted: boolean
): { def: WidgetDef; visible: boolean }[] {
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
    return { def, visible };
  });
}

// The visible widgets a profile should render, in display order.
export function resolveWidgets(
  layout: DashboardLayout | null,
  restricted: boolean
): WidgetDef[] {
  return resolveWidgetList(layout, restricted)
    .filter((w) => w.visible)
    .map((w) => w.def);
}
