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
//
// The DEFAULT ORDER is actionable-first (issue #1890): every card you are meant to
// ACT on today comes before every card you merely read. That is an owner principle,
// not a one-time reshuffle — each widget declares `actionable` below and the registry
// test enforces the ordering, so widget #18 can't quietly land a glance card above
// the daily check-in. A deliberate violation needs a NAMED exception in that test.

import { DATA_QUALITY_PREFIX } from "./data-quality";
import type { ReorderStrategy } from "./drag-order";

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
  // Does this card exist to be ACTED on today (issue #1890)? True for a card whose
  // body carries a decision to make or a log/fix affordance meant to be tapped —
  // the daily check-in, the train/rest call, this week's targets, a one-time
  // structural fix, today's gap against a goal. False for a GLANCE card that reports
  // a value and expects you to read it and move on.
  //
  // THE LINE FOR A DATA-AWARE CARD (owner ruling on #1890, after #1892): an
  // ONBOARDING-ONLY CTA does not make a card actionable — it is a setup step that
  // exists only until the domain has data, and it says nothing about what the card
  // offers thereafter. A LOG AFFORDANCE PRESENT IN THE POPULATED STATE does: the
  // person who already opens that card every week is offered the write from there.
  // That is why Latest vitals (its "Log reading" action survives the first reading)
  // and Cycle phase (the live `cycleControlState` verb) are actionable, while Recent
  // labs and Weight trend — whose CTAs are pure onboarding — are not. An earlier
  // wording of this rule ("a data-aware CTA never makes a glance card actionable")
  // was written when the empty state was the only place such a CTA existed; it did
  // not survive #1892 and was replaced rather than exempted.
  //
  // Declared exactly ONCE here: nothing anywhere else re-derives "is this card
  // actionable" (#221). The default order is actionable-first, and the registry test
  // enforces it.
  actionable: boolean;
  span: WidgetSpan;
  // Pinned above the customizable grid, non-hideable, always first (the hero).
  // Excluded from every resolve* output — it's rendered directly by the page.
  pinned?: boolean;
  // Renders an onboarding CTA (not a blank card) when its domain has no data yet.
  // The page decides emptiness and passes it to resolveWidgetList.
  dataAware?: boolean;
  // Hidden for an INFANT profile (< 1 y) — the nav's `requiresFoodLogging` gate
  // (issue #591) applied to the dashboard: a food-logging widget that's meaningless
  // for a milk-only infant is dropped from the grid AND from Customize, exactly like
  // the Nutrition nav entry. The page resolves the bit (isFoodLoggingRelevant) and
  // passes it via the WidgetGate.
  requiresFoodLogging?: boolean;
  // Hidden when the named nav-relevance bit is false for the active profile — the
  // #1042 `relevanceKey` gate applied to the dashboard. Only "cycle" is used today
  // (the Cycle-phase card, gated on the SAME bit as the Cycle nav entry, so the card
  // and the nav entry can never disagree about whether cycle tracking is relevant).
  relevanceKey?: "cycle";
}

// The per-profile eligibility gate the page resolves from DB state and threads into
// the resolve* functions — the dashboard twin of the nav's per-entry gating
// (`requiresFoodLogging` #591, the `relevanceKey` bitset #1042). All-optional with an
// all-eligible default (matching the nav's DEFAULT_NAV_RELEVANCE posture), so a caller
// that doesn't thread a bit never over-hides.
export interface WidgetGate {
  // isFoodLoggingRelevant(age) — false only for a KNOWN infant profile; gates
  // `requiresFoodLogging` widgets.
  foodLogging?: boolean;
  // The nav-relevance `cycle` bit; gates `relevanceKey === "cycle"` widgets.
  cycle?: boolean;
}

// Per-profile customization. `order` is the display order of widget ids; `hidden`
// is the set of ids the user has toggled off. Both are merged defensively against
// the registry, so unknown/removed ids never corrupt the resolved layout.
export interface DashboardLayout {
  order: string[];
  hidden: string[];
}

