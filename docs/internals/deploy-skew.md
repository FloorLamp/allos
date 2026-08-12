# Deploys, the waiting worker, and deployment skew

Status: shipped

A deploy leaves open tabs running a build the server no longer serves. This is the
whole of what the app does about that: how it notices, how it **takes** the deploy on
its own, what it refuses to take it over, how a refresh resolves it, and what happens
to the tab that navigates or saves while still stale.

The decisions are pure and live in `lib/sw-update.ts` (plus `lib/theme.ts` for the
one colour question). The wiring is `components/ServiceWorkerRegister.tsx`,
`components/useAutoUpdateReload.ts`, `components/useDeployedVersion.ts`,
`components/update-reload-channel.ts`, `components/resume-continuation.ts`,
`app/global-error.tsx`, and `public/sw.js`.

## The posture: wait, then take it at the first safe moment (#1700 → #2471)

A new worker installs and **waits**. Open clients keep running the build they loaded
and keep the shell cache that build was compiled against. Nothing is taken over
mid-form — that half of #1700 is permanent, and everything below is built on it.

What changed in #2471 is who schedules the reload. The bar used to ask; the tab now
converges by itself at the first moment it can PROVE is safe, and says so afterwards.
The bar survives only as the rationed-failure fallback. See
[the tab takes the deploy itself](#the-tab-takes-the-deploy-itself-2471).

Two signals, **one** pending state (#1795): a waiting worker, and the `/api/version`
sha read. `resolveUpdateState()` merges them, so one deploy produces one notice.

`shouldReloadOnControllerChange()` holds the only-the-asking-tab rule (#1806):
activation is registration-wide, so every open tab sees `controllerchange`, and only
the tab that tapped may reload. A tab that did not ask is never reloaded out from
under a half-filled form.

The asking tab answers the swap **even when the fallback timer already reloaded**
(#2155). Chrome may hold a skip-waiting activation until the outgoing worker is
idle, so the swap can land only after `SW_RELOAD_FALLBACK_MS` — and the fallback's
navigation went out under the OLD worker, which a swap landing mid-flight can
strand: the navigation never commits and the tab hangs. Re-answering replaces that
possibly-stranded navigation with one dispatched under the new controller; it
cannot loop, because `controllerchange` fires once per activation and a committed
reload destroys the document that asked. The reloaded-once flag still guards the
fallback timer itself.

## The tab takes the deploy itself (#2471)

Until this issue a deploy asked before it did anything: a bar, a tap, a reload; and
under a dirty activity editor, four taps to get back where you already were (reload,
navigate back, find the draft banner, Resume). The owner's ruling is that the app
should schedule that, because the user is not better placed to. **The whole licence
for taking that decision over is that "safe" became a derived property rather than a
guess**, so the refusals below are the feature, not caveats on it.

### The two triggers

- **A — a save failed stale.** `isStaleActionError` on an autosave; the editor reports
  it through `components/update-reload-channel.ts` and the registrar reads it.
  Deliberately **independent of the detector**: it fires seconds after the deploy,
  from the failure itself, so recovery still works in a tab whose `/api/version` poll
  has latched off. That is #2329's lesson applied forward, and #2447's failure mode
  answered structurally rather than by trusting the poller.
- **B — the build is pending.** `resolveUpdateState().pending`, narrowed to
  `plan === "offer"`. This is the only trigger that can reach a form which never
  ATTEMPTS a save (an activity with a set missing its reps), and a clean tab with no
  editor open at all.

### The safe moment

`autoReloadPlan()` (`lib/sw-update.ts`) is the whole decision, and its ORDER is the
safety argument:

| in order                          | answer                                |
| --------------------------------- | ------------------------------------- |
| no trigger                        | `none`                                |
| ration spent for this target      | `hold` — render the manual affordance |
| work with no durable copy on page | `hold` — the refusal, below           |
| a form submit still settling      | `wait`                                |
| `document.hidden`                 | `reload`                              |
| input-quiet for `INPUT_QUIET_MS`  | `reload`, else `wait`                 |

**Quiet is measured from when we started WATCHING, not only from the last event.** "No
input has been seen" and "the page is quiet" are the same sentence everywhere except at
the very start of a document, where the first is true only because nothing has been
observed yet. The poll's mount read can answer within milliseconds of the listeners
attaching, and a tab that reloads then has taken the document away from someone
mid-gesture — the exact harm the gate exists to prevent. It was not theoretical: the
end-to-end drive for "a tab that is never quiet" caught it, reloading after a single
dispatched keystroke. So `watchingSince` is an input to the decision, silence before it
counts for nothing, and a fresh tab must watch out the window before it may call the
page quiet. The cost is that a clean tab converges three seconds later. A HIDDEN tab
short-circuits above and needs no observation period, because nothing can reach a
hidden document at all.

`wait` and `hold` are different answers because **only `hold` may raise a bar**. A bar
that appeared during a two-second scroll pause would be the ask-before consent gate
this issue removes. A tab that never goes quiet simply stays on the old build; #1906
already covers the stale navigation while it waits, and trigger A covers the stale
save.

Input is watched at the DOCUMENT, in the capture phase, for pointer/key/wheel/touch/
scroll — not "input inside a form". A reload mid-scroll, mid-drag or mid-picker is the
disruption the bar was protecting against just as much as one mid-typing, and none of
those touch a field. A `submit` anywhere starts a write whose completion nothing here
can observe, so it settles for `SUBMIT_SETTLE_MS` first — even in a hidden tab, because
safety outranks the hidden fast path. That listener is document-level for the same
completeness reason #1878 gives: every form in the app, present and future, with no
per-form wiring to forget.

### What it refuses, and why that is the honest shape

Two registries report dirtiness and they mean different things:

- a **draft-backed** form (`components/useFormDraft.ts`) holds its content in
  IndexedDB. A reload over it is lossless once the debounce has been flushed — which
  is a step in the reload SEQUENCE, not an input to the decision.
- **any other form holding unsaved input** — reported by the #1878 dirty-form
  registry, which already sees every `<form>` in the app — has no durable copy at all.
  `markUnrecoverableWork` is that axis, and `hold` is the answer.

So this ships as a **partial, and deliberately**: a settings card mid-edit, a record
form mid-composition, an in-flight upload — none of those auto-reload, and none of
them need to, because what they fall back to is precisely the pre-#2471 behaviour. A
form is recognised as draft-backed by the `data-draft-backed` marker `useFormDraft`
stamps on the subtree it covers (`scopeRef` where the state lives in `extra` rather
than in named fields, as in the activity editor).

The other named refusal is in `ActivityEditorProvider`: a marker naming a STORED
activity row is consumed but not acted on, because the provider holds the live
session's edit data and nothing else. That row's draft is untouched and still offered
the moment the user opens it.

### The sequence, which is fixed

1. the plan says `reload`;
2. **every recoverable draft is flushed and settled** (`captureUnsavedWork`), never a
   debounce still in flight;
3. the resume marker and the toast marker are written;
4. the ration is spent, recorded BEFORE the attempt, exactly as the crash path records
   its own;
5. the reload goes through the registrar's existing path — `requestedRef`,
   `reloadPlanFor`, the `SW_RELOAD_FALLBACK_MS` timer — so the tab lands on the waiting
   build and the #1806 only-the-asking-tab rule still holds.

Any step that throws or refuses stops the sequence: nothing reloads, the manual
affordance renders. **An automatic reload that can drop a keystroke is worse than the
four taps it replaces**, so losslessness is the precondition and not the goal.

The manual affordances that survive — the bar, and the editor's stale-save banner —
call the SAME routine (`requestUpdateReload`). #2155 establishes that a second
machinery reload can legitimately follow the first, and a marker written only at one
call site would strand the editor the other one reloaded.

### Rations compose

Two automatic reloads now exist in the app, under two `sessionStorage` keys with the
same guard shape: this one (`AUTO_RELOAD_KEY`) and #1906's crash recovery
(`SKEW_RECOVERY_KEY`). Neither clears nor refills the other, and neither is cleared by
a page that loads successfully, so the worst case of a genuinely broken deploy is
their SUM — two automatic reloads, then the banner, then nothing. That bound is
asserted directly, as a 25-pass simulation of the combined case, in
`lib/__tests__/auto-reload.test.ts`.

This ration is **per target build**, and specifically per the SET of targets attempted
in the window. Per-target is what makes a flapping `/api/version` harmless: two
servers mid-rolling-deploy answering A, B, A, B would otherwise look like four fresh
episodes to a guard that remembers only the last target. `AUTO_RELOAD_MAX_TARGETS`
caps the window total so three servers cannot do the same thing more slowly.

### The continuation, and the one argued exception

Immediately before any update-machinery reload, a one-shot `sessionStorage` marker
(`RESUME_EDITOR_KEY`) records `{ formKey, recordId, live, at }` — **a pointer only**.
No field content ever leaves IndexedDB; the PHI rule in `lib/offline/drafts.ts`
stands. sessionStorage is deliberate: per-tab, so only the tab that lost its build
reopens its editor, and crash-scoped.

`components/resume-continuation.ts` consumes it exactly once per document — remove on
read, before anything acts on it, so no later reload can replay it — and serves the
parsed value to its two readers: `ActivityEditorProvider`, which reopens the editor
(live mode through the existing `resumeLive()` presence path), and `useFormDraft`,
which applies the draft **without a banner**.

That auto-apply is the one argued exception to never-apply-without-a-tap, and every
leg of `shouldAutoApplyDraft` is a way of checking the tap really happened: the marker
names this exact form and record, the marker and the draft are both young (minutes,
not the draft's 7-day TTL), and `draftConflictsWithInput` is clean. Any leg failing
falls back to today's offer banner. An organic revisit — another tab, the next day, no
marker — still gets the offer, which is what `e2e/form-drafts.spec.ts` pins,
unchanged.

**Restore never forces a save.** After the resume the autosave re-enters its normal
contract: a valid dirty form saves on the next debounce, an invalid one sits restored
and waits. The explicit-submission forms (`useFormDraft`'s other five) get the same
restore and no write at all — their submit is still the user's.

### The notice inverts

A second one-shot marker (`UPDATE_TAKEN_KEY`, `{ sha, commitMessage }`) is written
before the reload and consumed on the next healthy boot into a toast — "The app has
updated", with the commit message when the server named one. Consumption IS the
dedupe, so one deploy still gets one notice (#1795/#1806): a second machinery reload
for the same build, a manual refresh afterwards, or a same-build waiting worker
consumed silently (#2120, which writes no marker at all) can none of them toast twice.

It is rendered by `components/UpdateTakenToast.tsx`, headless, INSIDE the root
`ToastProvider` — the registrar sits above it and cannot call `useToast()`. It is a
**rendered aggregate** in the attention doctrine's taxonomy, not a send: it reports
something that already happened to this tab, asks for nothing, and is deliberately
routed through the app's one toast system rather than anything in `lib/notifications/`.

### The crash path stays ignorant of all this

`app/global-error.tsx` replaces the root layout, so none of these components mount
there: the resume and toast markers are simply not consumed on a crash and survive to
the next healthy boot, which is the intended behaviour. Its reads of
`UPDATE_PENDING_KEY` and `SKEW_RECOVERY_KEY` are untouched, and both new markers are
parsed as defensively as `parseSkewGuard` — malformed means removed and ignored, never
a throw.

## Detection and resolution are different jobs (#2329)

#1795 also made those two **mutually exclusive** — "the worker wins wherever it
exists" — and that half was the bug. A waiting worker is the mechanism that
**resolves** an update; it is not, and structurally cannot be, a **detector** for a
tab that is already open:

- `public/sw.js` reads its version from its own URL (`?v=<sha>`), so a deploy changes
  **not one byte** of the script.
- `registration.update()` therefore refetches the URL this document registered, gets
  identical bytes, and installs nothing.
- Nothing re-registers an open tab. `register()` runs once per document load, with
  that document's sha — only a **fresh document** ever discovers a new worker.

So in a tab with a worker, `swWaiting` was false forever and the poll was off:
`pending` was false forever, and the bar was unreachable in exactly the long-lived
PWA tab it exists for. The one context that still worked was the one with **no**
worker — the inverse of where it is needed.

The rule now: **the sha poll runs wherever there is a baseline to compare against.**

```ts
const mode: VersionWatchMode = sha ? "poll" : "off";
```

Picking a detector was never what kept one deploy to one notice — the merge is, plus
one component, one `pending` and one `UpdateReadyBar`. Three things went with the
exclusion: `deployDetectorFor()` and the `DeployDetector` type, the
`registration.update()` tick (a byte-identical refetch every minute per tab that
could never install anything; a worker installed by _another_ tab still arrives
through scope-wide `updatefound`), and the poll's `"once"` mode.

`"once"` collapsed into `"poll"` because a poll that finds a mismatch already learns
what shipped. The one thing it did that the poll did not is now the poll's: **the
first read happens on mount.** `waitingWorkerPlan()` blocks on `deployedSettled`, so
a deferred first read left a fresh load after a deploy on `plan === "wait"` — bar
suppressed — for up to a full interval. The mount read is free: a document this
server just rendered is on this server's build, so it normally reports the same sha,
finds no mismatch, and settles the read the plan is waiting for.

What is deliberately **not** done, and why: `sw.js` is not version-stamped in its
bytes (that would make every deploy invalidate the script for every tab, in service
of a detector the sha read already provides more cheaply and more honestly); there is
no push/SSE deploy signal (a minute was never the complaint); and the `?v=<sha>`
registration URL stays (it names the cache generation).

Everything downstream of the signal was already correct and is untouched: the
wait-then-offer posture, `shouldOfferUpdate()`'s controlled-page discriminator,
`waitingWorkerPlan()`'s silent consume, the SKIP_WAITING handshake and its fallback
timer, the late-swap re-answer, the dismissal posture, and the #1906 skew marker.
None of them had ever run, because `pending` was never true.

The reload path is right for this case as it stands. An open tab that noticed the
deploy through the poll has **no** waiting worker, so `reloadPlanFor()` returns
`plain` — and a plain reload is correct: navigations are network-first (`sw.js` never
caches HTML), so it lands on the new build's document, whose hashed chunk URLs the old
cache does not hold and are therefore fetched fresh. That document registers
`/sw.js?v=<new sha>`, its worker installs, `pageSha === deployedSha`, and #1905
consumes it silently.

## A refresh consumes the update (#1905)

A manual refresh (F5, pull-to-refresh) fetches the new build's HTML and assets, but
it **never activates a waiting worker** — only the skip-waiting handshake or closing
every tab of the origin does. And on the first load after a deploy the new worker is
usually not waiting **yet**: the page's own `register("/sw.js?v=<new sha>")` call is
what tells the browser a deploy happened at all — a fresh document is the only thing
that ever does, since the script's bytes never change (#2329) — so the worker installs
seconds after load, through `updatefound`. Both shapes used to re-offer — the second one
even after the first was fixed, because the fix keyed on "waiting at load" — a bar
advertising an update to the build the page was already running, coming back on the
very refresh that was supposed to clear it.

`waitingWorkerPlan()` decides every waiting worker instead of offering it, however
it arrived, on one discriminator — the sha this document was served with against the
sha the server reports:

| page sha vs deployed sha             | plan                |
| ------------------------------------ | ------------------- |
| no page sha to compare               | `offer`             |
| not yet known                        | `wait`              |
| equal                                | `activate-silently` |
| differ, or read settled with nothing | `offer` (#1700)     |

`activate-silently` posts `SKIP_WAITING` and raises nothing. There is no reload
because the page already **has** the new assets; the worker just takes over
subsequent fetches. It deliberately does not set the registrar's `requestedRef`, so
the #1806 guard leaves every tab — including this one — exactly where it is.

`wait` exists so the bar does not flash on the first load after every deploy: it
holds for the single `/api/version` read the comparison turns on, and resolves the
moment that read settles either way (`useDeployedVersion` reports `settled`
separately from `sha`, because the endpoint is session-gated and an anonymous tab
settles knowing nothing).

**`settled` means "a read has come back", not "the hook has stopped asking."** Those
were the same thing while the only reader of this flag was the one-shot `"once"`
mode, and collapsing `"once"` into a poll (#2329) is exactly where conflating them
bites: the normal, no-deploy answer is _the sha matched_, which is the answer a poll
must keep re-asking. If that read reported itself unsettled, `waitingWorkerPlan()`
would sit on `wait` **permanently** in the commonest case there is — a fresh load
after a deploy, whose own worker installs seconds later — and #1905's silent consume
would never run, leaving that worker waiting forever behind a page that already is
the new build. So every completed read reports `settled`, whatever it said: a 5xx, an
offline blip, an unparseable body. Answering in the dark is safe precisely because
the poll corrects it on the next tick. Whether to keep asking is a separate, private
question the hook keeps to itself (`finalRef`): asking stops only when the answer can
no longer change — the server named a build we are not on, or the endpoint said 401
and never will.

The read is **re-armed per waiting worker**: `useDeployedVersion` takes a
`generation` the registrar bumps for each newly-waiting worker, which un-settles a
finished read. A second deploy under the same open page is therefore never judged
against the answer read for the first — a stale "you are current" would silently
consume a genuine update, and strip the #1906 pending marker from a tab that is in
fact stale.

**The multi-tab tradeoff, recorded not hidden.** Activation is registration-wide, so
a second still-open tab on the old build loses the old asset cache when the new
worker's activate step drops it. Those unvisited-route chunks were already doomed —
the deploy removed them from the server — so this widens no failure window; it only
makes an existing one arrive sooner. What that tab then hits is skew, below.

Only the worker path ever looped. The sha read's baseline is the freshly-served sha,
so a refresh always self-clears it.

## Skew: the tab that navigates while stale (#1906)

A pending update means this tab runs the old build and the deploy removed that
build's hashed chunks. Navigating to a route the tab has **not** visited fetches a
chunk that no longer exists → 404 → a throw above the route group. The worker's
cache-first asset policy protects only what was already fetched; unvisited routes are
the unprotected set, by design, because deferring activation is what keeps the loaded
document alive at all.

`app/global-error.tsx` catches that, and it replaces the **root layout** — theme-boot
script included. Three things follow.

**1. Recovery happens before the card renders.** `skewRecoveryPlan()` returns
`hard-reload` only when all three hold: an update is pending, the error carries a
loader signature (`isDeploymentSkewError` — `ChunkLoadError`, a failed dynamic
import, a failed RSC payload fetch; deliberately _not_ a bare "Failed to fetch"), and
the loop guard has an attempt left. Otherwise the card renders, which stays the
honest answer for an ordinary crash.

**2. The loop guard is the load-bearing part.** A hard load that fails the same way
is an infinite redirect the user never sees — worse than the card. So recovery is
rationed: `SKEW_RECOVERY_MAX_ATTEMPTS` (1) per `SKEW_RECOVERY_WINDOW_MS` (60s) per
tab, stored in `sessionStorage` under `SKEW_RECOVERY_KEY` and counted from the
window's **opening** timestamp so a fast loop cannot drag the window along with it.
The attempt is recorded _before_ it is taken; if the write fails, the boundary does
not navigate, because an unrecorded attempt is an unguarded one.

The guard is **never cleared by a page that loads successfully**. That was the
tempting version and it is the spinning one: a worker serving a cached old document
loads "successfully" on every pass.

**3. The primary action is a hard reload.** `reset()` re-renders the same stale
runtime reaching for the same deleted chunks; it fails identically every time.
"Reload the app" → `window.location.reload()` is the one recovery skew has, and the
URL bar already holds the destination, so reloading it _is_ the hard navigation to
that destination. `reset()` survives as the **secondary** action, because this card
is also the fallback for the ordinary crash where a re-render is the cheap,
non-destructive thing to try.

This reload is a genuine full-document load and is unrelated to the
`router.refresh()` rule in [`server-action-refresh.md`](./server-action-refresh.md),
which is about not re-fetching a page an action response already carried. A soft
refresh here reuses the stale runtime and cannot work.

### The pending marker

The registrar and the boundary sit on opposite sides of a crash: `global-error`
replaces the root layout, so `ServiceWorkerRegister` is not mounted when the boundary
needs to know whether an update is pending. The registrar writes
`UPDATE_PENDING_KEY` to `sessionStorage` (per-tab, exactly like the state it
describes) whenever the single `pending` state is true, and removes it when it is
not. Dismissing the bar does **not** clear it — dismissing hides an offer, it does
not un-deploy anything, and that tab is precisely the one that goes on to hit a
missing chunk.

### The theme

`global-error` replaces the theme-boot script, so no `dark` class is ever set and
`globals.css` may not have loaded. A hard-coded light card therefore read, in dark
mode, as the app flipping to a broken light theme. It now reads the **same**
`localStorage` key the boot script reads and picks inline colours through
`errorCardPalette()` in `lib/theme.ts` — one theme source, not two. `lib/theme.ts`
also owns `isDarkTheme()` and the boot script's own source (`THEME_BOOT_SCRIPT`, a
string that must run before any bundle, executed against `isDarkTheme()` by a pure
test so the transcription cannot drift); `components/ThemeToggle.tsx` imports the
rule outright.

The boot script is single-shot per document, so one hard navigation on which it
never ran (blocked inline script, a cached offline shell, a hydration-recovery
root re-render dropping the boot-added class) used to leave the whole SPA session
light until a manual toggle — `router.push` navigations inherit the document's
class forever (#2183). `components/ThemeReassert.tsx` (mounted in the root
layout) re-asserts the class idempotently post-hydration and on every route
change, importing the same rule; when it finds the poisoned signature (storage
says dark, class missing) it first logs one structured client-console event —
route, nonce'd-script presence, SW-controlled flag, any hydration errors seen
(`themeReassertEvent()` / `isHydrationErrorMessage()`, both pure in
`lib/theme.ts`) — so the trigger gets pinned instead of guessed. The offline
shell additionally carries a CSS-only `prefers-color-scheme` base scoped to
`[data-offline-shell]` in `globals.css`, so even a render in which **no** script
executes respects OS dark.

`app/(app)/error.tsx` needs none of this: it renders inside the root layout, so its
Tailwind `dark:` variants already work.

## Skew: the tab that keeps saving while stale

Navigation is not the only thing a stale tab does. The reported loss was a live
workout edited straight through a deploy: Server Actions are compiled into the
client as **build-keyed ids**, so the moment the deploy lands, every action POST
from an open tab is answered with Next's not-found marker
(`x-nextjs-action-not-found`) and the client throws `UnrecognizedActionError`.
Retrying in place cannot succeed — only a reload can — and before this section's
change the failure was swallowed three times over: the auto-save showed a bare
error glyph, the offline queue declined (online, not a `TypeError`), and the
activity draft was inert in live mode because the session was "server-backed".
The edits existed nowhere.

`isStaleActionError()` (`lib/sw-update.ts`) recognises the signature — by error
name and by both message wordings, deliberately narrow like the chunk classifier
above. Two consumers:

- **`shouldQueueOffline()`** (`lib/offline/queue.ts`) treats a stale-action
  failure like a dead connection: the quick-log flows and the activity
  close-path capture queue the intent instead of erroring. That is sound because
  the replay route (`app/api/offline-replay`) is an ordinary route handler no
  deploy re-keys — a queued tap lands from the stale tab itself (the sync/flush
  machinery) or from the reloaded one.
- **The activity auto-save** (`components/activity-form/useActivityAutosave.ts`)
  reports `staleBuild` — sticky across failures, cleared by a success. Since #2471
  that report is a TRIGGER before it is a message: it goes to
  `components/update-reload-channel.ts`, the tab flushes the draft, leaves a
  continuation pointer and reloads itself, and the editor comes back with the edits
  applied and no taps at all. The banner survives as the rationed-failure fallback —
  it renders only once the registrar publishes that the automatic attempt is spent (or
  is being refused) — and its Reload goes through the same shared routine, so even a
  manual tap resumes. The unmount toast says the same instead of "reopen the
  activity", which would fail identically.

The banner can promise "kept on this device" because the local draft (#1699) now
runs in **live mode** too. The #451 inertia — "a live session is server-backed,
a second copy would compete" — was only true while the auto-save's POSTs landed;
skew holds the unsaved window open indefinitely with no local copy at all. The
competing-source-of-truth concern is answered by the clear-on-success effect the
form already had: while saves land, the draft is dropped the moment the server
copy is current, so it only ever outlives a save that failed.

## Testing

Pure (`lib/__tests__/auto-reload.test.ts`): the #2471 half — every leg of
`autoReloadPlan` including the two refusals and the difference between `wait` and
`hold`, the per-target-SET ration and the two-server flap it exists for, both markers'
parse rules (malformed → ignored), each failing leg of the auto-apply gate falling
back to the offer, and the **combined** broken-deploy simulation asserting the summed
reload bound before both surfaces go quiet.

Pure (`lib/__tests__/sw-update.test.ts`, `lib/__tests__/theme.test.ts`,
`lib/__tests__/offline-queue.test.ts`): the waiting-worker decision matrix, both
skew classifiers' positives and their deliberate negatives, the queue predicate's
stale-action case, the guard's state machine including a 25-pass broken-deploy
simulation that must produce exactly one reload, the marker contract, and that the
two error-card palettes genuinely invert rather than merely differ.

Pure (`lib/__tests__/deployed-version-watch.test.ts`): **how the signal is produced**,
which is the half nothing tested before #2329 — every other pure test takes
`swWaiting` / `deployedSha` as an input and verifies the decision made from it, which
is why a permanently-false input went unnoticed for a week. It executes the real
`useDeployedVersion` against a minimal hook runtime (the pure tier is node-only by
design, so `react`'s three primitives are mocked with an order-indexed
implementation): the mount read, the poll continuing after a read that found no
mismatch, a failed read still reporting itself answered, the session-gated settle,
the per-generation re-arm, and one test that JOINS the signal to the decision it
unblocks — a matching read reaching `waitingWorkerPlan()` as `activate-silently`
rather than `wait`, which is the settled-is-not-final trap caught by its consequence
instead of by its flag. Its second half is a source scan of the registrar's call
site, because whether the hook is switched on at all is a call-site fact — exactly
the fact #1795 got wrong — that no test of the hook in isolation can see.

Browser: `e2e/sw-update.spec.ts` drives the real deferred-activation posture and,
since #2329, the **deploy shape production actually has**: a tab that is open,
worker-registered and controlled while the server moves to a new build, with nothing
registering a second worker. Both of those tests fail on the pre-#2329 tree at the
bar never appearing. `e2e/update-notice.spec.ts` drives the no-worker context and pins
the pending marker being written, and kept across a dismissal.
`e2e/stale-build-save.spec.ts` drives the Server Action half with the real client
error (action POSTs answered with the not-found marker). Two harness facts it records,
both of which cost a debugging round and both of which bite any spec that intercepts
under a service worker: a `page.route` installed into an already-CONTROLLED page can
miss permanently (so the interception is installed before `goto` and armed later, as
`e2e/sw-update.spec.ts` already found), and a navigation fetched BY the service worker
never reaches `page.route` at all (so "the deploy is over" is keyed on the page's
`load` event, not on counting document requests — and not on `framenavigated`, which
the App Router's same-document history rewrites also fire). What it drives: a live editor recovering
with ZERO taps from the failed save alone — with the version route never armed, which
is the detector-down tab — the unsaveable form converging on the detector alone and
being restored without a save being invented, a broken deploy stopping at exactly one
automatic attempt and handing back the banner, and the never-created session's
close-path capture still queueing and replaying. `e2e/update-notice.spec.ts` drives
the clean tab: it reloads itself, toasts once with the commit message, raises no bar,
and a tab under continuous scripted input is left alone until it stops.
`e2e/form-drafts.spec.ts` pins the healthy-path complement — a live draft never
outlives a successful save, and an organic revisit still gets the OFFER.

Every spec that asserts on the bar or the stale-save banner first calls
`spendAutoReloadRation` (`e2e/helpers.ts`). That is not a switch-off: it puts the tab
in the one state that genuinely renders those affordances — one automatic attempt
already made — which is also the state a broken deploy produces.

**What is not driven end to end, honestly.**

A real deploy moves the server's sha together with the worker's URL; the harness can
only move the second, so `e2e/sw-update.spec.ts` moves the first itself by
intercepting `/api/version` — without that, the fix would (rightly) consume the
simulated update silently instead of offering it. The two #1700 tests additionally
hand-register a second worker version against the open page. **That is not what a
deploy does** — the claim that it was is the sentence that hid #2329 for a week —
but it is a valid drive for the _resolution_ path, which is what those two tests are
about. The reload test then drops the
interception and pins the other half of #1905: the page's own re-registered worker
generation is consumed silently instead of ping-ponging back as a fresh offer. Its
settle point is the pending marker's raise-then-clear, **not** the generation
reaching `active` (#2155): Chrome may hold a skip-waiting activation until the
outgoing worker goes idle, indefinitely on an idle page, and the next navigation
consumes it then — so the activation instant belongs to the platform, while the
raise-and-consume belongs to the app. What remains undriven is a genuine F5 against
a server whose build actually changed underneath the harness.

`app/global-error.tsx` is not reachable from Playwright at all. It renders only when
something throws above the route group, and nothing in the app can be made to do that
from the outside; a route that deliberately crashes would be a production surface
existing only for a test. Its logic is therefore pure and unit-tested, and the
component is a thin render over it.
