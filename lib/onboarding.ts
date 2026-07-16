import type { DashboardLayout } from "./dashboard-widgets";
import type { AppRoute } from "./hrefs";
import type { NotifySchedule } from "./settings/notifications";

// Versioned per-profile onboarding state (#719). Only profiles explicitly born
// into this flow carry the setting; missing/unknown versions are treated as legacy
// profiles and never replay onboarding after an upgrade.
export const ONBOARDING_VERSION = 1 as const;

export const ONBOARDING_FOCUSES = [
  "medical-records",
  "medications",
  "fitness",
  "metrics-labs",
  "preventive-care",
  "caregiving",
  "explore",
] as const;

export type OnboardingFocus = (typeof ONBOARDING_FOCUSES)[number];
export type OnboardingStatus = "not_started" | "in_progress" | "complete";
export type OnboardingProfilePath = "self" | "caregiving";
export type OnboardingStep = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export const ONBOARDING_STEP_COUNT = 7;

export const ONBOARDING_NOTIFICATION_INTENTS = [
  "safety-only",
  "daily-essentials",
  "essentials-upcoming",
  "none",
  "later",
] as const;
export type OnboardingNotificationIntent =
  (typeof ONBOARDING_NOTIFICATION_INTENTS)[number];

export interface OnboardingNotificationIntentDef {
  id: OnboardingNotificationIntent;
  label: string;
  description: string;
  preview: string;
}

export const ONBOARDING_NOTIFICATION_INTENT_DEFS: readonly OnboardingNotificationIntentDef[] =
  [
    {
      id: "safety-only",
      label: "Safety only",
      description: "Time-sensitive dose reminders and missed-dose escalation.",
      preview:
        "Example: Evening medication is due now. Escalation remains separate from dismissible coaching and care suggestions.",
    },
    {
      id: "daily-essentials",
      label: "Daily guidance",
      description:
        "Medication safety reminders, workout reminders on your training schedule, and one morning summary.",
      preview:
        "Example: Good morning — 2 scheduled doses and today's workout need attention.",
    },
    {
      id: "essentials-upcoming",
      label: "Daily guidance + upcoming care",
      description:
        "Everything in Daily guidance, plus advance reminders for appointments and preventive care.",
      preview:
        "Example: Your annual visit is next week. Review the appointment details when convenient.",
    },
    {
      id: "none",
      label: "No notifications",
      description:
        "Keep all reminder types off, including if you connect a delivery channel later.",
      preview:
        "Nothing will be proposed for delivery. Needs attention and Upcoming remain available in the app.",
    },
    {
      id: "later",
      label: "Decide later",
      description: "Skip this optional step and return from Profile settings.",
      preview:
        "No delivery changes are made. You can review channels and schedules when you are ready.",
    },
  ];

export interface OnboardingState {
  version: typeof ONBOARDING_VERSION;
  status: OnboardingStatus;
  profilePath: OnboardingProfilePath | null;
  focuses: OnboardingFocus[];
  basicsComplete: boolean;
  dataReviewed: boolean;
  layoutReviewed: boolean;
  notificationIntent: OnboardingNotificationIntent | null;
  notificationsReviewed: boolean;
  checklistDismissed: boolean;
  startedAt: string | null;
  completedAt: string | null;
}

export interface OnboardingFocusDef {
  id: OnboardingFocus;
  label: string;
  description: string;
  actionLabel: string;
  actionHref: AppRoute;
}

