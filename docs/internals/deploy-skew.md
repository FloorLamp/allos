# Deploys, the waiting worker, and deployment skew

Status: shipped

A deploy leaves open tabs running a build the server no longer serves. This is the
whole of what the app does about that: how it notices, how it offers, how a refresh
resolves it, and what happens to the tab that navigates while still stale.

The decisions are pure and live in `lib/sw-update.ts` (plus `lib/theme.ts` for the
one colour question). The wiring is `components/ServiceWorkerRegister.tsx`,
`components/useDeployedVersion.ts`, `app/global-error.tsx`, and `public/sw.js`.

## The posture: wait, then offer (#1700)

A new worker installs and **waits**. Open clients keep running the build they loaded
and keep the shell cache that build was compiled against. Nothing is taken over
mid-form. The page raises one calm, dismissible "Update ready" bar, and the reload
happens on the user's tap.

Two detectors, **one** pending state (#1795): the waiting worker wherever a worker
exists (it is the thing that decides which build a reload lands on), a `/api/version`
sha read where none does (private mode, unsupported browsers, failed registration,
development). `resolveUpdateState()` merges them, so one deploy produces one notice.

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

## A refresh consumes the update (#1905)

A manual refresh (F5, pull-to-refresh) fetches the new build's HTML and assets, but
it **never activates a waiting worker** — only the skip-waiting handshake or closing
every tab of the origin does. And on the first load after a deploy the new worker is
usually not waiting **yet**: the page's own `register("/sw.js?v=<new sha>")` call is
what tells the browser a deploy happened at all (the update tick refetches the old
versioned URL, whose bytes a deploy does not change), so the worker installs seconds
after load, through `updatefound`. Both shapes used to re-offer — the second one
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

Only the worker path ever looped. The sha fallback's baseline is the freshly-served
sha, so a refresh always self-clears it.

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
  reports `staleBuild` — sticky across failures, cleared by a success — and the
  editor renders a banner naming the cause and the remedy, with the reload one
  tap away. The unmount toast says the same instead of "reopen the activity",
  which would fail identically.

The banner can promise "kept on this device" because the local draft (#1699) now
runs in **live mode** too. The #451 inertia — "a live session is server-backed,
a second copy would compete" — was only true while the auto-save's POSTs landed;
skew holds the unsaved window open indefinitely with no local copy at all. The
competing-source-of-truth concern is answered by the clear-on-success effect the
form already had: while saves land, the draft is dropped the moment the server
copy is current, so it only ever outlives a save that failed.

## Testing

Pure (`lib/__tests__/sw-update.test.ts`, `lib/__tests__/theme.test.ts`,
`lib/__tests__/offline-queue.test.ts`): the waiting-worker decision matrix, both
skew classifiers' positives and their deliberate negatives, the queue predicate's
stale-action case, the guard's state machine including a 25-pass broken-deploy
simulation that must produce exactly one reload, the marker contract, and that the
two error-card palettes genuinely invert rather than merely differ.

Browser: `e2e/sw-update.spec.ts` drives the real deferred-activation posture;
`e2e/update-notice.spec.ts` drives the no-worker fallback detector and pins the
pending marker being written, and kept across a dismissal.
`e2e/stale-build-save.spec.ts` drives the Server Action half with the real client
error (action POSTs answered with the not-found marker): the live editor's stale
banner, the draft surviving in live mode and restoring after the reload, and the
never-created session's close-path capture queueing and replaying.
`e2e/form-drafts.spec.ts` pins the healthy-path complement — a live draft never
outlives a successful save.

**What is not driven end to end, honestly.**

A real deploy moves the server's sha together with the worker's URL; the harness can
only move the second, so `e2e/sw-update.spec.ts` moves the first itself by
intercepting `/api/version` — without that, the fix would (rightly) consume the
simulated update silently instead of offering it. The reload test then drops the
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
