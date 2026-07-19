// The temperature red-flag findings BUILDER (issue #859 item 3) — the DB gather that
// feeds the pure engine (lib/temp-red-flag), per the #448 findings-builder discipline:
// it GATHERS DB state (the current open illness episode's latest reading + the
// profile's age) and hands it to the pure detector, then maps the result into the
// shared envelopes each CARE-tier surface renders. No threshold logic and no owned SQL
// (it reads through the profile-scoped #801 assembly), so the profile-scoping guard is
// unaffected.
//
// ONE gather (tempRedFlagFindingFor), formatters over it (#221): the care-tier Finding
// (for the #448 registry/reflection guard), the Upcoming item (→ Upcoming page + the
// non-hideable Needs-attention hero), the inline log toast, and — in
// lib/notifications/temp-red-flag.ts — the Telegram nudge. All carry the SAME
// dedupeKey, so a dismiss on any surface silences every surface through the shared bus.
//
// Care tier, deliberately (#449): its dedupeKey prefix (TEMP_RED_FLAG_PREFIX) is
// registered in RULE_FINDING_PREFIXES, and its item is banded "today" so it reaches
// the hero. It is NOT part of collectCoachingFindings. It reuses the Upcoming
// "illness-care" domain (both are illness care-tier findings) so the exhaustive domain
// Record is untouched; the dedupeKey prefix still distinguishes the two on the bus.

import {
  assembleIllnessEpisode,
  episodeForProfileDate,
} from "./illness-episode";
import { isOpenEpisode } from "./illness-episode-format";
import { profileAgeMonths } from "./settings";
import {
  detectEpisodeTempRedFlag,
  tempRedFlagEvidence,
  tempRedFlagFullDetail,
  type TempRedFlagDisplay,
  type TempRedFlagFinding,
} from "./temp-red-flag";
import type { Finding } from "./findings";
import type { UpcomingItem } from "./upcoming";
import { episodeHref, type AppRoute } from "./hrefs";

// The current OPEN illness episode assembled as of `date` (the #801 gather), or null.
function openEpisodeAsOf(profileId: number, date: string) {
  const ep = episodeForProfileDate(profileId, date);
  if (!ep) return null;
  const assembled = assembleIllnessEpisode(profileId, ep);
  return isOpenEpisode(assembled) ? assembled : null;
}

// The ONE gather: the red flag the profile's current open episode's latest reading
// crosses, as a neutral TempRedFlagFinding, or null. Every surface formats over
// THIS. `display` is how the app-authored temperature clause renders (#1019): web
// boundaries pass the viewer's login unit, the Telegram nudge passes "dual";
// identity (dedupeKey) is display-independent, so the shared dismissal bus is
// untouched.
export function tempRedFlagFindingFor(
  profileId: number,
  date: string,
  display: TempRedFlagDisplay = "F"
): TempRedFlagFinding | null {
  const episode = openEpisodeAsOf(profileId, date);
  if (!episode) return null;
  return detectEpisodeTempRedFlag(episode, {
    ageMonths: profileAgeMonths(profileId, date),
    display,
  });
}

// The action link every surface shares: the current open episode's detail page.
function actionHrefFor(profileId: number, date: string): AppRoute {
  const episode = openEpisodeAsOf(profileId, date);
  return episode?.id != null ? episodeHref(episode.id) : "/timeline";
}

// One neutral finding → the shared care-tier Finding envelope. Caution tone; the
// source + "not medical advice" tail rides `evidence`, the fact + line rides `detail`.
function toFinding(
  f: TempRedFlagFinding,
  href: ReturnType<typeof episodeHref>
): Finding {
  return {
    domain: "temp-red-flag",
    dedupeKey: f.dedupeKey,
    title: f.title,
    detail: f.detail,
    tone: "caution",
    evidence: tempRedFlagEvidence(f),
    actionHref: href,
    actionLabel: "View episode",
  };
}

// The temperature red-flag findings for a profile as care-tier Findings (for the #448
// reflection guard + any Finding-typed surface). Reads through the profile-scoped #801
// assembly. Returns 0 or 1 finding (the latest reading crosses at most one rule).
export function buildTempRedFlagFindings(
  profileId: number,
  date: string,
  display: TempRedFlagDisplay = "F"
): Finding[] {
  const f = tempRedFlagFindingFor(profileId, date, display);
  if (!f) return [];
  return [toFinding(f, actionHrefFor(profileId, date))];
}

// The temperature red-flag findings as Upcoming items → the Upcoming page AND the
// non-hideable Needs-attention hero. Banded "today" like the other care-tier findings,
// keyed by the SAME dedupeKey so a dismiss on any surface silences it. Reuses the
// "illness-care" Upcoming domain (see the module header).
export function tempRedFlagItems(
  profileId: number,
  date: string,
  display: TempRedFlagDisplay = "F"
): UpcomingItem[] {
  const f = tempRedFlagFindingFor(profileId, date, display);
  if (!f) return [];
  const href = actionHrefFor(profileId, date);
  return [
    {
      key: f.dedupeKey,
      domain: "illness-care" as const,
      title: f.title,
      detail: tempRedFlagFullDetail(f),
      href,
      dueDate: null,
      band: "today" as const,
      dueText: "Review",
    },
  ];
}
