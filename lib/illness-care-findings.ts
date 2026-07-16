// The illness-care findings BUILDER (issue #805) — the DB gather that feeds the pure
// engine (lib/illness-care.ts), per the #448 findings-builder discipline: it GATHERS
// DB state (the current open illness episode + the profile's age) and hands it to the
// pure detector, then maps the results into the shared envelopes each CARE-tier
// surface renders. It carries no threshold logic and no owned SQL (it reads through
// the profile-scoped #801 assembly), so the profile-scoping guard is unaffected.
//
// ONE gather (illnessCareFindingsFor), THREE formatters over it (#221): the care-tier
// Finding (for the #448 registry/reflection guard), the Upcoming item (→ Upcoming
// page + the non-hideable Needs-attention hero via buildAttentionModel), and — in
// lib/notifications/illness-care.ts — the Telegram nudge. All three carry the SAME
// dedupeKey, so a dismiss on any surface silences every surface through the shared
// bus ("dismiss once, silence everywhere", #449).
//
// Care tier, deliberately (#449): unlike the calm coaching builders in
// lib/rule-findings.ts, this one is PUSH — its dedupeKey prefix (ILLNESS_CARE_PREFIX)
// is registered in RULE_FINDING_PREFIXES, and its items are banded "today" so they
// reach the hero. It is NOT part of collectCoachingFindings.

import {
  assembleIllnessEpisode,
  episodeForProfileDate,
} from "./illness-episode";
import { isOpenEpisode } from "./illness-episode-format";
import { profileAgeMonths } from "./settings";
import {
  detectIllnessCareFindings,
  illnessCareEvidence,
  illnessCareFullDetail,
  type IllnessCareFinding,
} from "./illness-care";
import type { Finding } from "./findings";
import type { UpcomingItem } from "./upcoming";
import { episodeHref } from "./hrefs";

// The current OPEN illness episode for a profile assembled as of `date` (the #801
// gather — never a second episode engine), or null when the profile isn't currently
// in an ongoing illness with any logged signal. Parameterized on `date` for the tick
// / tests; the ongoing episode's own asOf still resolves in the profile's timezone.
function openEpisodeAsOf(profileId: number, date: string) {
  const ep = episodeForProfileDate(profileId, date);
  if (!ep) return null;
  const assembled = assembleIllnessEpisode(profileId, ep);
  return isOpenEpisode(assembled) ? assembled : null;
}

// The ONE gather: the illness-care findings the profile's current open episode
// crosses, as neutral IllnessCareFinding results. Every surface formats over THIS.
export function illnessCareFindingsFor(
  profileId: number,
  date: string
): IllnessCareFinding[] {
  const episode = openEpisodeAsOf(profileId, date);
  if (!episode) return [];
  return detectIllnessCareFindings(episode, {
    ageMonths: profileAgeMonths(profileId, date),
  });
}

// The action link every surface shares: the #801 illness-episode detail page for the
// current episode (any date inside it derives the containing episode).
function actionHrefFor(profileId: number, date: string) {
  const episode = openEpisodeAsOf(profileId, date);
  const day = episode?.lastActiveDay ?? episode?.asOf ?? date;
  return episodeHref(day);
}

// One neutral finding → the shared care-tier Finding envelope. Caution tone (a
// duration/trajectory line worth acting on, never a celebratory/info FYI); the source
// + "not medical advice" tail rides `evidence`, the fact + line rides `detail`.
function toFinding(
  f: IllnessCareFinding,
  href: ReturnType<typeof episodeHref>
): Finding {
  return {
    domain: "illness-care",
    dedupeKey: f.dedupeKey,
    title: f.title,
    detail: f.detail,
    tone: "caution",
    evidence: illnessCareEvidence(f),
    actionHref: href,
    actionLabel: "View episode",
  };
}

// The illness-care findings for a profile as care-tier Findings (for the #448
// reflection guard + any Finding-typed surface). Reads through the profile-scoped
// #801 assembly.
export function buildIllnessCareFindings(
  profileId: number,
  date: string
): Finding[] {
  const findings = illnessCareFindingsFor(profileId, date);
  if (findings.length === 0) return [];
  const href = actionHrefFor(profileId, date);
  return findings.map((f) => toFinding(f, href));
}

// The illness-care findings as Upcoming items (issue #805) → the Upcoming page AND
// the non-hideable Needs-attention hero (via collectUpcoming → buildAttentionModel).
// Banded "today" like the other care-tier informational findings (dietary-limit /
// interaction / prn-max), keyed by the SAME dedupeKey so a dismiss on any surface
// silences it through getFindingSuppressions. `detail` is self-contained (fact +
// line + source + the mandatory "not medical advice" tail) since UpcomingItem has no
// evidence slot.
export function illnessCareItems(
  profileId: number,
  date: string
): UpcomingItem[] {
  const findings = illnessCareFindingsFor(profileId, date);
  if (findings.length === 0) return [];
  const href = actionHrefFor(profileId, date);
  return findings.map((f) => ({
    key: f.dedupeKey,
    domain: "illness-care" as const,
    title: f.title,
    detail: illnessCareFullDetail(f),
    href,
    dueDate: null,
    band: "today" as const,
    dueText: "Review",
  }));
}
