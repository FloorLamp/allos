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

// The dashboard shows only a compact weekly-habit subset. Rank the WHOLE open
// set before applying the limit so creation order cannot hide a less-complete
// habit behind one that is nearly done. Kept pure for direct regression coverage.
export interface DashboardHabitProgress {
  count: number;
  per_week: number;
  met: boolean;
}

export function summarizeDashboardHabits<T extends DashboardHabitProgress>(
  targets: readonly T[],
  limit = 4
): {
  open: T[];
  shown: T[];
  hidden: T[];
  completedCount: number;
  hiddenOpenCount: number;
} {
  const open = targets
    .map((target, index) => ({ target, index }))
    .filter(({ target }) => !target.met)
    .sort(
      (a, b) =>
        a.target.count / Math.max(1, a.target.per_week) -
          b.target.count / Math.max(1, b.target.per_week) || a.index - b.index
    )
    .map(({ target }) => target);
  const shown = open.slice(0, Math.max(0, Math.trunc(limit)));
  const hidden = open.slice(shown.length);
  return {
    open,
    shown,
    hidden,
    completedCount: targets.length - open.length,
    hiddenOpenCount: hidden.length,
  };
}

// The combined card splits only when both domains are present. A lone section
// should use the full card width instead of leaving an empty desktop column.
export function dashboardGoalsHabitsLayout(
  hasGoals: boolean,
  hasHabits: boolean
): "split" | "full" {
  return hasGoals && hasHabits ? "split" : "full";
}

// The catalog. Array order is the default display order; new widgets appended to
// the end appear automatically for existing profiles (see resolveWidgetList).
//
// The registry now contains only distinct overview questions. Signals already
// represented by Needs attention / Upcoming (low supply, immunizations, care plan),
// or by a richer sibling widget (quick stats, bio age, recent activity, streak),
// do not get a second dashboard surface. Legacy layout ids are filtered safely by
// resolveWidgetList.
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
    span: "half",
    dataAware: true,
  },
  {
    id: "next-appointment",
    label: "Next appointment",
    description: "Your soonest scheduled medical visit.",
    defaultOn: true,
    fitness: false,
    span: "half",
  },
  {
    id: "coaching",
    label: "Coaching",
    description:
      "One focused suggestion — train or rest — from your routine and recovery.",
    defaultOn: true,
    fitness: true,
    span: "half",
  },
  {
    id: "coaching-observations",
    label: "Coaching observations",
    description:
      "A calm rollup of the observational patterns that otherwise live only on their own tabs — training plateaus/balance, weight-log hygiene, off-pace goals, and adherence patterns. FYIs, not alerts; dismiss any and it's silenced everywhere.",
    // On by default so the tab-only findings gain dashboard REACH (issue #449) —
    // discoverable without becoming pushy. Not fitness-gated: it spans body-metric
    // hygiene and medication adherence too, which matter for a restricted profile.
    // Not data-aware: it self-hides (renders nothing) when no observation is firing,
    // so an empty state would be noise rather than an onboarding CTA.
    defaultOn: true,
    fitness: false,
    span: "half",
  },
  {
    id: "data-quality",
    label: "Data quality",
    description:
      "Structural gaps that quietly hold engines back — a missing birthdate, unset sex, unconfirmed medication codes, a failed document — ranked by how many features each fix unlocks. One-time fixes, not nagging; self-hides when there are none.",
    // On by default so the highest-leverage fixes are discoverable — but it self-hides
    // (renders nothing) when a profile has no structural gaps (the absent-pillar rule),
    // so it's silent for a complete profile. Not fitness-gated (birthdate/sex/doc gaps
    // matter for every profile, kids especially). Not data-aware: an empty state would
    // be noise, not an onboarding CTA — a complete profile should see NOTHING.
    defaultOn: true,
    fitness: false,
    span: "half",
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
    span: "half",
    dataAware: true,
  },
  {
    id: "weight-trend",
    label: "Weight trend",
    description: "Your recent body-weight chart.",
    defaultOn: true,
    fitness: false,
    span: "half",
    dataAware: true,
  },
  {
    id: "sleep-last-night",
    label: "Last night's sleep",
    description:
      "How you slept last night — duration, bed/wake, and your regularity — at a glance, linking to the full Sleep page.",
    // On by default so the morning ritual is served by promotion, not nav position
    // (issue #1066 — the illness-hero / weight-quick-add principle). Data-aware: a
    // profile with no sleep sessions yet gets an onboarding CTA instead of a blank
    // card. Not fitness-gated — sleep matters for every profile.
    defaultOn: true,
    fitness: false,
    span: "half",
    dataAware: true,
  },
  {
    id: "quick-log-prn",
    label: "Log a PRN dose",
    description:
      "One-tap logging for your as-needed medications — now, or a retro time (30m/1h ago, or a specific time). Records each real administration, not just one per day.",
    // On by default so the retro-entry home is discoverable. Data-aware: a profile
    // with no active PRN medications gets an onboarding CTA instead of a blank card.
    // Not fitness-gated — PRN meds matter for a restricted/child profile too.
    defaultOn: true,
    fitness: false,
    span: "half",
    dataAware: true,
  },
  {
    id: "goals-habits",
    label: "Goals and habits",
    description:
      "Progress toward active goals and this week's recurring targets in one place.",
    defaultOn: true,
    fitness: true,
    span: "full",
  },
  {
    id: "symptom-log",
    label: "How are you today?",
    description:
      "The daily check-in — a one-tap mood log (expand for energy, calm, and factors) plus the illness front door: a quiet \"Not feeling well?\" branch when you're well, deferring to the illness cockpit while you're unwell. Hide it from Customize if you never want it.",
    // On by default. The unified daily check-in shell (issue #992) composing the mood
    // tap with the #843 illness front door — two engines, one card, contracts kept
    // separate (mood is never flagged/escalated; illness keeps its episode machinery).
    // The id stays `symptom-log` so stored layouts survive the rename. Not
    // fitness-gated: mood and symptoms matter for every profile. Hideable like any
    // other widget.
    defaultOn: true,
    fitness: false,
    span: "half",
  },
  {
    id: "active-protocols",
    label: "Active protocols",
    description:
      "Your ongoing N-of-1 experiments — days elapsed, this week's practice adherence, and whether the primary outcome has moved since you started. Off by default; opt in from Customize.",
    // Off by default (issue #660): protocols are a power-user surface, opt in from
    // Customize. Not fitness-gated — an intervention can target any metric. Self-
    // hides (page gates `available`) when no protocol is ongoing, so an enabled-but-
    // empty widget leaves no blank card rather than showing an onboarding CTA.
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
  // The former `sick-household` widget was FOLDED into the illness hero (issue #858):
  // every accessible open episode now renders at hero altitude (a full cockpit for the
  // acting profile, a compact accordion line for household members), so a second widget
  // saying the same thing was a drift seam. A stored layout that still names
  // `sick-household` in its order/hidden lists is dropped by resolveWidgetList's
  // defensive merge (unknown ids are filtered — see the registry test), so old layouts
  // stay valid without a migration (#203-adjacent cleanup).
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
export function customizableWidgetDefs(restricted: boolean): WidgetDef[] {
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
  const eligible = customizableWidgetDefs(restricted);
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
