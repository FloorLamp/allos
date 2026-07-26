// The app-icon badge decision (issue #1424, section B).
//
// `navigator.setAppBadge(n)` paints a count on the installed PWA's home-screen
// icon. The COUNT is not computed here and never will be: it is the care-tier
// "Needs attention" number the dashboard hero already renders
// (`attentionCardItems(items, today).length`, over `collectAttentionModel` —
// the #449 care tier), handed to `components/AppBadge.tsx` as a prop. This
// module owns only the tiny decision the platform API forces — set N, or clear —
// so that decision is pinned by a unit test instead of living inside an effect.
//
// Why a "clear" case at all: the Badging API has no "set to zero". Calling
// `setAppBadge(0)` shows a DOT on some platforms (a flag, not a count), which
// would leave a resolved-everything user staring at a permanent mark. Zero must
// route to `clearAppBadge()`.
//
// Freshness is deliberately last-open only (stated limitation, v1): nothing here
// runs while the app is closed, so the badge reflects the last dashboard render.
// Proactive alerting belongs to the push/Telegram channels; wiring badge updates
// into the Web Push service-worker handler is a noted follow-up, not this issue.

export type AppBadgeAction = { kind: "set"; count: number } | { kind: "clear" };

export function appBadgeAction(count: number): AppBadgeAction {
  // Defensive on non-finite/negative: a badge is a user-visible artifact of a
  // number that crossed a client boundary, and "NaN" on a home screen is worse
  // than no badge.
  if (!Number.isFinite(count) || count <= 0) return { kind: "clear" };
  return { kind: "set", count: Math.floor(count) };
}
