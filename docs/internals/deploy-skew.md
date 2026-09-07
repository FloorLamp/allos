# Deployment updates and recovery

Open tabs can outlive the build serving their assets and Server Actions. Allos
detects that mismatch, reloads when work can survive, and offers manual recovery
when an automatic attempt is unsafe or exhausted.

[lib/sw-update.ts](../../lib/sw-update.ts) owns the decisions, error classifiers,
markers, and timing constants. [ServiceWorkerRegister](../../components/ServiceWorkerRegister.tsx)
connects them to [public/sw.js](../../public/sw.js). Keep update detection, draft
capture, and reload decisions in these owners rather than adding another notice
or refresh path.

## Detecting and resolving an update

[useDeployedVersion](../../components/useDeployedVersion.ts) polls `/api/version`
whenever the document has a baseline SHA, including when a worker controls it.
It reads immediately on mount and when the tab becomes visible; interval reads
skip hidden tabs. A completed read sets `settled`, including a failed read.
Polling continues after matching builds and transient failures, and stops after
a mismatch or 401. Each newly waiting worker re-arms the read through `generation`.

A waiting worker alone cannot reliably detect a deploy in an existing tab. The
worker gets its version from its registration URL; a build change need not change
its script bytes, and an open document does not re-register on every deploy.
`resolveUpdateState` merges the worker signal and SHA mismatch into one pending
state. `waitingWorkerPlan` then compares the document and server builds:

| Comparison                                  | Plan                |
| ------------------------------------------- | ------------------- |
| No document SHA                             | `offer`             |
| Version read has not settled                | `wait`              |
| SHAs match                                  | `activate-silently` |
| SHAs differ, or the settled read has no SHA | `offer`             |

New workers install and wait. Silent activation sends `SKIP_WAITING` without
requesting a reload: the document already has the current assets. This also
handles a worker that finishes installing after a manual refresh.

For a requested reload, `reloadPlanFor` chooses a skip-waiting handshake if a
worker is waiting, otherwise a plain document reload. Navigation is network-first;
the worker does not cache HTML. Only the requesting tab reloads on
`controllerchange`, although activation affects the whole registration. A fallback
timer answers a stalled handshake. A late controller change must still reload the
requesting tab: the earlier navigation may have been stranded under the old worker.

Activation can discard old asset caches used by other tabs. Those tabs stay open
and may hit a missing chunk on later navigation; the crash path below handles that
case. Do not reload every tab merely because its controller changed.

## When automatic reload is allowed

[useAutoUpdateReload](../../components/useAutoUpdateReload.ts) responds either to
a pending update with plan `offer`, or independently to a stale-save report through
[update-reload-channel](../../components/update-reload-channel.ts). The latter
still works when version polling has stopped. `autoReloadPlan` checks in this order:

1. No trigger: `none`.
2. Attempt allowance spent for this target: `hold`.
3. Work without a durable copy: `hold`.
4. A form submission is within `SUBMIT_SETTLE_MS`: `wait`, even in a hidden tab.
5. Hidden tab: `reload`.
6. Otherwise, reload after `INPUT_QUIET_MS`; until then, `wait`.

Quiet starts at the later of the last input and listener attachment. Not having
observed input yet is insufficient. Listeners cover pointer, key, wheel, touch,
scroll, and submit events at the document level. Only `hold` displays the manual
update notice; a temporary `wait` does not interrupt the user with a bar.

Recoverable drafts register with [unsaved-work](../../lib/offline/unsaved-work.ts)
from the first keystroke, before the persistence debounce.
[useFormDraft](../../components/useFormDraft.ts) marks its covered subtree
`data-draft-backed`; that exclusion is valid only while its flush registration is
current. Other dirty forms hold the reload. Hand-composed forms without named
controls declare `data-unsaved`, read directly from the DOM at decision time.

Automatic and manual update controls use the same sequence:

1. Await `captureUnsavedWork` to flush recoverable drafts to IndexedDB.
2. Recheck both the dirty-form registry and DOM declarations after the await.
3. Write the resume pointer and update-toast marker to session storage.
4. Record the automatic-attempt guard before dispatching navigation.
5. Invoke the registrar’s reload path.

