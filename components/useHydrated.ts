"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

// A hydration boundary is an external-store transition, not component state.
// React uses the server snapshot for SSR + the first hydration pass, then reads
// the client snapshot without a setState-in-effect cascade.
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
}
