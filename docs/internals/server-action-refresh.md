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

## The complement: when a refresh may _land_ (#1878)

The rule above governs whether a refresh should exist. It says nothing about
**timing**, and a perfectly correct background refresh can still re-render the
Server Components underneath a record form the user is halfway through filling.
That is issue #1878, and the observed casualty (#1552 → #1877) was the Add-visit
form saving an appointment **titleless**.

The fix is a **dirty-form registry**: `lib/dirty-forms.ts` holds the decision,
`components/DirtyFormRegistry.tsx` is the DOM binding, and it is mounted once in
the authenticated shell. Chrome refreshes defer while any form holds unsaved
input and run when the last one releases.

### Chrome-initiated is an opt-in, never a heuristic

A background actor calls `useChromeRefresh()`; everything else keeps calling
`router.refresh()`. The split is not a judgement the registry makes — it is a
declaration each call site makes, and `lib/__tests__/chrome-refresh-scan.test.ts`
fails on any `router.refresh()` that has not been classified.

| bucket | sites                                                                                         | behaviour                    |
| ------ | --------------------------------------------------------------------------------------------- | ---------------------------- |
| chrome | `OfflineQueueProvider`, `ImportJobsToaster`, `ExtractionToaster`                              | defers while a form is dirty |
| user   | `PullToRefresh`, `ReprocessDiffPanel`, `ImportDetailActions`, `SmtpSettings`, `TakeoutUpload` | never defers                 |

`PullToRefresh` is the clearest of the user bucket: the gesture's entire meaning
is "give me current data", and quietly ignoring it because some form is dirty
would be a worse bug than the one being fixed. The same logic keeps the repaint
that follows the **user's own submit** out of the registry — `ReprocessDiffPanel`
is that case, and deferring it would leave someone staring at the rows they just
asked to replace.

### Deferred is never dropped

The state remembers that a refresh is **owed** and runs it on release. Several
owed refreshes coalesce into one (a repaint is idempotent; running it N times is
the doubled fetch this document exists to prevent). While anything is owed the
registry re-checks the forms once a second, so an autosave form whose write lands
after its own blur still releases without waiting for the next keystroke.

### Dirty means edited, not focused and not mounted

A field counts only once the user has actually edited it, only while it differs
from what it held before that edit, and only while it differs from the value the
server last rendered into it. A form that registered on mount and never released
would suppress every background refresh for the life of the page — a cure worse
than the disease.

### Two measured facts worth keeping

Both were measured against the version of Next this repo pins, driving the real
app in Chromium, and both bound what this fix can claim:

1. **React preserves an uncontrolled input across an RSC re-render.** A chrome
   `router.refresh()` on `/records/history/visits` leaves the `<input>` node
   itself in place with its typed value intact. The wipe therefore needs the
   form's subtree to be **unmounted**, not merely re-rendered — which is what the
   #1877 artifact had, and what makes the failure rare and silent rather than
   constant.
2. **`router.refresh()` is not the only way a chrome tick repaints the page.**
   The toasters poll through a Server Action, and that action's response carries
   a freshly rendered tree which the client applies — with no `router.refresh()`
   involved. So a background poll can still deliver new server data underneath a
   dirty form even while its explicit refresh is deferred. Gating the poll itself
   is a separate, larger decision (it would also delay telling the user their
   import finished) and has deliberately **not** been taken here.