Failed capture or marker storage stops the sequence. Newly unrecoverable work also
stops it. A manual tap does not bypass draft capture. Keep draft content in
IndexedDB; session-storage continuation markers contain identifiers only.

## Bounded retries and continuation

`AUTO_RELOAD_KEY` records attempted target builds within a fixed window. It remembers
all attempted targets, with a total cap, so alternating server SHAs cannot reset the
allowance. `SKEW_RECOVERY_KEY` separately limits crash recovery. Their allowances
compose; neither resets the other or clears after a healthy load. Limits are
windowed, not lifetime bounds. Use the constants in `lib/sw-update.ts` rather than
assuming every failure sequence permits exactly two reloads. If an attempt cannot
be recorded, automatic recovery must not navigate.

[resume-continuation](../../components/resume-continuation.ts) removes the resume
marker once per document and shares the parsed pointer with the editor provider
and draft hook. A matching draft can auto-apply only when the marker and draft are
recent, the form and record match, and existing input does not conflict. Each draft
key consumes that opportunity once. Invalid or missing markers fall back to the
normal draft offer. The activity provider resumes live work; a stored-row marker
does not make it open an editor it does not own.

Restoring does not force submission. Valid dirty activity forms resume normal
autosave; invalid forms remain editable, and explicit-submit forms still await a
tap. Successful saves clear their local drafts, including live activity drafts.

[UpdateTakenToast](../../components/UpdateTakenToast.tsx) consumes the update marker
on healthy boot inside the shared toast provider. This produces a single notice
for that marker. Silent same-build worker activation writes no notice. The root
crash boundary does not mount these consumers, so markers survive until a healthy
boot can use them.

## Stale navigation and saves

[global-error](../../app/global-error.tsx) replaces the root layout. Its
`skewRecoveryPlan` permits a hard reload only with a pending-update marker, a
recognized chunk/import/RSC failure, and an available recorded attempt. A generic
“Failed to fetch” alone is insufficient. Dismissing the update bar does not clear
the pending marker. Other errors or exhausted attempts render the error card.

The card’s primary action loads a fresh document; `reset()` remains a secondary
option for ordinary crashes. A [Server Action soft refresh](server-action-refresh.md)
reuses the runtime and cannot replace stale chunks. Since root-layout styling and
theme boot may be absent, the card uses inline colors from the shared
[theme owner](../../lib/theme.ts). Normal route rendering and `ThemeReassert` use
that same theme rule; the offline shell also has a CSS-only system-theme fallback.

`isStaleActionError` recognizes expired Server Action identifiers. Supported flows
can queue their intent through [shouldQueueOffline](../../lib/offline/queue.ts)
and replay through the stable `/api/offline-replay` route. Activity autosave reports
the stale build to the reload channel; its banner is the manual fallback. A local
draft must remain available while those saves fail.

## IndexedDB rollback

[openOfflineDb](../../lib/offline/idb.ts) owns the device database version. An older
build cannot open a database already upgraded beyond its requested version. Queue,
draft, and snapshot access then degrades; pending data remains on disk but is
unavailable to that build. Roll forward to regain access instead of clearing
storage. A blocked upgrade rejects rather than hanging, and late successful opens
close their unused connection.

## Verification

Use existing coverage before adding cases:

- `lib/__tests__/auto-reload.test.ts` and `sw-update.test.ts`: decision order,
  retry windows, markers, classifiers, and continuation eligibility.
- `components/__tests__/deployed-version-watch.test.ts`: actual polling and settled-state
  behavior, including reads invalidated by a newer generation.
- `components/__tests__/auto-update-reload.test.ts`: unrecoverable work appearing
  while draft capture is awaited.
- `e2e/sw-update.spec.ts`, `update-notice.spec.ts`, `stale-build-save.spec.ts`, and
  `form-drafts.spec.ts`: worker resolution, quiet/dirty tabs, failed saves,
  continuation, and healthy draft cleanup.

Browser cases simulate deployment signals; they do not replace a real server build
under an F5. Hand-registering a worker exercises resolution, not detection in an
already-open tab. Install request interception before worker control, and use
`load` for document navigation: worker fetches can bypass page routing, while
App Router history changes can emit `framenavigated` without a reload. Tests of
manual fallback spend the automatic allowance first. The root crash boundary’s
recovery decision is unit-tested; the browser suite does not directly induce that
root-layout failure.
