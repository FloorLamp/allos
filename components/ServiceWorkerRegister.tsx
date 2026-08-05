"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import UpdateReadyBar from "./UpdateReadyBar";
import {
  useDeployedVersion,
  type VersionWatchMode,
} from "./useDeployedVersion";
import {
  deployDetectorFor,
  reloadPlanFor,
  resolveUpdateState,
  shouldOfferUpdate,
  shouldReloadOnControllerChange,
  SW_RELOAD_FALLBACK_MS,
  SW_SKIP_WAITING,
  UPDATE_CHECK_MS,
  UPDATE_PENDING_KEY,
  UPDATE_PENDING_MARKER,
  waitingWorkerPlan,
  type ServiceWorkerStatus,
} from "@/lib/sw-update";
import {
  hasUnsavedWork,
  subscribeUnsavedWork,
} from "@/lib/offline/unsaved-work";

// Registers the hand-rolled service worker (public/sw.js) — Next's App Router has no
// first-party SW story, so we register it ourselves from the root layout. The worker
// gives the app an installable, offline-tolerant shell: it caches immutable build
// assets and shows a friendly offline page for navigations that fail (see
// public/sw.js for the deliberately conservative caching policy — it never touches
// /api, /settings, /login, or medical/PHI responses).
//
// `sha` is the running commit. It goes on the worker's script URL as ?v=, so a deploy
// changes that URL and triggers an update, and it is the baseline the fallback
// detector compares the server's commit against.
//
// UPDATE FLOW (issue #1700). The worker no longer takes over open clients on deploy.
// It installs, waits, and this component surfaces the choice: an "Update ready" bar
// whose Reload button posts SKIP_WAITING to the waiting worker and reloads THIS tab
// once the controller changes. Three things that flow gets right, all of which the
// naive `controllerchange → reload()` recipe gets wrong:
//
//   * only the tab that ASKED reloads. Activation is registration-wide, so every
//     open tab sees `controllerchange` — a second tab sitting on a half-filled form
//     must not be reloaded because someone tapped in the first.
//   * the tap is answered at most once per navigation, but a late controller swap
//     re-answers it (#2155): when activation stalls past the fallback timer, the
//     fallback's navigation went out under the OLD worker and the swap can strand
//     it, so the controllerchange reload replaces it rather than deferring to it.
//   * a dismissed bar stays dismissed for this build; it is an offer, not a nag.
//   * the tap is always answered: if the waiting worker has gone stale and the
//     handshake never lands, the page reloads anyway on a short fallback timer.
//
// THIS COMPONENT OWNS THE WHOLE QUESTION (issue #1795). It used to own half of it: a
// separate VersionWatcher in the app layout polled /api/version for a new COMMIT_SHA
// and raised its OWN banner, with its own Refresh button that plainly reloaded —
// leaving the worker still waiting, so this bar promptly re-offered the update the
// user had just taken. One deploy trips both detectors, so the fix is not to pick a
// detector but to give both ONE answer:
//
//   * where a worker exists it is the primary detector (it decides which build a
//     reload lands on), and the sha read is demoted to naming what shipped;
//   * where none exists — private mode, unsupported, a failed registration, or
//     development, where the branch below unregisters on purpose — the sha poll IS
//     the detector, feeding this same state;
//   * either way there is one `pending`, one bar, and one reload path.
//
// A REFRESH CONSUMES THE UPDATE (issue #1905). The bar used to survive every manual
// refresh: a refresh fetches the new build's HTML and assets but never activates a
// WAITING worker. Worse, on the first load after a deploy the new worker usually is
// not waiting YET — this page's own register() call with the new ?v= is what tells
// the browser the deploy happened at all, so the worker installs seconds after load
// and used to be offered as "mid-session discovery" to a page already running the
// new build. Waiting workers are now decided rather than offered, however they
// arrived, on one discriminator: the sha this document was served with against the
// sha the server reports — see `waitingWorkerPlan` and the effect that acts on it
// below. Only the worker path had this defect; the sha fallback compares against
// the freshly-served sha, so a refresh always self-clears it.
//
// The decisions live in lib/sw-update.ts so they can be tested without a browser.
export default function ServiceWorkerRegister({ sha }: { sha: string | null }) {
  const [swWaiting, setSwWaiting] = useState(false);
  // Counts newly-waiting workers, so the one sha read is re-armed per install: a
  // second deploy under this open page must not be judged against the answer read
  // for the first (#1905).
  const [updateGen, setUpdateGen] = useState(0);
  const [swStatus, setSwStatus] = useState<ServiceWorkerStatus>("probing");
  // The live registration. The tap re-reads `.waiting` off it rather than holding a
  // ServiceWorker object from offer time: the browser can replace or discard a
  // waiting worker in between, and a message to that stale object goes nowhere.
  const regRef = useRef<ServiceWorkerRegistration | null>(null);
  // The worker from the just-fired `installed` event. Chromium can raise that event
  // one task before registration.waiting reflects the same worker; silent activation
  // must retain this exact generation across that narrow platform handoff.
  const installedRef = useRef<ServiceWorker | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [unsaved, setUnsaved] = useState(false);
  // This tab asked for the update; only it may reload on controllerchange.
  const requestedRef = useRef(false);
  const reloadedRef = useRef(false);
  // At most one silent activation per waiting worker (#1905).
  const silentlyActivatedRef = useRef(false);

  useEffect(() => subscribeUnsavedWork(setUnsaved), []);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      setSwStatus("unavailable");
      return;
    }

    if (process.env.NODE_ENV !== "production") {
      navigator.serviceWorker
        .getRegistrations()
        .then((registrations) =>
          Promise.all(
            registrations.map((registration) => registration.unregister())
          )
        )
        .catch(() => {});
      if ("caches" in window) {
        caches
          .keys()
          .then((keys) =>
            Promise.all(
              keys
                .filter((key) => key.startsWith("allos-shell-"))
                .map((key) => caches.delete(key))
            )
          )
          .catch(() => {});
      }
      // Development runs with no worker BY CHOICE, which is the same shape as a
      // context that cannot have one — so it gets the fallback detector, and a dev
      // server restart still surfaces the same one bar.
      setSwStatus("unavailable");
      return;
    }

    let disposed = false;

    // A worker that is installed but not yet controlling is an update WAITING for
    // this page — but only if the page is currently controlled. With no controller
    // there is no running build to replace: that is a first install, which activates
    // and claims on its own and has nothing to ask the user about.
    //
    // Each newly-waiting worker re-opens the whole question (#1905): whatever this
    // page decided about an earlier worker — and whatever the sha read answered
    // then — does not describe this one, so the generation bump un-settles the read
    // and the silent-activation guard resets with it.
    const offer = (sw: ServiceWorker | null) => {
      if (disposed) return;
      if (
        !shouldOfferUpdate({
          waiting: !!sw,
          controlled: !!navigator.serviceWorker.controller,
        })
      ) {
        return;
      }
      silentlyActivatedRef.current = false;
      installedRef.current = sw;
      setSwWaiting(true);
      setUpdateGen((generation) => generation + 1);
    };

    const onControllerChange = () => {
      if (
        shouldReloadOnControllerChange({
          requestedByThisTab: requestedRef.current,
        })
      ) {
        // Deliberately reloads even when the fallback timer already did (#2155):
        // that navigation was dispatched under the OLD worker and the swap this
        // event announces can strand it. See shouldReloadOnControllerChange.
        reloadedRef.current = true;
        window.location.reload();
      }
    };
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      onControllerChange
    );

    // Ask the browser to re-fetch the worker script on the shared cadence (#1795).
    // The retired sha poll asked every minute; the browser's own update check fires
    // on document navigation and roughly daily, which in a long-lived SPA tab can be
    // never. This is the worker-side shape of the same question, so the primary
    // detector is as timely as the fallback it took over from. Nothing to ask once a
    // worker is already waiting, and nothing to ask in a hidden tab.
    let checkTimer: ReturnType<typeof setInterval> | undefined;
    const checkForUpdate = () => {
      const registration = regRef.current;
      if (disposed || !registration || registration.waiting) return;
      if (document.visibilityState !== "visible") return;
      registration.update().catch(() => {});
    };

    // Register after load so the SW install never contends with first paint. We only
    // reach here in production (the non-prod branch above unregisters and returns),
    // and we deliberately do NOT pass a dev signal (?dev=1) — the worker's IS_DEV is
    // keyed on that explicit flag, not on the sha, so a prod deploy whose COMMIT_SHA
    // is missing (the "dev" fallback below) still gets the full offline shell instead
    // of a silently disabled PWA.
    const version = sha ?? "dev";
    const register = () => {
      navigator.serviceWorker
        .register(`/sw.js?v=${encodeURIComponent(version)}`)
        // Annotated as possibly-undefined on purpose: a context that blocks service
        // workers can RESOLVE this call with nothing rather than rejecting it (the
        // shape Playwright's `serviceWorkers: "block"` and some privacy modes take),
        // and a registration that isn't there is exactly the fallback's context.
        .then((registration: ServiceWorkerRegistration | undefined) => {
          if (disposed) return;
          if (!registration) {
            setSwStatus("unavailable");
            return;
          }
          regRef.current = registration;
          setSwStatus("active");
          offer(registration.waiting);
          registration.addEventListener("updatefound", () => {
            const installing = registration.installing;
            if (!installing) return;
            installing.addEventListener("statechange", () => {
              if (installing.state === "installed") offer(installing);
            });
          });
          checkTimer = setInterval(checkForUpdate, UPDATE_CHECK_MS);
          document.addEventListener("visibilitychange", checkForUpdate);
        })
        .catch(() => {
          // A failed registration (e.g. private mode, unsupported) is non-fatal: the
          // app works fine online without the offline shell. It does mean this page
          // has no worker to watch, so the sha poll takes over as the detector.
          if (!disposed) setSwStatus("unavailable");
        });
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });

    return () => {
      disposed = true;
      if (checkTimer) clearInterval(checkTimer);
      document.removeEventListener("visibilitychange", checkForUpdate);
      window.removeEventListener("load", register);
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        onControllerChange
      );
    };
  }, [sha]);

  // The fallback detector, and the one read that names what shipped. Both go through
  // the same hook because they are the same question asked of the same endpoint; only
  // the reason for asking differs.
  const mode: VersionWatchMode = swWaiting
    ? "once"
    : deployDetectorFor(swStatus) === "version-poll"
      ? "poll"
      : "off";
  const deployed = useDeployedVersion({
    baseline: sha,
    mode,
    generation: updateGen,
  });

  const { pending, commitMessage } = resolveUpdateState({
    swWaiting,
    baselineSha: sha,
    deployedSha: deployed.sha,
    deployedMessage: deployed.commitMessage,
  });

  // A REFRESH CONSUMES THE UPDATE (issue #1905). A manual refresh fetches the new
  // build's HTML and assets but never activates a waiting worker — and the worker a
  // fresh load discovers through its own register() call is not even waiting yet, so
  // the fresh load used to re-offer an "update" to a page already running the new
  // build — a bar no refresh could ever clear. When the served page's sha matches
  // the sha the server reports, the waiting worker IS this build, however it
  // arrived: take it silently, offer nothing.
  const plan = waitingWorkerPlan({
    pageSha: sha,
    deployedSha: deployed.sha,
    deployedSettled: deployed.settled,
  });

  useEffect(() => {
    if (plan !== "activate-silently" || silentlyActivatedRef.current) return;
    silentlyActivatedRef.current = true;
    // NO reload, and deliberately NOT `requestedRef` — this tab did not ask for
    // anything, so the controllerchange guard (#1806) leaves every tab, including
    // this one, exactly where it is. The page already has the new assets; the worker
    // just takes over the fetches that come after. A waiting worker the browser has
    // already discarded posts to nobody, which is fine: there is nothing left to
    // consume, and the pending state clears with it.
    //
    // THE TRADEOFF, RECORDED RATHER THAN HIDDEN: activation is registration-wide, so
    // another still-open tab on the OLD build loses the old asset cache when the new
    // worker's activate step drops it. That tab's unvisited-route chunks were already
    // doomed — the deploy removed them from the server — so this widens no failure
    // window; it only makes an existing one arrive sooner. #1906 is what that tab
    // hits, and how it recovers.
    const waiting = regRef.current?.waiting ?? installedRef.current;
    waiting?.postMessage({ type: SW_SKIP_WAITING });
    installedRef.current = null;
    setSwWaiting(false);
  }, [plan]);

  // Hand the pending state across the crash boundary (issue #1906). A tab with a
  // pending update is running a build whose hashed chunks the deploy has removed, so
  // a client navigation to a route it has not visited can throw ABOVE the route
  // group — and `app/global-error.tsx` replaces the root layout, meaning this
  // component is not mounted when that boundary has to decide whether what it caught
  // is deployment skew or a genuine crash. A per-tab marker is the only channel that
  // survives; the pending decision itself stays here, computed once.
  useEffect(() => {
    try {
      if (pending) {
        sessionStorage.setItem(UPDATE_PENDING_KEY, UPDATE_PENDING_MARKER);
      } else {
        sessionStorage.removeItem(UPDATE_PENDING_KEY);
      }
    } catch {
      // Storage can be denied outright (private mode, blocked cookies). The boundary
      // then reads no marker and renders its card, which is the pre-#1906 behaviour.
    }
  }, [pending]);

  const reload = useCallback(() => {
    if (reloadedRef.current) return;
    requestedRef.current = true;
    const waiting = regRef.current?.waiting ?? null;
    if (reloadPlanFor({ waitingWorker: !!waiting }) === "plain") {
      // Nothing to hand over to — the fallback detector's context, or a worker that
      // has already been resolved. Reload straight away; there is no handshake that
      // could be left half-finished behind us to re-offer this update afterwards.
      reloadedRef.current = true;
      window.location.reload();
      return;
    }
    // Ask the waiting worker to take over, so the reload lands on the new build…
    waiting?.postMessage({ type: SW_SKIP_WAITING });
    // …but answer the tap regardless: if the handshake doesn't produce a controller
    // change promptly, reload on the build we have. Guarded by the same
    // reloaded-once flag as the controllerchange path.
    window.setTimeout(() => {
      if (reloadedRef.current) return;
      reloadedRef.current = true;
      window.location.reload();
    }, SW_RELOAD_FALLBACK_MS);
  }, []);

  // The bar renders only when the plan is to OFFER: `wait` holds it for the single
  // sha read the decision above turns on (otherwise it would flash on every first
  // load after a deploy), and `activate-silently` never shows it at all — not even
  // for the paint between the read settling and the effect consuming the worker.
  if (!pending || dismissed || plan !== "offer") return null;
  return (
    <UpdateReadyBar
      onReload={reload}
      onDismiss={() => setDismissed(true)}
      unsavedWork={unsaved || hasUnsavedWork()}
      commitMessage={commitMessage}
    />
  );
}
