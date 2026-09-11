// The atomic dashboard's CANDIDATE VOCABULARY (#3077 / #3096).
//
// A candidate is a fact: an identity, a subject, a relevance policy, a timing
// window and the reasons a ranker once used to seat it. This module owns only
// that vocabulary — it imports no DB, auth, clock, or React code, and since
// #5885 it decides nothing at all.
//
// WHAT LEFT, AND WHY THE NAMES STAY. Home v3 (#5435 §3) gives every row a fixed
// seat, so `rankDashboardCandidates` and everything that served it — the lanes,
// the placements, the timing interpreter, Standing's families and the reason
// precedence — had no production caller and are gone (#5885). What remains is
// what `lib/dashboard-candidates/` still mints and `app/(app)/page.tsx`,
// `lib/home-list.ts`, `lib/sleep-waiting.ts` and `lib/dashboard-reading-promotions.ts`
// still take. The candidate shape is unchanged, so the identities Home renders
// and the specs that key on them are the identities that shipped.

import { DEFAULT_INTAKE_REMINDER_MINUTES } from "./notifications/schedule";
import type { AppRoute } from "./hrefs";

export type DashboardSubject =
  | { scope: "profile"; profileId: number }
  | { scope: "household" }
  | { scope: "login" };

export type DashboardTiming =
  | { kind: "always" }
  | {
      kind: "local-time";
      opensAt: number;
      closesAt: number;
      wrapsMidnight: boolean;
    }
  | {
      kind: "local-time-windows";
      windows: readonly {
        opensAt: number;
        closesAt: number;
        wrapsMidnight: boolean;
      }[];
    }
  | { kind: "since-event"; ageMinutes: number; maxMinutes: number }
  | { kind: "local-days"; ageDays: number; maxDays: number }
  | { kind: "until-signal"; active: boolean };


// The owner-ratified reading-promotion registry (#3077 / #3137). A reading may
// carry `changed` only when it names one of these existing semantic signals.
// Raw numeric deltas deliberately have no representation here.
export type DashboardReadingPromotion =
  | "clinical-non-notable-to-notable"
  | "outcome-goal-transition"
  | "training-best"
  | "sleep-arrived"
  | "nap-ended";

export type DashboardObligation = "must" | "should" | "may";
export type DashboardRelevancePolicy =
  | {
      kind: "profile-data";
      presence: "never" | "current" | "dormant";
      engagement: "unknown" | "manual" | "external";
    }
  | { kind: "event" }
  | { kind: "setup" }
  | { kind: "state" };

export interface DashboardRankReasons {
  safety: boolean;
  owed: boolean;
  windowOpen: boolean;
  changed: boolean;
}

export type DashboardEpisodeMemberRole =
  "state" | "must" | "should" | "reading";

// Typed membership for one open illness cockpit (#3138). `groupKey` remains the
// generic presentation identity used by the rest of the dashboard; this metadata is
// the only authority for recognizing and ordering illness members. In particular,
// candidate-id spelling and input adjacency carry no policy.
export interface DashboardEpisodeGroup {
  kind: "illness-episode";
  groupKey: string;
  episodeKey: string;
  profileId: number;
  episodeOrder: number;
  memberRole: DashboardEpisodeMemberRole;
  memberOrder: number;
}

export interface DashboardCandidateBase {
  candidateId: string;
  factKey: string;
  groupKey: string | null;
  episodeGroup?: DashboardEpisodeGroup;
  subject: DashboardSubject;
  applicable: boolean;
  relevance: DashboardRelevancePolicy;
  timing: DashboardTiming;
  rankReasons: DashboardRankReasons;
  readingPromotion?: DashboardReadingPromotion;
  sourceOrder: number;
  // Explicitly authorized illness context that remains useful after an episode
  // closes. Apart from open `episodeGroup` context, this is the only cross-profile
  // exception to active-profile/login-setup scope; a candidate id grants nothing.
  dashboardScope?: "illness-context";
  // THE PAGE THIS CANDIDATE IS ONLY A LINK TO, when the nav already carries that
  // page (owner ruling #3366). Declaring it is a claim about the candidate's whole
  // content — it reports no value and hosts no control, so on the dashboard it is a
  // second spelling of a nav row. It never changed CANDIDACY, only presentation;
  // the tail that consumed it retired with the ranker (#5435 §4, #5883).
  navDuplicateOf?: AppRoute;
}

export type DashboardCandidate =
  | (DashboardCandidateBase & {
      kind: "action";
      obligation: DashboardObligation;
    })
  | (DashboardCandidateBase & { kind: "reading" })
  | (DashboardCandidateBase & { kind: "statement" })
  | (DashboardCandidateBase & { kind: "state" });

// THE MORNING ANCHOR `lib/sleep-waiting.ts` READS. It is the Morning intake
// reminder default, named once so the waiting window and the reminder cannot
// disagree about when the morning starts.
export const DEFAULT_WAKE_MINUTES = DEFAULT_INTAKE_REMINDER_MINUTES.Morning;
