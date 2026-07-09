"use client";

import { useEffect } from "react";

// Registers the hand-rolled service worker (public/sw.js) — Next 14's App Router
// has no first-party SW story, so we register it ourselves from the root layout.
// The worker gives the app an installable, offline-tolerant shell: it caches
// immutable build assets and shows a friendly offline page for navigations that
// fail (see public/sw.js for the deliberately conservative caching policy — it
// never touches /api, /settings, /login, or medical/PHI responses).
//
// `version` is the running commit sha; we pass it as a ?v= query so a deploy
// changes the worker's script URL, which triggers an update + cache swap.
export default function ServiceWorkerRegister({
  version,
}: {
  version: string;
}) {
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

    // Register after load so the SW install never contends with first paint.
    // We only reach here in production (the non-prod branch above unregisters and
    // returns), and we deliberately do NOT pass a dev signal (?dev=1) — the
    // worker's IS_DEV is keyed on that explicit flag, not on the `version` value,
    // so a prod deploy whose COMMIT_SHA is missing (version falls back to "dev")
    // still gets the full offline shell instead of a silently disabled PWA.
    const register = () => {
      navigator.serviceWorker
        .register(`/sw.js?v=${encodeURIComponent(version)}`)
        .catch(() => {
          // A failed registration (e.g. private mode, unsupported) is non-fatal:
          // the app works fine online without the offline shell.
        });
    };
    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register, { once: true });
      return () => window.removeEventListener("load", register);
    }
  }, [version]);

  return null;
}
