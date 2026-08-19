import type { AppRoute } from "../hrefs";
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
      "may"
    );
  },
  householdHistory(ctx: DomainCandidateContext) {
    return action(
      ctx,
      "household.episode-history",
      "household.recent-episode-history",
      "household.episodes",
      "may"
    );
  },
  appointment(ctx: DomainCandidateContext, href: AppRoute) {
    return statement(ctx, "appointment.next", `appointment.next:${href}`, null);
  },
  lab(
    ctx: DomainCandidateContext,
    name: string,
    promotion?: { sharedFactKey?: string; changed: boolean }
  ) {
    return reading(
      ctx,
      `labs.latest:${name}`,
      promotion?.sharedFactKey ?? `clinical-result.latest:${name}`,
      null,
      "unknown",
      "current",
      promotion?.changed
        ? {
            rankReasons: changed,
            readingPromotion: "clinical-non-notable-to-notable",
          }
        : {}
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
