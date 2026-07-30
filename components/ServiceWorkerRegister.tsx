"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import UpdateReadyBar from "./UpdateReadyBar";
import {
  SW_SKIP_WAITING,
  shouldReloadOnControllerChange,
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
// `version` is the running commit sha; we pass it as a ?v= query so a deploy changes
// the worker's script URL, which triggers an update.
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
//
// The decisions live in lib/sw-update.ts so they can be tested without a browser.
export default function ServiceWorkerRegister({
  version,
}: {
  version: string;
}) {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [unsaved, setUnsaved] = useState(false);
  // This tab asked for the update; only it may reload on controllerchange.
  const requestedRef = useRef(false);
  const reloadedRef = useRef(false);

  useEffect(() => subscribeUnsavedWork(setUnsaved), []);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
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
      return;
    }

    let disposed = false;

    // A worker that is installed but not yet controlling is an update WAITING for
    // this page — but only if the page is currently controlled. With no controller
    // there is no running build to replace: that is a first install, which activates
    // and claims on its own and has nothing to ask the user about.
    const offer = (sw: ServiceWorker | null) => {
      if (disposed || !sw) return;
      if (!navigator.serviceWorker.controller) return;
      setWaiting(sw);
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

    // Register after load so the SW install never contends with first paint. We only
    // reach here in production (the non-prod branch above unregisters and returns),
    // and we deliberately do NOT pass a dev signal (?dev=1) — the worker's IS_DEV is
    // keyed on that explicit flag, not on the `version` value, so a prod deploy whose
    // COMMIT_SHA is missing (version falls back to "dev") still gets the full offline
    // shell instead of a silently disabled PWA.
    const register = () => {
      navigator.serviceWorker
        .register(`/sw.js?v=${encodeURIComponent(version)}`)
        .then((registration) => {
          if (disposed) return;
          offer(registration.waiting);
          registration.addEventListener("updatefound", () => {
            const installing = registration.installing;
            if (!installing) return;
            installing.addEventListener("statechange", () => {
              if (installing.state === "installed") offer(installing);
            });
          });
        })
        .catch(() => {
          // A failed registration (e.g. private mode, unsupported) is non-fatal:
          // the app works fine online without the offline shell.
        });
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });

    return () => {
      disposed = true;
      window.removeEventListener("load", register);
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        onControllerChange
      );
    };
  }, [version]);

  const reload = useCallback(() => {
    if (!waiting) return;
    requestedRef.current = true;
    waiting.postMessage({ type: SW_SKIP_WAITING });
    // The reload itself waits for `controllerchange`, so the new worker is serving
    // before the page asks it for anything.
  }, [waiting]);

  if (!waiting || dismissed) return null;
  return (
    <UpdateReadyBar
      onReload={reload}
      onDismiss={() => setDismissed(true)}
      unsavedWork={unsaved || hasUnsavedWork()}
    />
  );
}
