"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import UpdateReadyBar from "./UpdateReadyBar";
import { useDeployedVersion, type VersionWatchMode } from "./useDeployedVersion";
import {
  deployDetectorFor,
  reloadPlanFor,
  resolveUpdateState,
  shouldOfferUpdate,
  shouldReloadOnControllerChange,
  SW_RELOAD_FALLBACK_MS,
  SW_SKIP_WAITING,
  UPDATE_CHECK_MS,
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
//   * at most one reload per activation (the loop guard).
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
// The decisions live in lib/sw-update.ts so they can be tested without a browser.
export default function ServiceWorkerRegister({ sha }: { sha: string | null }) {
  const [swWaiting, setSwWaiting] = useState(false);
  const [swStatus, setSwStatus] = useState<ServiceWorkerStatus>("probing");
  // The live registration. The tap re-reads `.waiting` off it rather than holding a
  // ServiceWorker object from offer time: the browser can replace or discard a
  // waiting worker in between, and a message to that stale object goes nowhere.
  const regRef = useRef<ServiceWorkerRegistration | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [unsaved, setUnsaved] = useState(false);
  // This tab asked for the update; only it may reload on controllerchange.
  const requestedRef = useRef(false);
  const reloadedRef = useRef(false);

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
      setSwWaiting(true);
    };

    const onControllerChange = () => {
      if (
        shouldReloadOnControllerChange({
          requestedByThisTab: requestedRef.current,
          alreadyReloaded: reloadedRef.current,
        })
      ) {
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
  const deployed = useDeployedVersion({ baseline: sha, mode });

  const { pending, commitMessage } = resolveUpdateState({
    swWaiting,
    baselineSha: sha,
    deployedSha: deployed.sha,
    deployedMessage: deployed.commitMessage,
  });

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

  if (!pending || dismissed) return null;
  return (
    <UpdateReadyBar
      onReload={reload}
      onDismiss={() => setDismissed(true)}
      unsavedWork={unsaved || hasUnsavedWork()}
      commitMessage={commitMessage}
    />
  );
}