// ── Finding families with a dedicated dashboard home (#1533) ───────────────────
// The Coaching-observations rollup's charter (#449) is dashboard REACH for findings
// that otherwise render only on their own tabs. A finding family that has earned its
// OWN dashboard widget already has that reach, so by the rollup's own charter it does
// not belong in the rollup — but collectCoachingFindings produces one set, so without
// this the same gap rendered in both cards and inflated the rollup's "N patterns"
// count with rows it was double-showing.
//
// This registry encodes the charter as data: dedupeKey PREFIX → the widget id that is
// that family's dedicated dashboard home. The split below is then self-maintaining —
// when the next finding family earns its own widget, adding one line here stops the
// duplication, and hiding that widget puts the family straight back into the rollup
// (the catch-all), so a hidden card never silently drops dashboard reach.
//
// NOT a suppression mechanism: both cards still read the ONE collectCoachingFindings
// computation and share the findings bus, so a dismiss anywhere still silences
// everywhere (including the origin tab), and the Coaching TAB still shows everything.
export const FINDING_DASHBOARD_HOME: Record<string, string> = {
  // Structural data-quality gaps (#1045) → the Data quality widget.
  [DATA_QUALITY_PREFIX]: "data-quality",
};

// The widget id that is this finding's dedicated dashboard home, or null when the
// family has none (the common case — those are exactly the rollup's constituency).
export function findingDashboardHome(dedupeKey: string): string | null {
  for (const [prefix, widgetId] of Object.entries(FINDING_DASHBOARD_HOME)) {
    if (dedupeKey.startsWith(prefix)) return widgetId;
  }
  return null;
}

// The rollup's rendered set: every active coaching finding whose family has no
// dedicated dashboard home, plus those whose home widget is currently hidden. The
// caller passes a VISIBILITY predicate — "is this widget actually on the person's
// dashboard right now?", i.e. the resolved item's `visible` flag, not mere catalog
// eligibility (the page resolves hidden widgets too, so Customize can preview them).
// Callers MUST derive the widget's count and its cap/overflow from this result, not
// from the unfiltered input — the count has to equal what is on screen.
export function rollupCoachingFindings<T extends { dedupeKey: string }>(
  findings: readonly T[],
  isWidgetVisible: (widgetId: string) => boolean
): T[] {
  return findings.filter((f) => {
    const home = findingDashboardHome(f.dedupeKey);
    return home === null || !isWidgetVisible(home);
  });
}

// The slice a dedicated home widget renders: the findings whose family is homed to it.
export function findingsForDashboardHome<T extends { dedupeKey: string }>(
  findings: readonly T[],
  widgetId: string
): T[] {
  return findings.filter((f) => findingDashboardHome(f.dedupeKey) === widgetId);
}

// ── Dashboard list caps (#1219) ────────────────────────────────────────────────
// Every capped list widget splits through ONE pure helper and surfaces its
// overflow (a disclosure of the remaining rows, or a "+N more" link) — a widget
// that shows "N of M" must also offer a path to the hidden M−N. The caps are
// named here so the widgets and the pure test agree on the policy.

// Coaching observations rollup: top 2 (the calm dashboard slice, #449).
export const COACHING_OBSERVATIONS_CAP = 2;
// Data-quality gaps widget: top 3 by leverage (#1045).
export const DATA_QUALITY_GAPS_CAP = 3;
// Active protocols: 3 rows, the standard list-widget footprint (#660/#1219).
export const ACTIVE_PROTOCOLS_CAP = 3;

// Split a list into the capped visible slice and its overflow. Pure; order kept.
export function capDashboardList<T>(
  items: readonly T[],
  cap: number
): { shown: T[]; overflow: T[] } {
  const n = Math.max(0, Math.trunc(cap));
  return { shown: items.slice(0, n), overflow: items.slice(n) };
}

// Actionable protocol rows can never disappear behind the compact widget cap
// (#1584). Render every row with a pending log action, then use any remaining
// standard-cap slots for informational protocols. Overflow therefore contains
// informational rows only.
export function capActionableDashboardList<T>(
  items: readonly T[],
  cap: number,
  isActionable: (item: T) => boolean
): { shown: T[]; overflow: T[] } {
  const actionable = items.filter(isActionable);
  const informational = items.filter((item) => !isActionable(item));
  const informationalSlots = Math.max(0, Math.trunc(cap) - actionable.length);
  return {
    shown: [...actionable, ...informational.slice(0, informationalSlots)],
    overflow: informational.slice(informationalSlots),
  };
}

