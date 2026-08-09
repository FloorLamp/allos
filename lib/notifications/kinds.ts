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
import type { ReminderWindow } from "./supplement-format";

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
  "wear-reminder",
  "prn-list",
  "symptom",
  "temp",
  "practice-list",
  "weight",
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
  // The morning digest's mode + time (#2211): one select carrying Off / Static /
  // Dynamic, plus the time input that is the send time in Static and the floor in
  // Dynamic. Deliberately NOT generalised — only the digest waits, and a second
  // consumer is when this becomes shared vocabulary, not before (#2211 constraint 8).
  | { type: "digest-mode"; modeField: string; timeField: string }
  // A weekday select (whose "Off" is the disable) plus a time control, and — for the
  // recap (#2178) — the CADENCE the slot speaks at. The scale sits on the same control
  // because it is the same consent: one slot, one arrival, and the cadence only decides
  // which lengths of period may claim it. A second control would invite reading it as a
  // second subscription, which is exactly what replace-never-stack forbids.
  | {
      type: "day-time";
      dayField: string;
      timeField: string;
      scaleField?: string;
    };

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
  // The intake reminder SLOT(S) this kind's send actually rides (#2161 review).
  //
  // Declared only for a kind with no schedule of its own: it fires at one of these
  // slot times, so a profile with every listed slot turned OFF gets silence however
  // its own toggle reads. That is a REAL and unexotic state — "when do my supplements
  // remind me" and "do I want a bedtime watch nudge" are independent questions, and
  // someone who takes nothing at bedtime turns that slot off — and the failure is the
  // worst shape a settings page has: a checkbox that says on and does nothing.
  //
  // The answer is to NAME the precondition where the toggle is, never to invent a
  // fallback hour. Guessing a bedtime for a send the user consented to at THEIR
  // bedtime would be a worse answer than saying what is missing out loud.
  //
  // Semantics: "at least ONE of these must be configured". `unmetSlotRequirement`
  // below is the pure predicate; the settings page formats the note.
  ridesSlots?: readonly ReminderWindow[];
};

// The slots a kind may declare, and the note that names them when none is set. Pure,
// so the settings row and its tests read one rule.
export function unmetSlotRequirement(
  entry: NotificationKindEntry,
  slotConfigured: (slot: ReminderWindow) => boolean
): readonly ReminderWindow[] | null {
  const slots = entry.ridesSlots;
  if (!slots || slots.length === 0) return null;
  return slots.some(slotConfigured) ? null : slots;
}

/** "Bedtime" / "Morning, Midday, or Evening" — the slots in the note's own words. */
export function slotRequirementNote(slots: readonly ReminderWindow[]): string {
  const named =
    slots.length === 1
      ? slots[0]
      : `${slots.slice(0, -1).join(", ")}, or ${slots[slots.length - 1]}`;
  return `This rides your ${named} reminder time, which is currently off — set one under Schedule above and it will start sending.`;
}

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
    // FOOD_NUDGE_WINDOWS — Bedtime is deliberately excluded from the food nudge.
    ridesSlots: ["Morning", "Midday", "Evening"],
    more: "Tapping a button logs a serving; your full food log stays on the Nutrition page. Buttons need a chat channel, so Web Push and Email can't deliver this kind.",
  },
  {
    kind: "mood",
    label: "Mood check-ins",
    blurb: "A gentle once-daily wellbeing check-in in the evening.",
    safety: false,
    control: { type: "toggle", field: "mood_checkin_enabled" },
    controlTestId: "mood-checkin-enabled",
    // The evening slot hour, the check-in's only schedule.
    ridesSlots: ["Evening"],
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
    control: {
      type: "digest-mode",
      modeField: "digest_mode",
      timeField: "digest_hour",
    },
    controlTestId: "digest-hour",
    extras: [
      {
        field: "digest_sleep_enabled",
        label: "Include last night’s sleep summary",
        testId: "digest-sleep-enabled",
      },
    ],
    // The closing clause used to point at "the latest time shown" — a deadline that is
    // only rendered while Dynamic is SELECTED, so in static mode it named nothing on
    // screen (#2255 §3). Self-contained now: it says what the deadline is rather than
    // where to look for it.
    more: "Sections with nothing to report are skipped. The Today list is the same one your Upcoming page shows, so a snooze or dismiss there quiets it here. “Same time every day” sends at the time you pick whether or not last night’s sleep has arrived; “As soon as it’s ready” waits for it, never sends before that time, and sends anyway by a deadline shortly after your sleep usually arrives.",
  },
  {
    kind: "weekly-recap",
    label: "Recap",
    blurb: "A periodic summary of the last week, month or quarter.",
    safety: false,
    control: {
      type: "day-time",
      dayField: "recap_day",
      timeField: "recap_hour",
      scaleField: "recap_scale",
    },
    // Names the lines the recap ACTUALLY composes (lib/recap.ts). It
    // advertised "volume" and "streak" until #1966 noticed: #1935 cut both of
    // those lines, and this Settings blurb was the one place the sweep missed,
    // so the notification's own description promised two things it no longer
    // sent.
    more: "Workouts, PRs, adherence, weight, sleep, and goals. Periods with nothing to report are skipped. Cadence sets the SHORTEST period the recap reports on, and it never adds a message: it arrives in this one slot, and when a longer period ends on the same slot the longer recap replaces the shorter one rather than sending twice. A monthly or quarterly recap says different things — the shape of your training, the pattern behind an adherence percentage, where your weight is heading — because those are what a month is the first window to show.",
  },
  {
    kind: "wear-reminder",
    label: "Bedtime watch reminder",
    blurb:
      "A nudge at your Bedtime slot when your watch hasn’t recorded in a while.",
    safety: false,
    control: { type: "toggle", field: "wear_reminder_enabled" },
    controlTestId: "wear-reminder-enabled",
    // The Bedtime slot minute is the whole of its schedule, so a profile that takes
    // nothing at bedtime and turned that slot off would consent to a send that can
    // never fire. The row says so rather than the tick guessing an hour.
    ridesSlots: ["Bedtime"],
    // Off unless you turn it on, and it stays off until you do — the ONE place this
    // feature can be enabled from. Sleep is an observation domain, so nothing here is
    // ever "missed"; the reminder exists only because a watch left on the charger
    // costs a whole night of data that no later sync recovers.
    more: "Off unless you turn it on. Sent at most once a night, and only when your watch has gone quiet while your phone keeps syncing normally — never when a connection is already broken, and never if you don’t usually wear a device to sleep. Ignoring it does nothing further.",
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
  "practice-list":
    "The reply to a `/practice` command (#1895) — the tracked practices as one-tap buttons. Distinct from the `practice` KIND, which is the pace nudge the tick decides to send: that one is configurable because the system initiates it, and this one is not, because the user just typed it.",
  weight:
    "The reply prompt for a `/weight` command (#1895) — the `/temp` shape one quantity over. Nothing schedules it; the request IS the consent.",
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
