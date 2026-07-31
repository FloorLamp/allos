# Server Actions and `router.refresh()`

Status: shipped

The rule, in one line: **an awaited Server Action that calls `revalidatePath` (or
`revalidateTag`) already repaints the page the caller is looking at, so a
`router.refresh()` after it is a second full fetch of the same page.** Decided and
applied codebase-wide in #1473.

## Why — the mechanism, not a vibe

This is a property of Next.js's action handler, verified against the version this
repo pins (`next` 16.2.x). Three facts, each readable in `node_modules/next`:

1. `revalidatePath()` sets `workStore.pathWasRevalidated` **regardless of which
   path was passed**. The path argument only picks which cache tags get expired;
   it does not gate whether the current page re-renders. (Next's own source
   carries a `// TODO: only revalidate if the path matches` right above that
   assignment — `server/web/spec-extension/revalidate.js`.)
2. When `pathWasRevalidated` is set, the action handler does **not** skip page
   rendering: it re-renders the current page tree and ships that Flight data in
   the action response, with an `x-action-revalidated` header
   (`server/app-render/action-handler.js`).
3. The client's server-action reducer applies that response as a seeded
   navigation with `FreshnessPolicy.RefreshAll`, and evicts the prefetch cache
   (`client/components/router-reducer/reducers/server-action-reducer.js`). Every
   action call goes through this path — Next wraps `callServer` in
   `startTransition` itself, so it does not matter whether the caller used a
   form action, a transition, or a bare `await` in an event handler.

So `await someAction(fd); router.refresh();` renders the page **twice**: once in
the action response the client already has, once more because it was asked to.
On the dashboard — the heaviest page — that doubled post-write work is what made
`checkin-card:94` flaky under load (see #1464 / #1472: the write landed in
~640 ms; the redundant re-render is what blew the assertion budget).

## The convention

**Do not call `router.refresh()` after awaiting a Server Action that revalidates.**

A `router.refresh()` is only correct when the repaint has no action response
behind it. In practice that is one of:

- **Not a Server Action at all.** The write went through a route handler via
  `fetch()` (`TakeoutUpload`, `OfflineQueueProvider`'s `/api/offline-replay`).
- **Poll-driven.** A background job changed rows and a toaster noticed by polling
  a read action (`ImportJobsToaster`, `ExtractionToaster`).
- **User gesture.** `PullToRefresh` — there is no action, the gesture _is_ the
  request.
- **An action that deliberately does not revalidate** but still writes something
  the current page renders. `sendTestEmail` is the live example: it persists the
  SMTP form through `saveSmtpConfigSync` and skips `revalidatePath` on purpose.
  So are `applyReprocessPreview` and `reprocessDocumentFromRaw`.

Every surviving call site carries a one-line comment naming which of these it is.
If you add one, add the comment; a bare `router.refresh()` after an action reads
as an oversight.

## Reviewing a removal

The argument for deleting a `router.refresh()` is **the action's own
`revalidatePath` call**, not the shape of the code around it. Concretely:

- Follow the awaited call to its `"use server"` module and confirm it calls
  `revalidatePath`/`revalidateTag` on the success path.
- If the component takes the action as a **prop**, check _every_ caller. The
  record forms (`ConditionForm`, `AllergyForm`, …), `PhotoPicker`,
  `VideoClipGrid`, `useUndoableDelete` and friends all rely on this.
- Watch for a handler that awaits _two_ actions: the revalidated tree is rendered
  when the **first** one runs. If a later, non-revalidating action writes
  something the page shows, that write is not in the tree and the refresh stays.
  That is exactly the SMTP case.
- An early `return` before `revalidatePath` is fine when it is a refusal path —
  nothing was written, so nothing needs repainting.

## What did _not_ change

`revalidatePath(X)` still has to name the routes that actually render the changed
data. Removing the client refresh does not make the path argument cosmetic: it is
what keeps **other** routes' cache entries honest for the next navigation to
them. `app/(app)/results/imaging/actions.ts` carries the worked example.
