// Per-member SETUP HEALTH for the Household board (issue #2173). PURE, no DB/network.
//
// THE DEFECT THIS EXISTS FOR. A profile can build reminders every day and deliver them
// to NOBODY, silently, forever. `managingLoginIdsForProfile()` (lib/notifications/
// managing-logins.ts) is the notification edge set — explicit `login_profiles` grants
// UNION the login whose own profile this is — and the admin ROLE is deliberately not a
// source. That exclusion is CORRECT and is not touched here: an admin who can act as
// every profile must not receive every profile's dose reminders. What was missing is
// that the resulting UNROUTABLE state was invisible: the tick treats "no channel" as a
// non-error (exit-code contract `0 = sent / nothing due / no channel`), so there was no
// log line, no health signal and no UI note anywhere.
//
// Auditing a real four-profile household turned that into one instance of a broader
// blind spot — cross-profile SETUP NEGLECT had no surface at all. Onboarding that was
// never STARTED renders identically to onboarding that is complete
// (`onboardingNeedsSetup(null)` is false); widget empty-state CTAs render only for the
// ACTIVE profile's own dashboard; and the household strip filters to members with
// non-zero ATTENTION counts, which none of these produce. So the five checks below live
// together, on the one surface that is already the family status board.
//
// WHERE IT MAY REACH — class 2, rendered aggregate, and nothing else
// (docs/internals/findings.md §1). It costs nothing until someone opens `/household`.
// It NEVER sends and it never enters the digest: the digest is about the profile's
// HEALTH, not the household's CONFIGURATION, and the contact-consent rule is
// one-directional — the system may reduce contact unilaterally, never increase it. That
// is also why there is deliberately no Upcoming item: an Upcoming row IS a digest line
// (`collectUpcoming` feeds `buildDigest`), so adding one would be exactly the increase
// the constraint forbids.
//
// SEVERITY REUSES THE EXISTING BANDING. Content may raise a row — an undeliverable
// `must` MEDICATION reminder is stronger than a `should` supplement — but the vocabulary
// is `FindingTone` (lib/findings.ts), the codebase's existing coarse severity signal. No
// new severity words.
//
// The DB gather is lib/queries/household-setup.ts (every read profile-scoped, composed
// out of the readers each domain already owns); this module only decides and phrases.

import type { FindingTone } from "./findings";
import type { IntakeItemKind } from "./types/intake";
import { intakeHref, medicationEditHref, type AppRoute } from "./hrefs";

// The dedupeKey namespace the setup row keys under, registered in
// lib/rule-finding-prefixes.ts as a SUPPRESSION-ONLY namespace (the poor-sleep-override
// / portal-sync-ask precedent: no builder emits it, so the reflection guards over
// builder OUTPUT never see it, but the key must still be guardable and its tier
// declared).
export const HOUSEHOLD_SETUP_PREFIX = "household-setup:";

// ── The five checks ───────────────────────────────────────────────────────────

// Declaration order IS the render order AND the canonical order inside the episode key,
// so the key for a given failing SET is deterministic.
export const HOUSEHOLD_SETUP_CHECK_IDS = [
  "unroutable",
  "never-onboarded",
  "undosed-items",
  "preventive-unactioned",
  "roster-inactive",
] as const;

export type HouseholdSetupCheckId = (typeof HOUSEHOLD_SETUP_CHECK_IDS)[number];

// WHERE a check's fix lives. Two shapes, because they are two different journeys:
//   • "login"  — a route about the VIEWER's own login/instance configuration
//                (Settings → People & access, Settings → Notifications). Reachable as
//                an ordinary link: no profile switch is involved.
//   • "member" — a route about THIS MEMBER's own data (their onboarding, their dose
//                editor). The household card links nothing cross-profile directly
//                (#879: a cross-profile deep link lands on a dead anchor), so these go
//                through the card's switch-then-navigate action, which re-derives the
//                destination server-side rather than trusting a posted route.
export type HouseholdSetupCtaScope = "login" | "member";

export interface HouseholdSetupCta {
  scope: HouseholdSetupCtaScope;
  href: AppRoute;
  label: string;
}

export interface HouseholdSetupCheck {
  id: HouseholdSetupCheckId;
  tone: FindingTone;
  // Short imperative/declarative headline ("Reminders reach no one").
  title: string;
  // One sentence naming WHAT is wrong and, where it helps, how much.
  detail: string;
  cta: HouseholdSetupCta | null;
}

// ── Inputs ────────────────────────────────────────────────────────────────────

// One intake item reduced to what these checks read.
export interface SetupIntakeItem {
  id: number;
  name: string;
  // The item's KIND decides where its dose editor lives, which is the whole reason
  // this shape carries anything beyond a name.
  kind: IntakeItemKind;
}

