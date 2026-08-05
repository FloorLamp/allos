// The ONE registry of notification kinds (issue #1462 §6).
//
// The Notifications settings page used to enable each kind TWICE: a "Reminders &
// schedule" mega-card carried per-kind toggles and times (digest, recap, workout,
// milestones, preventive, food, mood) while a separate "Which messages reach me
// where" matrix repeated the same kinds as rows. Two systems, one question — the
// "one question, one computation" rule applied to notification kinds. This registry
// is that one computation: the settings UI renders ONE row per entry carrying the
// kind's enable, its kind-specific config, and its channel routing, and the delivery
// layer's per-channel gate reads the same list.
//
// The registry is PRESENTATION + CONFIG SHAPE only. It changes no delivery
// semantics: the safety kinds keep exactly the configurability they had (channel
// routing, with a warning — never a block — when every configured channel is off),
// and nothing that was un-configurable becomes configurable.
//
// Every kind in the `NotificationKind` union must be accounted for here: either it
// has a row (this registry) or it is deliberately non-configurable
// (NON_CONFIGURABLE_KINDS, each with the reason). lib/__tests__/notification-kinds.test.ts
// pins that partition, and pins that a kind actually DISPATCHED by lib/notifications
// can't be missing from the union — so a kind can't exist in dispatch but not the UI,
// or vice versa.

import type { NotificationKind } from "./types";

// Every value of the NotificationKind union, as data. The union is the type-level
// source of truth; this is its runtime shadow, and the reflection test fails if the
// two drift (a new union member that isn't listed here breaks the exhaustive
// `satisfies` check below).
export const ALL_NOTIFICATION_KINDS = [
  "dose",
  "redose",
  "escalation",
  "refill",
  "preventive",
  "illness-care",
  "followup",
  "workout",
  "workout-stale",
  "workout-recap",
  "ease-back",
  "food",
  "mood",
  "practice",
  "digest",
  "upcoming",
  "weekly-recap",
  "milestone",
  "prn-list",
  "symptom",
  "temp",
  "test",
  "other",
] as const satisfies readonly NotificationKind[];

// How a kind is enabled/configured at the PROFILE tier, and which
// saveNotificationPrefs form field carries it. `always` means the kind has no
// per-kind enable at all — it is governed by the thing that generates it (a dose
// schedule, a supply level), and only its channel routing is configurable.
export type KindControl =
  | { type: "always" }
  | { type: "toggle"; field: string }
  // A time control ("HH:MM" at minute grain, #2121) whose "Off" mode is the kind's
  // disable, optionally offering the wake-aware "Auto" sentinel (#1117).
  | { type: "time"; field: string; auto: boolean }
  // A weekday select (whose "Off" is the disable) plus a time control.
  | { type: "day-time"; dayField: string; timeField: string };

// An extra opt-in that belongs to a kind's MESSAGE rather than being a kind of its
// own — the morning digest's sleep section, the weekly recap's mood line. They render
// as sub-checkboxes inside their parent kind's row instead of floating free.
export type KindExtra = {
  field: string;
  label: string;
  testId: string;
};

export type NotificationKindEntry = {
  kind: NotificationKind;
  label: string;
  // ONE sentence (the copy standard, docs/internals/copy.md #945). Anything longer
  // belongs behind the row's "More" disclosure, not inline under the control.
  blurb: string;
  // Longer explanation, shown only when the row's "More" affordance is opened.
  more?: string;
  safety: boolean;
  control: KindControl;
  // A stable test id for the kind's own control. Set where a legacy id predates the
  // #1462 consolidation so the existing browser specs keep pointing at the same
  // element after the card moved; otherwise the generic `kind-*-<kind>` id applies.
  controlTestId?: string;
  extras?: readonly KindExtra[];
  // Hidden for a profile too young for food-group logging (the same predicate the
  // Food tab uses).
  requiresFoodLogging?: boolean;
};