export const ONBOARDING_FOCUS_DEFS: readonly OnboardingFocusDef[] = [
  {
    id: "medical-records",
    label: "Organize medical records",
    description: "Import a portal export, PDF, scan, or photo and review it.",
    actionLabel: "Import a health record",
    actionHref: "/data?section=import",
  },
  {
    id: "medications",
    label: "Manage medications and supplements",
    description: "Add one current item and see its schedule on the dashboard.",
    actionLabel: "Add a medication or supplement",
    actionHref: "/medicine",
  },
  {
    id: "fitness",
    label: "Track fitness and training",
    description: "Log a recent session and build useful history over time.",
    actionLabel: "Log a recent workout",
    actionHref: "/training?tab=log",
  },
  {
    id: "metrics-labs",
    label: "Monitor body metrics and labs",
    description: "Record a baseline metric or import a recent lab panel.",
    actionLabel: "Record a starting metric",
    actionHref: "/trends?tab=body",
  },
  {
    id: "preventive-care",
    label: "Stay ahead of appointments and preventive care",
    description: "Add the next visit or bring in an existing care summary.",
    actionLabel: "Add an appointment",
    actionHref: "/encounters",
  },
  {
    id: "caregiving",
    label: "Help care for a family member",
    description: "Set up or review the people this login can help manage.",
    actionLabel: "View the household",
    actionHref: "/household",
  },
  {
    id: "explore",
    label: "Explore everything",
    description: "Keep the broad dashboard and start with any useful record.",
    actionLabel: "Explore ways to add data",
    actionHref: "/data?section=import",
  },
] as const;

const FOCUS_SET = new Set<string>(ONBOARDING_FOCUSES);

export function initialOnboardingState(): OnboardingState {
  return {
    version: ONBOARDING_VERSION,
    status: "not_started",
    profilePath: null,
    focuses: [],
    basicsComplete: false,
    dataReviewed: false,
    layoutReviewed: false,
    notificationIntent: null,
    notificationsReviewed: false,
    checklistDismissed: false,
    startedAt: null,
    completedAt: null,
  };
}

export function parseOnboardingState(
  raw: string | null | undefined
): OnboardingState | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<OnboardingState>;
    if (value.version !== ONBOARDING_VERSION) return null;
    const status: OnboardingStatus =
      value.status === "in_progress" || value.status === "complete"
        ? value.status
        : "not_started";
    return {
      version: ONBOARDING_VERSION,
      status,
      profilePath:
        value.profilePath === "self" || value.profilePath === "caregiving"
          ? value.profilePath
          : null,
      focuses: normalizeOnboardingFocuses(
        Array.isArray(value.focuses) ? value.focuses : []
      ),
      basicsComplete: value.basicsComplete === true,
      dataReviewed: value.dataReviewed === true,
      layoutReviewed: value.layoutReviewed === true,
      notificationIntent: isOnboardingNotificationIntent(
        value.notificationIntent
      )
        ? value.notificationIntent
        : null,
      notificationsReviewed: value.notificationsReviewed === true,
      checklistDismissed: value.checklistDismissed === true,
      startedAt: typeof value.startedAt === "string" ? value.startedAt : null,
      completedAt:
        typeof value.completedAt === "string" ? value.completedAt : null,
    };
  } catch {
    return null;
  }
}

export function serializeOnboardingState(state: OnboardingState): string {
  return JSON.stringify(state);
}

// The wizard unlocks one page at a time from persisted state. A requested prior
// step stays reachable for editing; a forged/future step is clamped to the first
// incomplete page so URL navigation cannot bypass setup requirements.
export function nextOnboardingStep(
  state: OnboardingState,
  hasFirstValue: boolean
): OnboardingStep {
  if (!state.profilePath) return 1;
  if (state.focuses.length === 0) return 2;
  if (!state.basicsComplete) return 3;
  if (!state.dataReviewed && !hasFirstValue) return 4;
  if (!state.layoutReviewed) return 5;
  if (!state.notificationsReviewed) return 6;
  return 7;
}

export function resolveOnboardingStep(
  requested: string | string[] | undefined,
  state: OnboardingState,
  hasFirstValue: boolean
): OnboardingStep {
  const unlocked = nextOnboardingStep(state, hasFirstValue);
  const raw = Array.isArray(requested) ? requested[0] : requested;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > unlocked) {
    return unlocked;
  }
  return parsed as OnboardingStep;
}