// A preventive rule the planner still considers unactioned.
export interface SetupPreventiveItem {
  ruleKey: string;
  name: string;
}

// Whether the profile WOULD send something. "A profile with nothing to say is not
// unroutable — it is quiet, correctly", so this is the gate on the whole predicate.
//
// The sources are the tick's own, read at the same gate the tick reads them at:
//   • scheduled intake — an ACTIVE, non-`may` item with at least one un-retired dose,
//     while at least one intake reminder window is on. Split by KIND because the
//     banding below reflects content.
//   • the morning digest / the weekly recap — an explicit opt-in each.
//   • the workout nudge — `workoutEnabled` AND an INFERRED training rhythm. The flag
//     alone is default-ON, so counting it would make every profile a send source and
//     "quiet, correctly" unreachable; the tick itself fires this slot only on an
//     inferred weekday, so the rhythm is the honest gate.
//   • preventive — the count of rules the nudge planner still has outstanding.
export interface SendSourceFacts {
  scheduledMedications: number;
  scheduledSupplements: number;
  digestEnabled: boolean;
  weeklyRecapEnabled: boolean;
  workoutNudgeScheduled: boolean;
  preventiveNudges: number;
}

// The routing facts the predicate reads. `channelledLoginIds` is the subset of the edge
// set with at least one CONFIGURED personal channel (Telegram with a bot token and a
// chat, a live Web Push subscription with instance VAPID keys, an enabled email address
// with SMTP configured).
//
// MUTE IS DELIBERATELY NOT READ. A per-(login, profile) mute is a warned, deliberate
// choice — `wouldMuteSilenceSafety` (#1324) already tells the user at the mute seam when
// they are the last unmuted caregiver — and the issue's own wording is "no login in it
// has any CONFIGURED channel". Unroutable is a routing gap nobody chose; re-reporting a
// mute here would be a second nag about a decision already confirmed.
//
// `profileChannelConfigured` is the Home Assistant webhook, which is PROFILE-scoped: it
// delivers with no managing login at all, so a profile that has one is routable even
// with an empty edge set.
//
// `instanceHasAnyChannel` is the INSTANCE-WIDE gate below — one fact about the whole
// server, filled once by `instanceHasAnyChannel()` (lib/notifications/routing.ts) and
// carried on every profile's facts identically.
export interface RoutingFacts {
  managingLoginIds: readonly number[];
  channelledLoginIds: readonly number[];
  profileChannelConfigured: boolean;
  instanceHasAnyChannel: boolean;
}

export interface HouseholdSetupFacts {
  sendSources: SendSourceFacts;
  routing: RoutingFacts;
  // Whether an `onboarding_state` row exists AT ALL. `getOnboardingState` returns null
  // for a profile that never started, and `onboardingNeedsSetup(null)` is false — which
  // is exactly why never-started has always rendered like complete.
  onboardingStarted: boolean;
  // Whether ANY onboarding data-presence domain has a row (records, medications,
  // fitness, metrics/labs, preventive care). "Thin presence" is none of them: a profile
  // with real data in it was plainly set up by hand, and offering to "finish setup"
  // there would be noise.
  hasStoredData: boolean;
  // ACTIVE, non-`may` items with zero un-retired dose rows — scheduled-shaped items that
  // can never be due.
  undosedItems: readonly SetupIntakeItem[];
  // Preventive rules the planner still has outstanding.
  preventiveUnactioned: readonly SetupPreventiveItem[];
  // The intake roster, for the SUGGEST-only oddity.
  roster: {
    active: number;
    inactive: number;
    // Inactive items carrying a real obligation (`must` / `should`) — a `may` item
    // going quiet is not an oddity, it is the point of `may`.
    inactiveObligated: number;
  };
}

// ── The unroutable predicate ──────────────────────────────────────────────────

// WHY the profile is unroutable, when it is. Two shapes, because they take the reader to
// two different forms.
export type UnroutableReason = "no-managing-login" | "no-channel";

export function hasSendSource(s: SendSourceFacts): boolean {
  return (
    s.scheduledMedications > 0 ||
    s.scheduledSupplements > 0 ||
    s.digestEnabled ||
    s.weeklyRecapEnabled ||
    s.workoutNudgeScheduled ||
    s.preventiveNudges > 0
  );
}

