// Client instrumentation, loaded by Next before the app becomes interactive.
//
// Two jobs, both from #2869, and both have to happen out here rather than in a
// component:
//
//  1. `installNavFetchGuard()` wraps `window.fetch` so a navigation whose RSC
//     read dies on a flaky connection is retried and then HELD, instead of
//     rejecting into Next's hard "fall back to browser navigation" path that
//     tears down the working page you are looking at. It has to be installed
//     before the router issues its first fetch, which is what this file is for.
//
//  2. `onRouterTransitionStart` is Next 16's first-class hook for the START of
//     an App Router navigation — every `<Link>` tap, every `router.push` (the
//     timeline's day swipe), and every back/forward traversal, whether or not
//     the control that started it has a pending slot of its own. It is the only
//     signal the global slow-navigation indicator could be built on: React has
//     no router-level "a transition began" event, and `useLinkStatus` resolves
//     for one link at a time by design.
//
// Completion is NOT hooked here, because there is no completion hook: the
// navigation is done when the destination COMMITS, and the component that
// paints the indicator observes that directly (components/NavProgress.tsx).

import { installNavFetchGuard } from "@/lib/nav-fetch-guard";
import { startNavProgress } from "@/lib/nav-progress";

installNavFetchGuard();

export function onRouterTransitionStart(): void {
  startNavProgress();
}