export const NOTIFICATION_KIND_REGISTRY: readonly NotificationKindEntry[] = [
  {
    kind: "dose",
    label: "Dose reminders",
    blurb: "Sent at each schedule slot below for anything due then.",
    safety: true,
    control: { type: "always" },
    more: "Scheduled supplement and medication reminders follow each item's own schedule — turn an individual item off on its page, not here. Quiet hours never hold them.",
  },
  {
    kind: "escalation",
    label: "Missed-dose escalation",
    blurb: "A follow-up when a scheduled dose goes unconfirmed.",
    safety: true,
    control: { type: "always" },
    more: "A deliberately un-suppressible safety signal: dismissing the matching item elsewhere in the app never silences it, and quiet hours never hold it.",
  },
  {
    kind: "refill",
    label: "Refill nudges",
    blurb: "A heads-up when an item is running low.",
    safety: false,
    control: { type: "always" },
    more: "Driven by the on-hand quantity you record; dismissing the refill item on Upcoming silences this nudge too.",
  },
  {
    kind: "preventive",
    label: "Preventive care",
    blurb: "A nudge when a recommended checkup or screening comes due.",
    safety: false,
    control: { type: "toggle", field: "preventive_enabled" },
    controlTestId: "preventive-enabled",
    more: "Due items still appear on your Upcoming page when this is off.",
  },
  {
    kind: "workout",
    label: "Workout reminders",
    blurb:
      "Sent on the usual training schedule when behind on the weekly routine.",
    safety: false,
    control: { type: "toggle", field: "workout_enabled" },
  },
  {
    kind: "workout-stale",
    label: "Unfinished session nudge",
    blurb: "A gentle check when a workout draft has been left running.",
    safety: false,
    control: { type: "always" },
    more: "Sent once per unfinished session, with buttons to finish or discard it. Nothing is ever ended automatically.",
  },
  {
    kind: "workout-recap",
    label: "Post-workout recap",
    blurb: "A short summary line after a session is logged.",
    safety: false,
    control: { type: "always" },
  },
  {
    kind: "food",
    label: "Food-log nudges",
    blurb:
      "A nudge at your schedule slots with one-tap buttons for your most-eaten foods.",
    safety: false,
    control: { type: "toggle", field: "food_telegram_enabled" },
    controlTestId: "food-telegram-enabled",
    requiresFoodLogging: true,
    more: "Tapping a button logs a serving; your full food log stays on the Nutrition page. Buttons need a chat channel, so Web Push can't deliver this kind.",
  },
  {
    kind: "mood",
    label: "Mood check-ins",
    blurb: "A gentle once-daily wellbeing check-in in the evening.",
    safety: false,
    control: { type: "toggle", field: "mood_checkin_enabled" },
    controlTestId: "mood-checkin-enabled",
    extras: [
      {
        field: "mood_recap_enabled",
        label: "Add a mood line to the weekly recap",
        testId: "mood-recap-enabled",
      },
    ],
    more: "It asks “How are you today?” with one-tap answers, pauses itself after a few ignored days and comes back when you next log a check-in — skipping is always fine, and it never escalates anything.",
  },
  {
    kind: "practice",
    label: "Practice check-ins",
    blurb: "A nudge when a wellness practice is behind its weekly floor.",
    safety: false,
    control: { type: "always" },
    more: "Driven by the weekly targets on your practice protocols — there is nothing to send until you create one. Dismissing the matching item on Upcoming silences this nudge too.",
  },
  {
    kind: "digest",
    label: "Morning digest",
    blurb: "One daily summary, including today’s what’s-due list.",
    safety: false,
    control: { type: "time", field: "digest_hour", auto: true },
    controlTestId: "digest-hour",
    extras: [
      {
        field: "digest_sleep_enabled",
        label: "Include last night’s sleep summary",
        testId: "digest-sleep-enabled",
      },
    ],
    more: "Sections with nothing to report are skipped. The Today list is the same one your Upcoming page shows, so a snooze or dismiss there quiets it here. Pick Auto to have it arrive around when you usually wake.",
  },
  {
    kind: "weekly-recap",
    label: "Weekly recap",
    blurb: "A once-a-week summary of your last seven days.",
    safety: false,
    control: {
      type: "day-time",
      dayField: "recap_day",
      timeField: "recap_hour",
    },
    // Names the lines the recap ACTUALLY composes (lib/weekly-recap.ts). It
    // advertised "volume" and "streak" until #1966 noticed: #1935 cut both of
    // those lines, and this Settings blurb was the one place the sweep missed,
    // so the notification's own description promised two things it no longer
    // sent.
    more: "Workouts, PRs, adherence, weight, sleep, and goals. Weeks with nothing to report are skipped.",
  },
  {
    kind: "milestone",
    label: "Milestones",
    blurb: "A quiet note when you hit a milestone.",
    safety: false,
    control: { type: "toggle", field: "milestones_enabled" },
    more: "Milestones always appear on your Timeline whether or not this is on.",
  },
];

