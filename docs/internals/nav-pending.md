# Navigation feedback

Status: shipped

Why a sidebar tap has to show something, and why a second tap has to do nothing.

## The window this exists to close (#1956)

The reported symptom was that for six to twelve seconds after the dashboard
rendered, every sidebar link "swallowed taps": the nav was painted, the links
carried correct `href`s, and tapping one did nothing at all.

Instrumenting the click path showed the taps were **not** swallowed:

- `<Link>` intercepted every one of them — `defaultPrevented === true` on a
  window-level listener registered after React's root container.
- The App Router issued the destination's RSC request about 20ms after each
  tap, and had a 200 back inside 100ms.
- Clicked **once** and never again, every measured link committed. At 6× CPU
  throttle: Training 6.2s, Nutrition 5.4s, Timeline 7.1s, Upcoming 6.1s from
  page entry. The same links under a click-until-the-URL-moves loop on the same
  box: 6.7s, 6.7s, **10.1s**, 6.6s.

So the router was ready and did service the navigation. Two things made it look
otherwise, and they compound:

1. **The transition is invisible.** `app/(app)/` ships no `loading.tsx`
   anywhere, deliberately — see the long comment in `app/(app)/layout.tsx` and
   issue #530. Without a route-segment Suspense boundary there is no fallback
   for the App Router to reveal, so React renders the entire destination inside
   the transition and swaps only at commit. Until then the old page is on
   screen, unchanged and fully interactive. Nothing says "I heard you".
2. **The next tap restarts it.** Every tap dispatches a fresh navigation, and
   React discards the transition render already in progress. Five taps on
   Timeline produced five separate RSC requests in the trace. At a
   tap-a-second cadence against a destination that takes about a second to
   render, the navigation can be restarted indefinitely — the impatience the
   silence provokes is what prevents the navigation from landing.

## What nav rows do now

`components/PendingNavLink.tsx` is the one nav-row affordance, used by
`components/Nav.tsx` for every leaf — which both the desktop sidebar and the
mobile drawer render through the shared `SidebarContent`, so the two viewports
cannot drift — and, since #2651, by the phone's bottom dock
(`components/MobileDock.tsx`) for each of its four destination slots. A dock slot
is if anything MORE exposed to the silence above than a sidebar row, because it
is reachable without opening anything; the spinner takes the icon's own slot, so
nothing shifts in a 56px-tall bar. The dock's "More" slot is NOT a nav row — it
is a disclosure that opens the same drawer — so it is a plain button with
`aria-expanded` and no `aria-current`.

- **Feedback comes from `useLinkStatus()`**, Next's per-link transition status.
  It works with no `loading.tsx` present, which is precisely what it was added
  for. The status flips in the same commit that starts the navigation: measured
  ON 69ms after the tap and still on past the URL commit, until the destination
  paints. The spinner replaces the row's icon in its own slot, so nothing
  shifts, and an `sr-only` `role="status"` names the row ("Opening Timeline")
  rather than announcing an anonymous spinner.
- **A repeat tap is absorbed, not re-dispatched.** `lib/nav-click.ts` owns that
  decision. It is pure and tested because the tempting shortcut — disabling the
  row, or `preventDefault`ing every click while pending — would also refuse a
  cmd/ctrl/shift/alt-click and a middle-click, which mean "open this beside the
  page I am on" and never touch the navigation in this document.

Two implementation notes that cost a measurement to learn:

- `useLinkStatus` resolves only **inside** a `<Link>` subtree, so the pending
  state is read by a child and handed back to the row for the click guard.
- That hand-back is an **effect, not a render-phase write**. `useLinkStatus` is
  backed by `useOptimistic`, so React renders the subtree speculatively both
  with and without the optimistic value; a render-phase write records whichever
  pass ran last rather than the one that committed. With the render-phase write
  the repeat taps still dispatched four navigations. With the effect they
  dispatch one.

## What this does and does not fix

It closes the reported window: there is no state in which tapping a nav row
produces no feedback. Before the App Router mounts, `<Link>` does not intercept
at all (it returns early on a null router, so no `preventDefault` runs) and the
anchor's real `href` performs an ordinary browser navigation; after it mounts,
the tap flips the row to pending. And a navigation can no longer be restarted
by tapping, so the first tap is the one that lands.

It does **not** make the destination render faster. That cost is real — a
dynamic server render plus a client transition with no Suspense boundary to
break it up — and it is now visible instead of silent. Shortening it is a
separate question, and the obvious lever (`loading.tsx`) is the one #530 rules
out.

## Contract

`e2e/nav-pending.spec.ts` holds the destination's **navigation** RSC response —
distinguished from `<Link>`'s prefetch of the same URL by the
`next-router-prefetch` header — until the test releases it. That makes the
window deterministic instead of racing an idle box, and lets the spec assert
both halves: the row reports pending while the page has demonstrably not moved,
and five taps produce exactly one navigation.

`followLink` is deliberately not used there. Its retry loop exists to survive
the pre-hydration window, and a retrying helper cannot tell a tap that was
answered from one that was not.
