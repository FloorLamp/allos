import type { AppRoute } from "./hrefs";

// The Trends landing surface has one anchored census beneath its conditional
// movers head (#3387). `starred` remains a legacy fragment alias at the same DOM
// position so saved links do not dangle; it is not a second section.
export const TRENDS_LANDING_SECTIONS = ["body"] as const;
export type TrendsLandingSection = (typeof TRENDS_LANDING_SECTIONS)[number];
export type TrendsLandingAnchor = TrendsLandingSection | "starred";

export const TRENDS_LANDING_ALIASES = {
  starred: "body",
} as const satisfies Record<string, TrendsLandingSection>;

export function trendsSectionHref(id: TrendsLandingAnchor): AppRoute {
  return `/trends#${id}` as AppRoute;
}