// One or two focused outcomes. "Explore everything" is deliberately exclusive:
// combining it with a narrower choice would make the initial layout ambiguous.
export function normalizeOnboardingFocuses(
  values: readonly unknown[]
): OnboardingFocus[] {
  const focuses = [
    ...new Set(
      values.filter(
        (value): value is OnboardingFocus =>
          typeof value === "string" && FOCUS_SET.has(value)
      )
    ),
  ];
  if (focuses.includes("explore")) return ["explore"];
  return focuses.slice(0, 2);
}

export function onboardingWithFocuses(
  state: OnboardingState,
  focuses: readonly unknown[],
  now: string
): OnboardingState {
  return {
    ...state,
    status: "in_progress",
    focuses: normalizeOnboardingFocuses(focuses),
    dataReviewed: false,
    layoutReviewed: false,
    startedAt: state.startedAt ?? now,
    completedAt: null,
  };
}

export function onboardingWithProfilePath(
  state: OnboardingState,
  profilePath: OnboardingProfilePath,
  now: string
): OnboardingState {
  return {
    ...state,
    status: "in_progress",
    profilePath,
    startedAt: state.startedAt ?? now,
    completedAt: null,
  };
}

export function onboardingDeferred(
  state: OnboardingState,
  now: string
): OnboardingState {
  return {
    ...state,
    status: "in_progress",
    startedAt: state.startedAt ?? now,
    completedAt: null,
  };
}

export function onboardingWithBasics(
  state: OnboardingState,
  now: string
): OnboardingState {
  return {
    ...state,
    status: "in_progress",
    basicsComplete: true,
    startedAt: state.startedAt ?? now,
    completedAt: null,
  };
}

export function onboardingWithDataReviewed(
  state: OnboardingState,
  now: string
): OnboardingState {
  return {
    ...state,
    status: "in_progress",
    dataReviewed: true,
    startedAt: state.startedAt ?? now,
    completedAt: null,
  };
}

export function onboardingWithLayout(
  state: OnboardingState,
  now: string
): OnboardingState {
  return {
    ...state,
    status: "in_progress",
    layoutReviewed: true,
    startedAt: state.startedAt ?? now,
    completedAt: null,
  };
}

const NOTIFICATION_INTENT_SET = new Set<string>(
  ONBOARDING_NOTIFICATION_INTENTS
);

export function isOnboardingNotificationIntent(
  value: unknown
): value is OnboardingNotificationIntent {
  return typeof value === "string" && NOTIFICATION_INTENT_SET.has(value);
}

// Step 6 stores a real notification schedule preference while leaving delivery
// channels untouched. Enabling Telegram, Web Push, or Home Assistant later uses
// this schedule; choosing "Decide later" preserves whatever is already set.
export function onboardingNotificationSchedule(
  intent: OnboardingNotificationIntent,
  current: NotifySchedule
): NotifySchedule {
  if (intent === "later") return current;

  const noSummary = {
    digestHour: null,
    weeklyRecapDay: null,
    weeklyRecapHour: current.weeklyRecapHour,
  };
  if (intent === "none") {
    return {
      ...current,
      supplementHours: {
        Morning: null,
        Midday: null,
        Evening: null,
        Bedtime: null,
      },
      workoutEnabled: false,
      ...noSummary,
      milestonesEnabled: false,
      preventiveEnabled: false,
    };
  }
  if (intent === "safety-only") {
    return {
      ...current,
      workoutEnabled: false,
      ...noSummary,
      milestonesEnabled: false,
      preventiveEnabled: false,
    };
  }

  return {
    ...current,
    workoutEnabled: true,
    digestHour: current.digestHour ?? 8,
    milestonesEnabled: true,
    preventiveEnabled: intent === "essentials-upcoming",
  };
}

export function onboardingWithNotificationIntent(
  state: OnboardingState,
  intent: OnboardingNotificationIntent,
  now: string
): OnboardingState {
  return {
    ...state,
    status: "in_progress",
    notificationIntent: intent,
    notificationsReviewed: true,
    startedAt: state.startedAt ?? now,
    completedAt: null,
  };
}

