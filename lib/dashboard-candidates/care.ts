import type { AppRoute } from "../hrefs";
import { profileDataRelevance } from "./candidate";
import {
  action,
  changed,
  reading,
  state,
  statement,
  type DomainCandidateContext,
} from "./shared";

export const careCandidates = {
  illnessState(ctx: DomainCandidateContext, key: string) {
    return state(
      ctx,
      `illness.state:${key}`,
      `illness.episode:${key}`,
      `illness.episode:${key}`,
      { rankReasons: changed }
    );
  },
  illnessReading(
    ctx: DomainCandidateContext,
    kind: "temperature" | "medication",
    key: string
  ) {
    return reading(
      ctx,
      `illness.${kind}:${key}`,
      `illness.${kind}:${key}`,
      `illness.episode:${key}`,
      "manual"
    );
  },
  illnessOpen(ctx: DomainCandidateContext, key: string) {
    return action(
      ctx,
      `illness.open:${key}`,
      `illness.care-action:${key}`,
      `illness.episode:${key}`,
      "may"
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
