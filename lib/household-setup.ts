// Whether a profile's reminders reach anyone (issue #2173). PURE, no DB/network.
//
// THE DEFECT THIS EXISTS FOR. A profile can build reminders every day and deliver them
// to NOBODY, silently, forever. `managingLoginIdsForProfile()` (lib/notifications/
// managing-logins.ts) is the notification edge set — explicit `login_profiles` grants
// UNION the login whose own profile this is — and the admin ROLE is deliberately not a
// source. That exclusion is CORRECT and is not touched here: an admin who can act as
// every profile must not receive every profile's dose reminders. What was missing is
// that the resulting UNROUTABLE state was invisible: the tick treats "no channel" as a
// non-error (exit-code contract `0 = sent / nothing due / no channel`), so there was no
// log line, no health signal and no UI note anywhere. Settings → Notifications now
// states it.
//
// The DB gather is lib/queries/household-setup.ts (every read profile-scoped, composed
// out of the readers each domain already owns); this module only decides.

// Whether the profile WOULD send something. "A profile with nothing to say is not
// unroutable — it is quiet, correctly", so this is the gate on the whole predicate.
//
// The sources are the tick's own, read at the same gate the tick reads them at:
//   • scheduled intake — an ACTIVE, non-`may` item with at least one un-retired dose,
//     while at least one intake reminder window is on.
//   • the morning digest / the weekly recap — an explicit opt-in each.
//   • the workout nudge — `workoutEnabled` AND an INFERRED training rhythm. The flag
//     alone is default-ON, so counting it would make every profile a send source and
//     "quiet, correctly" unreachable; the tick itself fires this slot only on an
//     inferred weekday, so the rhythm is the honest gate.
//   • preventive — the count of rules the nudge planner still has outstanding.
export interface SendSourceFacts {
  scheduledIntake: number;
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

// WHY the profile is unroutable, when it is. Two shapes, because they take the reader to
// two different forms.
export type UnroutableReason = "no-managing-login" | "no-channel";

export function hasSendSource(s: SendSourceFacts): boolean {
  return (
    s.scheduledIntake > 0 ||
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
  // states, and only the second is a routing defect. So while NO channel
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
export function unroutable(facts: {
  sendSources: SendSourceFacts;
  routing: RoutingFacts;
}): UnroutableReason | null {
  if (!hasSendSource(facts.sendSources)) return null;
  return routingGap(facts.routing);
}