// The dashboard shows only a compact weekly-habit subset. Rank the WHOLE open
// set before applying the limit so creation order cannot hide a less-complete
// habit behind one that is nearly done. Kept pure for direct regression coverage.
export interface DashboardHabitProgress {
  count: number;
  per_week: number;
  met: boolean;
}

export type DashboardHabitDomain = "training" | "food" | "practice";

// The combined habits card spans three owning surfaces. Keep this classification
// shared so a practice can never inherit the old "anything non-food is training"
// fallback and point at the wrong editor.
export function dashboardHabitDomain(scopeKind: string): DashboardHabitDomain {
  if (scopeKind === "food_group") return "food";
  if (scopeKind === "practice") return "practice";
  return "training";
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

// How Customize presents itself at a given viewport (issue #1891). ONE question —
// "is the grid multi-column here?" — with ONE answer, so the presentation and the
// drag strategy can never disagree about which layout the user is looking at.
//
//   • at `lg` and wider the grid really is six columns: the widgets keep their
//     spans and their neighbours, because on that canvas adjacency and footprint
//     are the things being edited, and a card is what you edit them ON. Items
//     reflow in two dimensions, so the rect strategy.
//   • below `lg` the grid is a SINGLE column already, and a full live widget is
//     half a phone screen. Reordering ten of them means dragging across several
//     screens with autoscroll — the worst version of a drag. So the editor
//     collapses each widget to a compact reorder row (grip, label, eye), which
//     puts the whole list on one screen and makes a reorder a flick. Nothing
//     moves sideways in one column, so the vertical strategy.
//
// This is a PRESENTATION of the same ordered set, not a second editor: the order
// and hidden-id state, the controls, and the save/cancel semantics are identical
// on both sides of the breakpoint.
export interface DashboardCustomizeMode {
  compact: boolean;
  strategy: ReorderStrategy;
}

export function dashboardCustomizeMode(wide: boolean): DashboardCustomizeMode {
  return wide
    ? { compact: false, strategy: "rect" }
    : { compact: true, strategy: "vertical" };
}

// The catalog. Array order is the default display order; new widgets appended to
// the end appear automatically for existing profiles (see resolveWidgetList).
//
// ORDER = ACTIONABLE FIRST (issue #1890). The cards that carry a tap which writes
// lead — the daily check-in, the train/rest call, this week's targets, the one-time
// structural fixes, today's gaps, then the two EPISODIC log cards (latest vitals,
// cycle phase) whose write is weekly or per-cycle rather than daily. The glance cards
// that only report a value follow, and the calm observational rollup closes the list
// per its own #449 charter. Every entry declares `actionable` and the registry test
// asserts the split, so the principle survives the next widget instead of decaying
// with it.
//
// The registry contains only distinct overview questions. Signals already
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
    // The hero is the most actionable surface in the app — every row is something
    // that needs doing. Pinned, so it sits outside the ordered grid regardless.
    actionable: true,
    span: "full",
    pinned: true,
  },
  // ── Actionable: cards that exist to be tapped today ──────────────────────────
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
    // FIRST in the grid (#1890): the single most actionable card on the board — it
    // exists to be tapped every day (mood, illness front door, PRN meds). It used to
    // sit second-to-last, several phone screens down.
    actionable: true,
    span: "half",
  },
  {
    id: "coaching",
    label: "Coaching",
    description:
      "One focused suggestion — train or rest — from your routine and recovery.",
    defaultOn: true,
    fitness: true,
    // Today's train/rest decision, with the action link on it.
    actionable: true,
    span: "half",
  },
  {
    id: "goals-habits",
    label: "Goals and habits",
    description:
      "Progress toward active goals and this week's recurring targets in one place.",
    defaultOn: true,
    fitness: true,
    // This week's targets, each row carrying its log affordance.
    actionable: true,
    span: "full",
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
    // Its rows carry pending log actions — that is exactly why they can never fall
    // behind the compact cap (#1584). Opt-in, but actionable once opted in, so it
    // slots inside the actionable band rather than after the glance cards.
    actionable: true,
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
    // Every row is a one-time fix with the fix one tap away. High placement costs a
    // complete profile nothing: the card renders nothing at all when there are no gaps.
    actionable: true,
    span: "half",
  },
  {
    id: "nutrition-today",
    label: "Nutrition today",
    description:
      "Today's protein against your goal band, with this week's daily average — the same figures the Nutrition → Food gauge shows.",
    // On by default so the nutrition domain (a top-level nav domain with zero
    // dashboard presence before #1221) is served by promotion. Data-aware: a profile
    // with no logged/tracked intake gets an onboarding CTA instead of a blank card.
    // Not fitness-gated — protein matters for every profile. requiresFoodLogging so it
    // drops for an infant profile, exactly like the Nutrition nav entry (#591).
    defaultOn: true,
    fitness: false,
    // Today's protein gap — a number you can still close today, from a card that
    // links straight to logging it.
    actionable: true,
    span: "half",
    dataAware: true,
    requiresFoodLogging: true,
  },
  {
    id: "steps-today",
    label: "Steps today",
    description:
      "Your step count today against your prior 7 days — surfaced from Trends → Overview → body census to the daily glance.",
    // On by default (promotion, #1066). Data-aware: a profile with no step data yet
    // gets a connect-a-source CTA. Not fitness-gated — steps matter for every profile.
    defaultOn: true,
    fitness: false,
    // Today's count against your own baseline, while the day is still open to change
    // it — the same "gap you can still close" shape as the nutrition card.
    actionable: true,
    span: "half",
  },
  // The two EPISODIC log cards close the actionable band: their write is real but its
  // cadence is a week or a cycle, not a day, so they sit below the today-shaped cards
  // above and above every card that offers no write at all.
  {
    id: "vitals-latest",
    label: "Latest vitals",
    description:
      "Your most recent blood pressure and resting heart rate, each with a trend arrow — surfaced from Trends → Vitals to the daily glance.",
    // On by default (promotion, #1066). Data-aware: a profile with no BP/resting-HR
    // reading gets a log-a-reading CTA. Not fitness-gated — vitals matter for every
    // profile.
    defaultOn: true,
    fitness: false,
    // ACTIONABLE by the owner's ruling on #1890, after #1892 kept the "Log reading"
    // action on the card in its POPULATED state — the whole point of that ask being
    // that the person who logs blood pressure weekly opens this card and previously
    // found no affordance on it. This entry used to carry the rule "a data-aware CTA
    // never makes a glance card actionable"; see the `actionable` field above for the
    // distinction that replaced it (onboarding-only CTA, no; populated-state log
    // affordance, yes). First of the two episodic log cards: ungated, and its
    // affordance is unconditional once data exists.
    actionable: true,
    span: "half",
    dataAware: true,
  },
  {
    id: "cycle-phase",
    label: "Cycle phase",
    description:
      "Your current cycle day and derived phase — informational only, never a prediction. Appears only when cycle tracking is relevant for the profile.",
    // On by default, but gated on the SAME `cycle` relevance bit as the Cycle nav
    // entry (relevanceKey), so it's hidden entirely unless cycle tracking applies to
    // the profile.
    //
    // DATA-AWARE since #1892. It used to SELF-HIDE when no phase was derivable, which
    // was the inversion: that is precisely the state of someone who has not logged day
    // 1, so the card vanished exactly when logging mattered most and the only path was
    // nav → Medical → Cycles. The #714 tracking-not-forecasting contract governs the
    // quiet DISPLAY; it never meant "never offer a log button". Its empty variant is
    // the same card carrying the one cycle offer, so the CTA is a WRITE, not a link.
    defaultOn: true,
    fitness: false,
    // ACTIONABLE by the owner's ruling on #1890: since #1892 the POPULATED card
    // renders `cycleControlState`'s live verb ("Period started today" / "Period ended
    // today" / "Still bleeding"), which is a tap that writes. #714 still governs the
    // DISPLAY — informational, never a prediction — and that is untouched: offering a
    // log button was never the thing that contract forbade. LAST in the actionable
    // band, because it is the weakest-reaching of the writes: relevance-gated, so most
    // profiles never see it, and its offer is deliberately silent between the reopen
    // and gap windows, so some days there is no button at all.
    actionable: true,
    span: "half",
    dataAware: true,
    relevanceKey: "cycle",
  },
  // ── Glance: cards that report a value ────────────────────────────────────────
  {
    id: "next-appointment",
    label: "Next appointment",
    description: "Your soonest scheduled medical visit.",
    defaultOn: true,
    fitness: false,
    // Passive: it tells you when the visit is. Anything about it that needs doing
    // arrives through the pinned hero and Upcoming.
    actionable: false,
    span: "half",
  },
  {
    id: "recent-labs",
    label: "Recent labs",
    description:
      "Your latest lab panel — flagged and recently-changed markers.",
    defaultOn: true,
    fitness: false,
    // Passive: a reading of results already in. Flagged values that need action reach
    // you through the hero.
    actionable: false,
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
    // Passive: last night already happened.
    actionable: false,
    span: "half",
    dataAware: true,
  },
  {
    id: "weight-trend",
    label: "Weight trend",
    description: "Your recent body-weight chart.",
    defaultOn: true,
    fitness: false,
    // Passive: a chart of what already happened.
    actionable: false,
    span: "half",
    dataAware: true,
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
    // Passive: four slow-moving signals to read, none of them a today action. Identity
    // argues for high placement and the principle argues for the glance tier; #1890
    // placed it here. If it is ever promoted back above the actionable band, it
    // becomes a NAMED exception in the registry test, not a silent reordering.
    actionable: false,
    span: "half",
    dataAware: true,
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
    // LAST among the on-by-default cards, by its own charter: "FYIs, not alerts".
    // A calm rollup that closes the list keeps its reach (#449) without spending a
    // prime slot; it used to sit fourth.
    actionable: false,
    span: "half",
  },
  {
    id: "weekly-recap",
    label: "Weekly recap",
    description:
      "Your last seven days — workouts, PRs, adherence, weight, and sleep regularity.",
    // Off by default so it stays quiet (issue #32); opt in from Customize.
    defaultOn: false,
    fitness: true,
    // Passive by construction: a retrospective. Stays last.
    actionable: false,
    span: "half",
  },
  // The former `quick-log-prn` widget (the standalone "Log a PRN dose" card, #797) was
  // FOLDED into the "How are you today?" check-in as its "Take any meds?" branch (issue
  // #1221): one check-in card now owns mood + illness + meds, which also removes the
  // split-brain where the standalone widget was availability-suppressed whenever the
  // illness cockpit (which embeds the same logger) was open. A stored layout that still
  // names `quick-log-prn` in its order/hidden lists is dropped by resolveWidgetList's
  // defensive merge (unknown ids are filtered — see the registry test), so old layouts
  // stay valid without a migration (the `sick-household` precedent below, #203-adjacent).
  //
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
// except pinned widgets (rendered separately), fitness widgets on an age-restricted
// profile, and per-`WidgetGate` entries whose gate bit is off for the profile
// (`requiresFoodLogging` on an infant, `relevanceKey` when the relevance bit is
// false) — the dashboard twin of the nav's per-entry gating. The gate defaults to
// all-eligible so a caller that doesn't thread it never over-hides.
export function customizableWidgetDefs(
  restricted: boolean,
  gate: WidgetGate = {}
): WidgetDef[] {
  const foodLogging = gate.foodLogging ?? true;
  const cycle = gate.cycle ?? true;
  return DASHBOARD_WIDGETS.filter(
    (w) =>
      !w.pinned &&
      !(restricted && w.fitness) &&
      !(w.requiresFoodLogging && !foodLogging) &&
      !(w.relevanceKey === "cycle" && !cycle)
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
  emptyIds: Set<string> = new Set(),
  gate: WidgetGate = {}
): ResolvedWidget[] {
  const eligible = customizableWidgetDefs(restricted, gate);
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
  emptyIds: Set<string> = new Set(),
  gate: WidgetGate = {}
): WidgetDef[] {
  return resolveWidgetList(layout, restricted, emptyIds, gate)
    .filter((w) => w.visible)
    .map((w) => w.def);
}
