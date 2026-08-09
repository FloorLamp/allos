// THE delivery axis (#2301): WHO MOVES THE DATA.
//
// `ProviderStanding` (#1772) was one flat vocabulary of seven states, every one of
// which describes a LIVE CONNECTION allos depends on — healthy, partial, intermittent,
// failing, needs-reauth, not-connected, never-synced. Four of the nine registered
// providers have no such connection: a Takeout archive is a file the user hands us,
// patient portals is a companion tool a person runs by hand on their own machine, the
// calendar feed is outbound, and Garmin is planned. Asked "is the connection working?"
// about any of them, the model answered anyway — a ten-day-old file import rendered
// "Connected", green; an outbound feed rendered "Connected" plus a permanent
// "No syncs yet"; a hand-run tool with three failures in six runs rendered
// "Intermittent", a flapping-CONNECTION word for something nobody was connected to.
//
// The axis was never missing — it was never DECLARED, so four surfaces re-derived it
// by enumerating members, each a different subset:
//
//   • `RECURRING_SOURCE_KINDS` (lib/queries/integrations.ts) — a `Set<string>` naming
//     4 of the 7 kinds. It had already caused this exact bug once: `public` was
//     missing, which left Weather's successful history unreachable while its failures
//     still showed under Needs attention (#1614).
//   • `WHERE provider = 'fitbit-takeout'` in the Imports feed — one of the two
//     attended members named in SQL, which is why patient-portals' recorded runs
//     (failures included) appeared on NO Review surface at all.
//   • `syncVocabularyForKind` / `syncRunNounForKind`, both taking `kind: string`.
//     That missing type is exactly why `archive` and `external-attended` fell into
//     the polled dialect silently: there was no exhaustiveness to fail.
//
// DERIVED FROM KIND, NOT DECLARED PER PROVIDER. The kind already encodes it and two
// providers of one kind cannot differ, so a per-provider field would be a second
// source of truth for a fact the kind already states. The `Record<IntegrationKind, …>`
// below IS the enforcement — a new kind is a build error until it declares its
// delivery — the same idiom as `FAMILIES: Record<ReconcileFamily, …>`.
//
// PURE: this module imports the kind TYPE and nothing else, so the pure tier, the
// registry, the query layer and client components can all read it.

import type { IntegrationKind } from "@/lib/types/integrations";

// WHO MOVES THE DATA:
//
//   scheduled — data moves without a person present: allos polls, or the source
//               pushes on its own schedule. THE ONLY FAMILY for which "is the
//               connection working?" is a question at all.
//   attended  — a person must act for anything to arrive. Allos cannot start it,
//               cannot retry it, and may never call it late.
//   outbound  — allos publishes; nothing arrives, and no runs are recorded.
export type IntegrationDelivery = "scheduled" | "attended" | "outbound";

// A new kind is a build error until it declares its delivery.
export const KIND_DELIVERY: Record<IntegrationKind, IntegrationDelivery> = {
  // The phone exporter POSTs on its own schedule; nobody is present.
  push: "scheduled",
  // Allos holds the credential and polls on the tick.
  oauth: "scheduled",
  token: "scheduled",
  // Keyless, but still polled by the tick on a declared cadence.
  public: "scheduled",
  // A file the user downloads from a vendor and hands us. An import is an EVENT,
  // not a link — the registry says so in as many words.
  archive: "attended",
  // A companion tool that runs on the USER'S machine when they choose (portal 2FA
  // needs a person and sessions idle out in minutes) and pushes results in.
  "external-attended": "attended",
  // The calendar client pulls our .ics. Nothing ever arrives.
  feed: "outbound",
};

export function deliveryForKind(kind: IntegrationKind): IntegrationDelivery {
  return KIND_DELIVERY[kind];
}

// Is this the one family for which a CONNECTION verdict is meaningful? This replaced
// `RECURRING_SOURCE_KINDS` — the hand-enumerated Set that decided which providers
// reach Data → Review's "Connected sources".
export function isScheduledKind(kind: IntegrationKind): boolean {
  return KIND_DELIVERY[kind] === "scheduled";
}