// Kinds with NO settings row, and why. Keeping the reasons as data (rather than as a
// comment somewhere) is what lets the reflection test demand that every union member
// is accounted for instead of silently tolerating gaps.
export const NON_CONFIGURABLE_KINDS: Readonly<
  Partial<Record<NotificationKind, string>>
> = {
  test: "A send-test from Settings — always delivered, so the user can verify the wiring.",
  other: "The internal catch-all for an unclassified message.",
  upcoming:
    "Folded into the morning digest's Today section by #1108 — no separate send to toggle. The kind stays in the union for back-compat with stored disabled-kind blobs.",
  redose:
    "A PRN redose-window notice (#798). Safety-adjacent and driven entirely by the item's own PRN interval — there has never been a per-kind control for it.",
  "illness-care":
    "A care finding derived from logged symptoms (#805); it follows the findings bus, not a notification preference.",
  followup:
    "The overdue safety-follow-up escalation (#1866, owner ruling): the tracked due date IS the consent — same structure as a dose reminder — so there is deliberately NO notification setting anywhere. Two sends ever; the per-item resolve/decline terminator is the only off-switch.",
  "ease-back":
    "The one-shot post-illness re-entry note (#837) — a single message per episode, not a recurring kind to schedule.",
  "prn-list":
    "The reply to a `/dose` command (#797). The user asked for it in the chat one second earlier, so a preference that could silence the answer to a direct request would be a bug, not a setting. Kinded only so the single-live invariant (#1898) can key on it.",
  symptom:
    "The reply to a `/symptom` command (#859) — a direct request answered in place, with no scheduled send behind it to configure.",
  temp: "The reply prompt for a `/temp` command (#859) — same reasoning as the other on-demand replies: the request IS the consent.",
};

// The kinds a user can route per channel — the matrix rows. Derived from the ONE
// registry so a new kind becomes a row everywhere at once (the historic hand-kept
// list is what this replaces).
export const TOGGLEABLE_NOTIFICATION_KINDS: readonly {
  kind: NotificationKind;
  label: string;
}[] = NOTIFICATION_KIND_REGISTRY.map((e) => ({
  kind: e.kind,
  label: e.label,
}));

// The SAFETY-tier kinds (#928): scheduled-dose reminders, missed-dose escalation,
// and the PRN redose notice. A channel may disable them, but the UI WARNS — never
// blocks — when one ends up off on EVERY configured channel, consistent with the
// findings-bus principle that a safety signal is never silently suppressed.
export const SAFETY_NOTIFICATION_KINDS: ReadonlySet<NotificationKind> = new Set(
  [
    ...NOTIFICATION_KIND_REGISTRY.filter((e) => e.safety).map((e) => e.kind),
    // Not a registry row (see NON_CONFIGURABLE_KINDS) but safety-classed all the same.
    "redose" as NotificationKind,
  ]
);

export function isSafetyKind(kind: NotificationKind): boolean {
  return SAFETY_NOTIFICATION_KINDS.has(kind);
}

export function notificationKindEntry(
  kind: NotificationKind
): NotificationKindEntry | undefined {
  return NOTIFICATION_KIND_REGISTRY.find((e) => e.kind === kind);
}
