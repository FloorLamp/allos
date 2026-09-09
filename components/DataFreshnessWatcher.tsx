"use client";

import { useEffect, useRef } from "react";
import { useChromeRefresh } from "./DirtyFormRegistry";

const CHECK_INTERVAL_MS = 15_000;
const REVISION = /^(0|[1-9]\d*)$/;

type FreshnessResponse = {
  profileId: number;
  revision: string;
};

function parsedResponse(value: unknown): FreshnessResponse | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<FreshnessResponse>;
  if (
    typeof candidate.profileId !== "number" ||
    !Number.isSafeInteger(candidate.profileId) ||
    typeof candidate.revision !== "string" ||
    !REVISION.test(candidate.revision)
  ) {
    return null;
  }
  return candidate as FreshnessResponse;
}

function renderedRevision(): string | null {
  const value = document
    .querySelector("main[data-write-revision]")
    ?.getAttribute("data-write-revision");
  return value && REVISION.test(value) ? value : null;
}

// One app-shell observer for committed writes from another request/process. It only
// observes while visible; DirtyFormProvider remains the sole owner of whether a
// resulting repaint runs now or waits for the current form to become clean.
export default function DataFreshnessWatcher({
  profileId,
}: {
  profileId: number;
}) {
  const chromeRefresh = useChromeRefresh();
  const generation = useRef(0);

  useEffect(() => {
    const currentGeneration = (generation.current += 1);
    let active = true;
    let interval: ReturnType<typeof setInterval> | undefined;
    let inFlight: Promise<void> | null = null;
    let flightIdentity: AbortController | null = null;
    let refusalRefreshRequested = false;
    let requestedRevision: string | null = null;
    let markerAtRequest: string | null = null;

    const current = () => active && generation.current === currentGeneration;

    const requestRefusalRefresh = () => {
      if (refusalRefreshRequested) return;
      refusalRefreshRequested = true;
      chromeRefresh();
    };

    const observe = (): Promise<void> => {
      if (document.hidden) return Promise.resolve();
      if (inFlight) return inFlight;
      const identity = new AbortController();
      const ownsVisibleFlight = () =>
        current() && !document.hidden && flightIdentity === identity;

      const request = (async () => {
        let response: Response;
        try {
          response = await fetch("/api/freshness", {
            cache: "no-store",
            headers: { Accept: "application/json" },
            signal: identity.signal,
          });
        } catch {
          return;
        }
        if (!ownsVisibleFlight()) return;
        if (response.status === 401 || response.status === 403) {
          requestRefusalRefresh();
          return;
        }
        if (!response.ok) return;

        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          return;
        }
        if (!ownsVisibleFlight()) return;
        const observed = parsedResponse(payload);
        if (!observed) return;
        if (observed.profileId !== profileId) {
          requestRefusalRefresh();
          return;
        }

        const rendered = renderedRevision();
        if (rendered === null) return;
        if (markerAtRequest !== rendered) {
          markerAtRequest = null;
          requestedRevision = null;
        }
        if (BigInt(observed.revision) <= BigInt(rendered)) return;
        if (
          requestedRevision === observed.revision &&
          markerAtRequest === rendered
        ) {
          return;
        }
        requestedRevision = observed.revision;
        markerAtRequest = rendered;
        chromeRefresh();
      })();
      const tracked = request.finally(() => {
        if (flightIdentity !== identity) return;
        flightIdentity = null;
        inFlight = null;
      });
      flightIdentity = identity;
      inFlight = tracked;
      return tracked;
    };

    const start = () => {
      if (document.hidden || interval !== undefined) return;
      void observe();
      interval = setInterval(() => void observe(), CHECK_INTERVAL_MS);
    };
    const stop = () => {
      if (interval !== undefined) clearInterval(interval);
      interval = undefined;
      // A response begun while visible does not own a decision after the page was
      // hidden. Detach it so resuming can observe immediately without waiting for
      // that old request to settle.
      flightIdentity?.abort();
      flightIdentity = null;
      inFlight = null;
    };
    const onVisibilityChange = () => {
      if (document.hidden) stop();
      else start();
    };
    const onPopState = () => {
      if (!document.hidden) void observe();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("popstate", onPopState);
    start();
    return () => {
      active = false;
      if (generation.current === currentGeneration) generation.current += 1;
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("popstate", onPopState);
    };
  }, [chromeRefresh, profileId]);

  return null;
}
