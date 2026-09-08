# Server Actions and `router.refresh()`

Status: shipped

An awaited Server Action that calls `revalidateRoute` already updates the current
page through its action response. Do not follow it with `router.refresh()` unless
a later write needs a separate update.

## Revalidation owner

Use [revalidateRoute](../../lib/revalidate.ts) for one route or an array of routes.
It forwards to Next's `revalidatePath` and checks targets against generated route
types. Use `"page"` for a dynamic route pattern such as `/import/[id]`; use
`"layout"` only when broad invalidation is intended. `revalidateTarget` checks a
dynamic target before storing it in a declared list.

Name the routes that render the changed data. Updating the current action
response does not make those targets optional: they also invalidate cached data
for later navigation to other routes.

In the installed Next version, path revalidation marks the action as revalidated
regardless of whether the target matches the current page. The action handler
renders updated page data, and the client applies it through the server-action
reducer. An additional refresh requests that page again.

This is not a blanket guarantee for `revalidateTag`: stale-while-revalidate
profiles do not necessarily mark the action for an immediate page update. When
changing that behavior or upgrading Next, check these installed source files
under `node_modules/next/dist/`:

- `server/web/spec-extension/revalidate.js`: path and tag invalidation.
- `server/app-render/action-handler.js`: `skipPageRendering` and action responses.
- `client/components/router-reducer/reducers/server-action-reducer.js`: applying
  returned page data.

## Deciding whether a refresh is needed

| Trigger                                        | Refresh rule                                             |
| ---------------------------------------------- | -------------------------------------------------------- |
| Action calls `revalidateRoute` after its write | No additional client refresh.                            |
| Write through a JSON route handler             | Refresh if the visible page needs the result.            |
| Poll observes completed background work        | Request a background refresh through `useChromeRefresh`. |
| Explicit pull-to-refresh gesture               | Refresh directly; the gesture requests current data.     |
| Action writes without revalidating             | Refresh if that write affects the visible page.          |

Before removing a refresh, follow the awaited call to its server implementation
and verify revalidation on the relevant write path. For an action supplied as a
prop, check every caller. For several sequential actions, the page data returned
by the first cannot include a later write. A refusal before any write needs no
update; do not assume every error path is write-free.

`sendTestEmail` is a deliberate exception: it saves the SMTP configuration without
revalidating, so its caller refreshes to show the saved settings.

## Background refresh timing

A necessary background refresh can still arrive while someone is editing.
[DirtyFormProvider](../../components/DirtyFormRegistry.tsx), mounted in the
authenticated shell, schedules these requests using the state machine in
[dirty-forms](../../lib/dirty-forms.ts).

Background actors call `useChromeRefresh()`. A necessary user-requested refresh
calls `router.refresh()` directly and is not deferred. The existing ESLint rule
requires direct calls under `app/` and `components/` to explain that classification
on their disable line. Calling something user-initiated does not justify an
otherwise redundant refresh.

The registry tracks edited, named form controls. A field is dirty while its value
differs from both its pre-edit baseline and its confirmed server value. Focus or
mount alone does not make a form dirty. For controlled autosave fields, publish
`data-server-value` from the confirmed saved value: React's mirrored `defaultValue`
cannot distinguish a pending edit from a successful save.

While a tracked form is dirty, requests accumulate as owed work. When the last
form releases, they produce one refresh. Release can follow submit, reset,
restoring a clean value, or unmount. While work is owed, a one-second recheck
also releases forms whose autosave completed after blur. The provider uses a
transition and delays a submit-triggered refresh until the next task so React can
collect the form data first.

The provider also exposes subtree discard checks that combine `data-unsaved`
declarations with tracked fields. Those checks are separate from the background
refresh state machine; a declaration alone does not register a dirty control.
Likewise, draft recovery affects automatic-update protection, but does not exempt
a tracked dirty form from refresh deferral. Outside the provider,
`useChromeRefresh()` falls back to an immediate transition without this protection.

## Observe jobs without refreshing the page

Background actors fetch JSON route handlers and request repaint separately through
`useChromeRefresh()`. A JSON observation response cannot carry the Server Action's
page tree. Keep polling while a form is dirty: job status and toast updates can
arrive immediately while the page refresh waits. Reuse the registry's owed state
instead of adding another polling or refresh gate.

[Toaster polling](../../lib/toaster-poll.ts) validates HTTP status, response shape,
and the expected profile. A failed observation is a typed refusal: preserve the
previous job state and retry. Treating failure as an empty job list loses the seed
and can announce completed work again.

A read-only Server Action is not an equivalent observation boundary. Cookie
writes can also cause an action response to update the page.
[Session-cookie policy](../../lib/session-cookie.ts) renews the 30-day cookie on
GET/HEAD and on other methods when the seven-day slide mark is absent. The mark
contains the constant `"1"`, not session credentials. This limits cookie writes on
action requests without eliminating them, so the JSON boundary remains necessary.

The registry controls when opted-in refreshes run. It does not guarantee input
survival across arbitrary navigation, key changes, or subtree unmounts. Preserve
editor identity and draft recovery where those lifetimes require it.
