"use client";

import { useCallback, useSyncExternalStore } from "react";
import { MEDIA_QUERIES, type MediaQuery } from "@/lib/media-queries";

const queries: Partial<
  Record<MediaQuery, { list: MediaQueryList; subscribers: number }>
> = {};

function query(key: MediaQuery) {
  if (typeof window === "undefined" || !window.matchMedia) return;
  return (queries[key] ??= {
    list: window.matchMedia(MEDIA_QUERIES[key]),
    subscribers: 0,
  });
}

const serverSnapshot = () => false;

// Responsive behavior shares a live query across mounted consumers. CSS still
// owns responsive layout. SSR and the first hydration render both answer false.
export function useMediaQuery(key: MediaQuery): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const current = query(key);
      if (!current) return () => {};
      current.subscribers++;
      current.list.addEventListener("change", onChange);
      return () => {
        current.list.removeEventListener("change", onChange);
        if (--current.subscribers === 0) delete queries[key];
      };
    },
    [key]
  );
  const snapshot = useCallback(() => query(key)?.list.matches ?? false, [key]);
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