// Would a message ABOUT this profile reach nobody? Structural and TIMEZONE-FREE — the
// question is whether a route exists, never whether something is due right now.
//
// NOT DOUBLE-FIRING WITH `notify_lifecycle` IS A PROPERTY OF THIS FUNCTION, not a filter
// bolted on after it. The delivery-status marker (lib/notifications/delivery-status.ts)
// records a channel that was ATTEMPTED and FAILED; a channel can only be attempted if it
// is configured, and this returns null the moment ANY channel is configured. So the two
// states are disjoint by construction — "one row, whichever applies" — and
// lib/__tests__/household-setup.test.ts pins that as an invariant rather than trusting
// the prose.
export function routingGap(routing: RoutingFacts): UnroutableReason | null {
  // THE INSTANCE GATE (owner ruling on PR #2362), first, because it is a question about
  // the SERVER rather than about this member. "Notifications are not set up yet" and
  // "notifications are set up, and this member cannot be reached by them" are different
  // states, and only the second is a household setup-health defect. So while NO channel
  // technology is configured anywhere on the instance — no Telegram bot, no Web Push, no
  // Home Assistant, no email — this stays silent for EVERY profile, and it starts firing
  // the moment any channel exists anywhere, which is exactly when the asymmetry between
  // members becomes real and worth naming.
  //
  // The accepted cost, stated so it is not rediscovered as a bug: an operator who never
  // configures any channel at all never learns from this surface that their reminders go
  // nowhere. That trade is deliberate — a fresh install that greets you with a warning
  // per member on day one teaches people to ignore the surface, and an ignored surface
  // cannot do its job on the day the asymmetry is real.
  //
  // NOTE THE SHAPE. This is an instance-wide fact, evaluated ONCE
  // (`instanceHasAnyChannel()`, lib/notifications/routing.ts) — not per profile, and
  // emphatically NOT "every profile came back unroutable, therefore suppress". That
  // would be a different predicate, and it would also silence a fully configured
  // instance on which every member happens to be unreachable, which is the LOUDEST true
  // case and must stay loud.
  if (!routing.instanceHasAnyChannel) return null;
  if (routing.profileChannelConfigured) return null;
  if (routing.channelledLoginIds.length > 0) return null;
  return routing.managingLoginIds.length === 0
    ? "no-managing-login"
    : "no-channel";
}

// The whole predicate: the send-source scan × the edge set × per-login channel presence.
// Null when the profile has nothing to say (quiet, correctly) or when a route exists.
export function unroutable(
  facts: Pick<HouseholdSetupFacts, "sendSources" | "routing">
): UnroutableReason | null {
  if (!hasSendSource(facts.sendSources)) return null;
  return routingGap(facts.routing);
}

// ── Detectors ─────────────────────────────────────────────────────────────────

function pluralItems(n: number): string {
  return n === 1 ? "1 item" : `${n} items`;
}

function unroutableCheck(f: HouseholdSetupFacts): HouseholdSetupCheck | null {
  const reason = unroutable(f);
  if (!reason) return null;
  const s = f.sendSources;
  const scheduled = s.scheduledMedications + s.scheduledSupplements;
  // Content raises the band, within the EXISTING vocabulary: an undeliverable `must`
  // medication reminder is a `caution`, a supplement-only or digest-only one is an
  // `action`. Both render.
  const tone: FindingTone = s.scheduledMedications > 0 ? "caution" : "action";
  const what =
    scheduled > 0
      ? `${pluralItems(scheduled)} build${scheduled === 1 ? "s" : ""} daily with no recipient`
      : "scheduled messages build with no recipient";
  return {
    id: "unroutable",
    tone,
    title: "Reminders reach no one",
    detail:
      reason === "no-managing-login"
        ? `${what}. No login receives this profile's notifications.`
        : `${what}. Every login that receives this profile has no channel configured.`,
    cta:
      reason === "no-managing-login"
        ? {
            scope: "login",
            // The grant UI. `setGrants` accepts an admin since #2345, so for an admin a
            // `login_profiles` row means exactly "notify me about this profile" — which
            // is what makes this CTA land on a form that can actually act.
            href: "/settings/family",
            label: "Grant a login",
          }
        : {
            scope: "login",
            href: "/settings/notifications",
            label: "Configure a channel",
          },
  };
}

function neverOnboardedCheck(
  f: HouseholdSetupFacts
): HouseholdSetupCheck | null {
  if (f.onboardingStarted || f.hasStoredData) return null;
  return {
    id: "never-onboarded",
    tone: "info",
    title: "Setup never started",
    detail:
      "This profile has no onboarding progress and no records yet, so no checklist " +
      "or resume card has ever shown for it.",
    cta: { scope: "member", href: "/onboarding", label: "Finish setup" },
  };
}