export function completeOnboardingState(
  state: OnboardingState,
  now: string
): OnboardingState {
  return {
    ...state,
    status: "complete",
    startedAt: state.startedAt ?? now,
    completedAt: now,
  };
}

export function onboardingNeedsSetup(
  state: OnboardingState | null
): state is OnboardingState {
  return state !== null && state.status !== "complete";
}

export function onboardingFocusDef(focus: OnboardingFocus): OnboardingFocusDef {
  return ONBOARDING_FOCUS_DEFS.find((item) => item.id === focus)!;
}

export interface OnboardingDataPresence {
  medicalRecords: boolean;
  medications: boolean;
  fitness: boolean;
  metricsLabs: boolean;
  preventiveCare: boolean;
  caregiving: boolean;
}

export interface OnboardingChecklistCompletion extends OnboardingDataPresence {
  emergency: boolean;
  notifications: boolean;
  connectedDataSource: boolean;
}

export type OnboardingChecklistSuggestion = OnboardingFocus | "notifications";

export function remainingOnboardingChecklistSuggestions(
  focuses: readonly OnboardingFocus[],
  completion: OnboardingChecklistCompletion
): OnboardingChecklistSuggestion[] {
  const remaining = focuses.filter((focus) => {
    if (focus === "explore") return !completion.emergency;
    if (focus === "fitness") return !completion.connectedDataSource;
    return !focusHasFirstValue(focus, completion);
  });

  if (!focuses.includes("explore") && !completion.emergency) {
    remaining.push("explore");
  }

  return completion.notifications ? remaining : [...remaining, "notifications"];
}

export function focusHasFirstValue(
  focus: OnboardingFocus,
  presence: OnboardingDataPresence
): boolean {
  switch (focus) {
    case "medical-records":
      return presence.medicalRecords;
    case "medications":
      return presence.medications;
    case "fitness":
      return presence.fitness;
    case "metrics-labs":
      return presence.metricsLabs;
    case "preventive-care":
      return presence.preventiveCare;
    case "caregiving":
      return presence.caregiving;
    case "explore":
      return Object.values(presence).some(Boolean);
  }
}

export function hasOnboardingFirstValue(
  focuses: readonly OnboardingFocus[],
  presence: OnboardingDataPresence
): boolean {
  return focuses.some((focus) => focusHasFirstValue(focus, presence));
}

// Outcome selection seeds the dashboard without permanently disabling anything:
// Customize can restore every hidden widget later. Needs attention is pinned and
// therefore absent from this saved layout by design.
const FOCUS_WIDGETS: Record<OnboardingFocus, readonly string[]> = {
  "medical-records": ["recent-labs", "next-appointment", "healthspan-pillars"],
  medications: ["recent-labs", "coaching-observations"],
  fitness: ["coaching", "goals-habits", "weight-trend", "weekly-recap"],
  "metrics-labs": ["weight-trend", "recent-labs", "healthspan-pillars"],
  "preventive-care": ["next-appointment", "recent-labs"],
  caregiving: ["next-appointment", "recent-labs"],
  explore: [
    "recent-labs",
    "next-appointment",
    "coaching",
    "coaching-observations",
    "healthspan-pillars",
    "weight-trend",
    "goals-habits",
  ],
};

const ONBOARDING_WIDGET_ORDER = [
  "recent-labs",
  "next-appointment",
  "coaching",
  "coaching-observations",
  "healthspan-pillars",
  "weight-trend",
  "goals-habits",
  "weekly-recap",
];

export function onboardingDashboardLayout(
  focuses: readonly OnboardingFocus[]
): DashboardLayout {
  const normalized = normalizeOnboardingFocuses(focuses);
  const visible = new Set(
    normalized.flatMap((focus) => [...FOCUS_WIDGETS[focus]])
  );
  return {
    order: ONBOARDING_WIDGET_ORDER.filter((id) => visible.has(id)).concat(
      ONBOARDING_WIDGET_ORDER.filter((id) => !visible.has(id))
    ),
    hidden: ONBOARDING_WIDGET_ORDER.filter((id) => !visible.has(id)),
  };
}
