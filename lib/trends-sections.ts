// The Trends LANDING SURFACE's anchored parts (issues #1644, #1632).
//
// #1644 merged the Body tab into Overview: `/trends` (the default view, still
// labelled Overview) is now the trending digest, then the cross-domain **starred
// grid**, then the **body census** streamed below them. This module names those
// anchored parts — nothing else.
//
// #1632 adds a THIRD, between the grid and the census: the **wellness lens** —
// per-practice weeks-in-range, cadence against the declared min–max band, and the
// duration trend for the modalities that record one. It is an anchored part of
// this surface, NOT a fifth tab: the four tabs are permanent by owner ruling, and
// neither surviving tab fits a practice (Fitness is wholly age-gated training
// content; a meditation habit is neither training nor nutrition). It sits above
// the census because it is small, entirely conditional — nothing renders for a
// profile with no tracked practice — and would otherwise be buried under the
// domain census that deliberately reads last.
//
// It is deliberately NOT a tab registry, and deliberately not a general "sections"
// vocabulary. `lib/trends-tabs.ts` owns which TABS exist (Overview · Fitness ·
// Nutrition · Insights, permanent by owner ruling); this owns where the parts
// of the landing surface live so a deep link can name one of them. Two registries
// because they answer two different questions, and keeping them apart is what
// stops "add a section" from quietly becoming "retire another tab".
//
// The curation contract stays with the GRID (#1487/#1456): the starred grid renders
// nothing unconditionally, while the census below it renders everything for the
// domain, exactly as the Body tab did.

import type { AppRoute } from "./hrefs";

// The anchored parts, in reading order. The ids ARE the DOM `id`s the page renders
// and the `#fragment`s links use — the same id→anchor convention the Body chart
// stack (#1067) and the Fitness sections (#1492) already use one level down.
export const TRENDS_LANDING_SECTIONS = [
  "starred",
  "practices",
  "body",
] as const;

export type TrendsLandingSection = (typeof TRENDS_LANDING_SECTIONS)[number];

// A deep link INTO one part of the landing surface — the successor to every
// `/trends?tab=body` literal (#1644). A rule-carrying helper in the #285 sense: the
// anchor id is the section id, and one edit here re-points every dashboard tile,
// finding CTA, palette action and integration link at once.
//
// There is no `?tab=` in it and no shim behind it: the census these links used to
// name is on the default view now, so the ANCHOR is the whole address.
export function trendsSectionHref(id: TrendsLandingSection): AppRoute {
  return `/trends#${id}` as AppRoute;
}
