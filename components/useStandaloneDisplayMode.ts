"use client";

import { useSyncExternalStore } from "react";

const STANDALONE_QUERY = "(display-mode: standalone)";

function standaloneSnapshot(): boolean {
  return window.matchMedia(STANDALONE_QUERY).matches;
}

function subscribeToStandalone(onChange: () => void): () => void {
  const query = window.matchMedia(STANDALONE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

export function useStandaloneDisplayMode(): boolean {
  return useSyncExternalStore(
    subscribeToStandalone,
    standaloneSnapshot,
    () => false
  );
}
