"use client";

import { useSyncExternalStore } from "react";
import { formatRelativeTime } from "@/lib/format-date";

// ONE 30-SECOND CLOCK for every "N ago" on the page, so two labels about the same
// moment never disagree. Null on the server and in the hydrating render; callers
// paint their server value there and the clock takes over on mount.
const listeners = new Set<() => void>();
let current: number | null = null;
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    current = Date.now();
    timer = setInterval(() => {
      current = Date.now();
      listeners.forEach((notify) => notify());
    }, 30_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    clearInterval(timer);
    current = null;
  };
}

export function useClock(): number | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null
  );
}

// Callers suppress hydration differences on the text node: server and client
// can straddle a time boundary.
export function useRelativeLabel(value: string): string {
  const now = useClock();
  return formatRelativeTime(value, now == null ? undefined : new Date(now));
}
