import { EPISODES_HREF, type AppRoute } from "../hrefs";
import type { DashboardEpisodeGroup } from "../dashboard-relevance";
import { profileDataRelevance } from "./candidate";
import {
  action,
  changed,
  reading,
  state,
  statement,
  type DomainCandidateContext,
} from "./shared";

function illnessStateIdentity(key: string) {
  return {
    candidateId: `illness.state:${key}`,
    factKey: `illness.episode:${key}`,
    groupKey: `illness.episode:${key}`,
  };
}

function illnessReadingIdentity(
  kind: "temperature" | "medication",
  key: string,
  readingKey: string | number
) {
  return {
    candidateId: `illness.${kind}:${key}`,
    factKey: `illness.${kind}:${readingKey}`,
    groupKey: `illness.episode:${key}`,
  };
}

export const careCandidates = {
  illnessStateIdentity,
  illnessReadingIdentity,
  illnessState(
    ctx: DomainCandidateContext,
    key: string,
    episodeGroup: DashboardEpisodeGroup
  ) {
    const identity = illnessStateIdentity(key);
    return state(
      ctx,
      identity.candidateId,
      identity.factKey,
      identity.groupKey,
      { rankReasons: changed, episodeGroup }
    );
  },
  illnessReading(
    ctx: DomainCandidateContext,
    kind: "temperature" | "medication",
    key: string,
    readingKey: string | number,
    episodeGroup: DashboardEpisodeGroup
  ) {
    const identity = illnessReadingIdentity(kind, key, readingKey);
    return reading(
      ctx,
      identity.candidateId,
      identity.factKey,
      identity.groupKey,
      "manual",
      "current",
      { episodeGroup }
    );
  },
  illnessReopen(ctx: DomainCandidateContext, key: string) {
    return action(
      ctx,
      `illness.reopen:${key}`,
      `illness.closed-episode:${key}`,
      `illness.episode:${key}`,
      "may",
      { dashboardScope: "illness-context" }
    );
  },
  householdHistory(ctx: DomainCandidateContext) {
    return action(
      ctx,
      "household.episode-history",
      "household.recent-episode-history",
      "household.episodes",
      "may",
      // A LINK AND NOTHING ELSE, to a page the sidebar already lists as "Illness
      // episodes" (#3366). It reports no value, so the tail draws one door row to
      // that page instead of a card restating the nav.
      { dashboardScope: "illness-context", navDuplicateOf: EPISODES_HREF }
    );
  },
  appointment(ctx: DomainCandidateContext, href: AppRoute) {
    return statement(ctx, "appointment.next", `appointment.next:${href}`, null);
  },
  // A RECENT RESULT'S TWO DIFFERENT CLAIMS.
  //
  // `changed` is the #3077 promotion: a marker that JUST turned notable, which is a
  // Now fact and cards there. `fresh` is #4232's ruling — a result collected inside
  // the freshness window is relevant whether or not it is notable — and it is carried
  // as the existing `owed` reason for exactly the reason a behind weekly target is
  // (see `targetProgress` in progress.ts): `nowScore` awards `owed` to ACTIONS only,
  // so a fresh reading states itself in Standing's attention tier and never takes a
  // Now slot on its own. No new score module, and no new promotion code: a fresh draw
  // is not a semantic transition, it is a date.
  lab(
    ctx: DomainCandidateContext,
    name: string,
    promotion?: { sharedFactKey?: string; changed?: boolean; fresh?: boolean }
  ) {
    // The recent results are ONE moment in the tail, not N loose readings (#4232) —
    // see the pillars' note in progress.ts for why the shared `groupKey` is what
    // replaces the family label the retired Standing band used to print.
    return reading(
      ctx,
      `labs.latest:${name}`,
      promotion?.sharedFactKey ?? `clinical-result.latest:${name}`,
      "clinical-result.recent",
      "unknown",
      "current",
      {
        rankReasons: {
          safety: false,
          owed: promotion?.fresh === true,
          windowOpen: false,
          changed: promotion?.changed === true,
        },
        ...(promotion?.changed
          ? { readingPromotion: "clinical-non-notable-to-notable" as const }
          : {}),
      }
    );
  },
  labBootstrap(ctx: DomainCandidateContext) {
    return action(
      ctx,
      "labs.bootstrap",
      "clinical-result.first-import",
      null,
      "may",
      { relevance: profileDataRelevance("never") }
    );
  },
};
