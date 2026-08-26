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

## Beyond the nav rows (#2869)

The doctrine above covered exactly three components — `Nav`, `MobileDock`,
`SegmentedControl`, all through `PendingNavLink`. The live report that produced
#2869 was that everything else is still silent on spotty internet, and that a
navigation whose fetch dies takes the working page with it. Both halves are
answered here; neither introduces a second mechanism.

### One primitive, two slots

`components/PendingLink.tsx` now owns the two guarantees, and `PendingNavLink`
is one of its callers rather than the place they live. A surface adopts the
doctrine by picking which of two pending TREATMENTS its shape has room for:

- **`PendingIconSlot`** — the control already has an icon; the spinner replaces
  it in place. This is #1956's original treatment (nav rows, the dock, the
  timeline's day arrows).
- **`PendingOverlay`** — the control is text; its own label is the slot. The
  label stays exactly where it is, still legible at reduced opacity, with the
  spinner over it. Nothing shifts, and nothing useful is erased.

Both are the same rule — the spinner paints in the control's own slot — differing
only in which slot the control has. The `sr-only` `role="status"` naming and the
`isDuplicateNavClick` absorption come from the primitive, identically for every
caller, so a new surface cannot adopt half the doctrine.

### The census

The button-shaped navigation controls in the app, and what each one does now:

| Surface                                                                               | Treatment                                                       |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `components/Nav.tsx` sidebar/drawer rows                                              | icon slot (#1956)                                               |
| `components/MobileDock.tsx` dock slots                                                | icon slot (#2651)                                               |
| `components/SegmentedControl.tsx` tabs                                                | icon slot (#1956)                                               |
| `components/TimelineDayNav.tsx` day arrows                                            | icon slot (the chevron)                                         |
| `components/TimelineDayNav.tsx` day swipe                                             | the same chevron, driven by the component's own `useTransition` |
| `components/PaginationControls.tsx` link-mode Prev/Next (every pager in the app)      | overlay                                                         |
| `components/TimelineFilterLink.tsx` chips, range pills, #2657 month fold headers      | overlay                                                         |
| `components/ui.tsx` `EmptyState` next-action buttons (#2983)                          | overlay                                                         |
| `components/StatBox.tsx` linked value (#2983)                                         | overlay                                                         |
| `app/(app)/training/OverviewSection.tsx` next-workout CTA (#2983)                     | overlay                                                         |
| `app/(app)/training/OverviewSection.tsx` fitness-check strip door (#2983)             | overlay                                                         |
| `app/(app)/training/activity/[id]/ActivityLedgerNav.tsx` back / older / newer (#2983) | icon slot (the chevron)                                         |
| `app/(app)/training/activity/ActivityRecord.tsx` pane "Open" (#2983)                  | icon slot (the arrow)                                           |

`label` is a lower-case noun phrase naming the DESTINATION, not the control's
visible text: "previous page", "workout details", "older activity". Two shared
components cannot know their destination and name their own slot instead —
`StatBox` announces the tile ("Opening last trained") and `EmptyState` announces
the action it offers.

Everything else — cards, table rows, drill-downs, links inside a sentence, the
~100 files that import `next/link` directly — is covered by the floor below, on
purpose. A link inside a sentence has nowhere to put a spinner, and giving each
of them one is how an app ends up with six pending styles. The training rows the
#2983 sweep looked at and LEFT on the floor are the shape of that line: the
recent-sessions date cells in `ExerciseDetailPanel`/`SportDetailPanel` (a cell in
a row), the Training Log card's title link into a ride (the card's own heading),
`ActivityCardMenu`'s "View ride details" (a menu item that unmounts on the click
that would make it pending), and `TrainingLogRow` — which navigates nowhere at
all: it opens the reading pane or expands in place, so there is no transition for
`useLinkStatus` to report.

The shared query-tab strip (`components/TabList.tsx`) is also still floor-only.
Every hub in the app renders through it, so adopting the doctrine there is an
app-wide change to tab behaviour rather than a training one, and it is the
owner's call rather than a sweep's.

The two settings pagers are GONE as a separate shape (#3378). They used to be a
second spelling of "there is more" beside `PaginationControls` — adopting the
pending primitive but not the pager — and the copy-and-layout change that kept
them apart was answered when the pager grew its phone shape: `/settings/audit`
and `/settings/notify-log` now render `PaginationControls`, so its row above
covers every pager in the app and this list has one pager entry instead of
three.

### The raw anchors (#2983)

Four in-app destinations were still reached through a raw `<a href>` rather than
`<Link>`: the training overview's "next workout" CTA, `StatBox`'s linked value
(the door into a ride and into a session's activity page), and the recent-session
date cells in `ExerciseDetailPanel` and `SportDetailPanel`. Each was a FULL
DOCUMENT LOAD out of the app shell, which is a correctness defect rather than a
polish one: the running client is thrown away, none of the machinery above
applies — no in-control pending, no indicator, no fetch guard — and on a dead
network the service worker answers that document load with `/offline`. That is
exactly the outcome the invariant above forbids. All four are soft navigations
now; the two that are button-shaped also took a pending treatment, and the two
that are row cells stayed on the floor.

### The floor: one indicator, with a threshold

`lib/nav-progress.ts` + `components/NavProgress.tsx`. A thin top-edge line
appears when any navigation is still pending past 300 ms and clears at commit.

- The START is `onRouterTransitionStart` in `instrumentation-client.ts` — Next
  16's first-class hook, which fires for every push, replace and back/forward
  traversal, whatever started it. There is no React-level equivalent:
  `useLinkStatus` resolves for one link at a time by design.
- The END is the commit, observed by `usePathname()`/`useSearchParams()` in the
  component. Next ships no completion hook. The one case this leaves is a
  navigation to the URL already on screen, which cannot move either — it clears
  on the next navigation and paints nothing meanwhile.
- It does NOT animate a fraction. There is no progress to report — no Suspense
  boundaries to count (#530), no streamed percentage — so a bar creeping toward
  90% would be an invented number. It is present or absent, and a `role="status"`
  line says which. Nothing new was added to the micro-motion registry.
- The threshold is what keeps it from being noise. A navigation that commits
  under it paints nothing at all, so a fast connection never sees a flash. That
  rule is pure and tested as one; it is deliberately NOT asserted in the browser,
  where the claim would be about the shard's wall clock rather than the rule.

This is client chrome, not a Suspense shell. #530 is untouched.

### A failed navigation stays in the app

`lib/nav-fetch-guard.ts`. During a soft navigation the old page never left the
screen. If the destination's RSC read then dies, Next 16.3.0 logs "Failed to
fetch RSC payload … Falling back to browser navigation." and hard-navigates to
the same URL — and on a dead network the service worker answers that document
load with the precached `/offline` page. Either branch throws away a page that
was working. `app/(app)/error.tsx` never sees it: that boundary catches render
throws, not failed navigation fetches.

The guard wraps `window.fetch` from `instrumentation-client.ts` and matches only
a navigation RSC read — a GET carrying `RSC: 1` and no `Next-Router-Prefetch`.
It retries on a bounded budget (400 ms → 1.2 s → 3 s), and if that is spent while
someone is actually waiting on the navigation it HOLDS the promise instead of
rejecting, and turns the indicator into "Couldn't load — check your
connection." with a Retry. Rejecting is what Next converts into the hard exit, so not
rejecting is the whole fix. The navigation is paused, not abandoned: Retry — or
the browser reporting the connection back — resumes the same fetch, so the tap
they already made is the tap that lands.

A read nobody is waiting on (a poll-driven `router.refresh()`, a prefetch) is
retried but never held and never painted. Turning a polling miss into a banner
would make the banner meaningless.

`/offline` is unchanged and still right where it belongs: a cold start with no
page to stay on.

#### Why not `experimental.useOffline`

#2869 named Next's own wait-and-retry as the first lever to evaluate, and for
navigation it fits exactly. It was **not** adopted, because the flag is not
scoped to navigation. The same build-time flag wraps the Server Action fetch
(`router-reducer/reducers/server-action-reducer.js`): a rejected action would
wait for connectivity and retry rather than throwing. This app's offline write
queue (#28) is built on that throw — `shouldQueueOffline` in `lib/offline/queue.ts`
reads the `TypeError` a dead connection produces as the signal to queue the
write, and every quick-log surface enqueues from that catch. Under `useOffline`
an offline dose tap would produce no queue entry, no queued badge and no toast;
it would simply never finish. #2869's own invariant is that write-path feedback
stays untouched, so the lever was taken at the one layer where a navigation read
and a write are distinguishable: GET with `RSC: 1` versus POST.

### Contract

`e2e/nav-pending.spec.ts` and `e2e/nav-pending.mobile.spec.ts` hold the
destination's navigation RSC response — distinguished from the prefetch of the
same URL by the `next-router-prefetch` header — and, for the failure leg, abort
it until the test restores the connection. The failure test asserts the three
things that must NOT happen: the document was never torn down, the URL never
moved, and `/offline` was never served while the tab still held a working page.
