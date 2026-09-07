# Navigation feedback

Keep the current page usable while a destination loads. Give an accepted tap
visible feedback, absorb repeated navigation taps, and preserve ordinary browser
link behavior for modified clicks and new tabs.

## Control feedback

[PendingLink](../../components/PendingLink.tsx) owns per-link feedback through
Next's `useLinkStatus()`, the repeat-click guard, and the named status announcement.
Its child reads link status and reports the committed value through an effect;
a render-phase write can record a discarded optimistic render.

Use its existing presentations:

- [PendingNavLink](../../components/PendingNavLink.tsx) for sidebar, drawer, and
  dock rows: replace the icon in its existing slot and keep the label visible.
- `PendingIconSlot` for controls with an icon slot, such as day arrows or tabs.
- `PendingOverlay` or `PendingTextLink` for button-shaped links without an icon
  slot. Keep their dimensions and readable content while pending.

[nav-click.ts](../../lib/nav-click.ts) decides which repeated clicks to absorb.
Do not disable the anchor or block every click while pending: modified clicks,
middle clicks and other browsing contexts keep their native behavior.
The dock's **More** button is a disclosure, not a navigation link.

Use soft navigation for in-app page destinations. Raw document links discard the app shell
and its pending/failure handling. Ordinary inline links and row destinations can
use the shared top-edge indicator without acquiring their own spinner.

## Global progress and completion

[nav-progress.ts](../../lib/nav-progress.ts) is the single external store read by
[NavProgress](../../components/NavProgress.tsx). It has four phases:

| Phase     | Display                                                           |
| --------- | ----------------------------------------------------------------- |
| `idle`    | Nothing is loading.                                               |
| `waiting` | Navigation started; nothing paints yet.                           |
| `slow`    | A top-edge line and “Still loading” status after 300 ms.          |
| `failed`  | Connection failure with a Retry action; the current page remains. |

The line indicates waiting, not a percentage. Fast navigations finish before the
threshold and show nothing. Keep the existing no-route-loading-shell contract;
this feedback does not require a `loading.tsx` boundary or make rendering faster.

[instrumentation-client.ts](../../instrumentation-client.ts) installs observers
before the router starts and calls `startNavProgress()` from
`onRouterTransitionStart`. This covers links, imperative push/replace, and history
traversal.

Completion follows the router's **history commit**, not a changed pathname or
query string. Next writes an explicit URL through `pushState` or `replaceState`
when committing, including a same-URL refresh. `installNavProgress()` observes
those calls while preserving their arguments, receiver, and native errors.
History entries without a URL, used for Back-to-close overlays, do not complete a
route. Notify store subscribers in a microtask after the router's insertion
effect; discard that notification if a newer navigation has started.

This integration depends on Next continuing to commit routes through History.
Keep the browser regression when upgrading the router. Do not replace it with a
pathname-only effect: the URL can remain unchanged after a successful navigation.
The store owns progress and retry state; controls do not create separate timers
or completion rules.

## Failed navigation reads

[nav-fetch-guard.ts](../../lib/nav-fetch-guard.ts) wraps `window.fetch` before the
router issues requests. It handles GETs with `RSC: 1` and no
`Next-Router-Prefetch` header. Prefetches, Server Action POSTs, and other fetches
pass through unchanged.

For a matching network failure (`TypeError`), retry after 400 ms, 1.2 s, and 3 s.
Cancellation and HTTP error responses keep their ordinary behavior. After the
retry budget:

- If navigation is idle, reject normally; a background refresh does not raise a
  navigation banner.
- If a navigation is pending, hold its promise and show the failure state.
  Rejecting here would let Next fall back to a full document navigation and
  discard the working page.

Retry or the browser's `online` event resumes the held read with a fresh retry
budget. The existing tap then finishes. A newer navigation supersedes the old
progress state and its retry waiter; the old held promise stays parked. There is
one current navigation state, not a queue of retry banners.

`/offline` remains the cold-start fallback when no working page is available.
Keep navigation read recovery separate from offline writes. The app's write queue
uses rejected Server Actions to offer queued feedback; adopting a framework-wide
wait-and-retry mode must not suppress that path.

## Verification

- [nav-click tests](../../lib/__tests__/nav-click.test.ts) cover click semantics.
- [nav-progress tests](../../lib/__tests__/nav-progress.test.ts) use controlled
  time for the threshold, phase changes, retry ownership, and queued completion.
- [nav-fetch-guard tests](../../lib/__tests__/nav-fetch-guard.test.ts) cover request
  classification, bounded retries, and held reads.
- [Desktop](../../e2e/nav-pending.spec.ts) and
  [mobile](../../e2e/nav-pending.mobile.spec.ts) browser tests hold the destination's
  navigation RSC response, excluding prefetches. They prove feedback before
  completion, repeat-tap absorption, same-URL completion, swipe behavior, and
  recovery without replacing the current page.

Use `hydratedClick` for the one-tap navigation checks. `followLink` can retry a tap,
which would mask the behavior these tests measure. Assert the global indicator
clears after a held response is released; do not demand that an uncontrolled
browser render finishes below the 300 ms threshold. Follow the
[E2E writing guide](e2e-hygiene.md) for fixture and interaction ownership.