function undosedItemsCheck(f: HouseholdSetupFacts): HouseholdSetupCheck | null {
  const items = f.undosedItems;
  if (items.length === 0) return null;
  const first = items[0];
  const names = items
    .slice(0, 3)
    .map((i) => i.name)
    .join(", ");
  return {
    id: "undosed-items",
    tone: "action",
    title: `${pluralItems(items.length)} with no dose`,
    detail:
      `${names}${items.length > 3 ? ", …" : ""} — active and scheduled-shaped, but ` +
      `with no dose row, so ${items.length === 1 ? "it" : "they"} can never be due.`,
    cta: {
      scope: "member",
      // Exactly one unconfirmed item deep-links its own edit form (where the dose editor
      // lives); several land on the kind's surface — the #1146 rule the data-quality
      // gaps already follow.
      href:
        items.length === 1 && first.kind === "medication"
          ? medicationEditHref(first.id)
          : intakeHref(first.kind),
      label: "Add a dose",
    },
  };
}

function preventiveCheck(f: HouseholdSetupFacts): HouseholdSetupCheck | null {
  const items = f.preventiveUnactioned;
  if (items.length === 0) return null;
  const names = items
    .slice(0, 3)
    .map((i) => i.name)
    .join(", ");
  return {
    id: "preventive-unactioned",
    tone: "action",
    title:
      items.length === 1
        ? "1 preventive item unactioned"
        : `${items.length} preventive items unactioned`,
    detail: `${names}${items.length > 3 ? ", …" : ""} — overdue, unbooked and not dismissed.`,
    cta: { scope: "member", href: "/upcoming", label: "Open Upcoming" },
  };
}

function rosterCheck(f: HouseholdSetupFacts): HouseholdSetupCheck | null {
  const { active, inactive, inactiveObligated } = f.roster;
  // SUGGEST-ONLY, and the shape is a QUESTION (#1505/#1668): an all-inactive roster that
  // still contains items the user declared `must`/`should` is plausibly a bulk sweep and
  // is plausibly deliberate. The app cannot tell, so it asks — it never reactivates
  // anything, because obligation and activity are user-written, always.
  if (active > 0 || inactive === 0 || inactiveObligated === 0) return null;
  return {
    id: "roster-inactive",
    tone: "info",
    title: `${pluralItems(inactive)} inactive — intended?`,
    detail:
      `Every tracked item is inactive, including ${inactiveObligated} the profile ` +
      `declared as expected. Nothing has been changed.`,
    cta: null,
  };
}

const DETECTORS: ((f: HouseholdSetupFacts) => HouseholdSetupCheck | null)[] = [
  unroutableCheck,
  neverOnboardedCheck,
  undosedItemsCheck,
  preventiveCheck,
  rosterCheck,
];

// ── The row ───────────────────────────────────────────────────────────────────

const TONE_RANK: Record<FindingTone, number> = {
  caution: 4,
  action: 3,
  info: 2,
  neutral: 1,
  positive: 0,
};

export interface HouseholdSetupRow {
  checks: HouseholdSetupCheck[];
  // The strongest tone among the checks — the row's band, in the existing vocabulary.
  tone: FindingTone;
  // EPISODE-scoped identity: the sorted set of FAILING CHECK IDS. A dismissal therefore
  // means "not this set of problems"; the moment a NEW check type fails the key changes
  // and the row is offered again (constraint 9's "episode = until the underlying set of
  // failing checks changes").
  dedupeKey: string;
  // Whether a dismiss control may be offered AT ALL. FALSE whenever `unroutable` is in
  // the set: constraint 3 forbids a standing "this profile is unroutable" dismissal,
  // because that would recreate exactly the silence this removes. Every other
  // combination is dismissible, keyed on the set above.
  dismissible: boolean;
}

export function householdSetupDedupeKey(
  ids: readonly HouseholdSetupCheckId[]
): string {
  const ordered = HOUSEHOLD_SETUP_CHECK_IDS.filter((id) => ids.includes(id));
  return `${HOUSEHOLD_SETUP_PREFIX}${ordered.join("+")}`;
}

// Every failing check for a gathered snapshot, in declaration order, or null when the
// member's setup is healthy. Deterministic and pure.
export function detectHouseholdSetup(
  facts: HouseholdSetupFacts
): HouseholdSetupRow | null {
  const checks = DETECTORS.map((d) => d(facts)).filter(
    (c): c is HouseholdSetupCheck => c !== null
  );
  if (checks.length === 0) return null;
  const tone = checks.reduce<FindingTone>(
    (best, c) => (TONE_RANK[c.tone] > TONE_RANK[best] ? c.tone : best),
    "neutral"
  );
  return {
    checks,
    tone,
    dedupeKey: householdSetupDedupeKey(checks.map((c) => c.id)),
    dismissible: !checks.some((c) => c.id === "unroutable"),
  };
}
