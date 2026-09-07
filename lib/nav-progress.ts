// One progress and retry state for the current navigation. Instrumentation owns
// start/history-commit signals; NavProgress subscribes through useSyncExternalStore.

export const NAV_PROGRESS_THRESHOLD_MS = 300;

export type NavProgressPhase = "idle" | "waiting" | "slow" | "failed";

type Listener = () => void;

let phase: NavProgressPhase = "idle";
let navigation = 0;
const listeners = new Set<Listener>();
let thresholdTimer: ReturnType<typeof setTimeout> | null = null;
// Resolved when the person (or a restored connection) asks the held fetch to go
// again. `lib/nav-fetch-guard.ts` awaits it; nothing else may resolve it.
let retryWaiter: (() => void) | null = null;

function emit(next: NavProgressPhase) {
  if (phase === next) return;
  phase = next;
  for (const listener of listeners) listener();
}

function clearThresholdTimer() {
  if (thresholdTimer !== null) {
    clearTimeout(thresholdTimer);
    thresholdTimer = null;
  }
}

export function subscribeNavProgress(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getNavProgress(): NavProgressPhase {
  return phase;
}

export function getServerNavProgress(): NavProgressPhase {
  return "idle";
}

export function startNavProgress(): void {
  navigation++;
  clearThresholdTimer();
  // A new navigation supersedes whatever the previous one was waiting on: its
  // held fetch is abandoned (see the guard), so its failure state must not stay
  // on screen over a navigation that is now running fine.
  retryWaiter = null;
  emit("waiting");
  thresholdTimer = setTimeout(() => {
    thresholdTimer = null;
    if (phase === "waiting") emit("slow");
  }, NAV_PROGRESS_THRESHOLD_MS);
}

export function settleNavProgress(): void {
  clearThresholdTimer();
  retryWaiter = null;
  emit("idle");
}

export function failNavProgress(): void {
  clearThresholdTimer();
  emit("failed");
}

export function retryNavProgress(): void {
  if (phase !== "failed") return;
  const waiter = retryWaiter;
  retryWaiter = null;
  emit("slow");
  waiter?.();
}

export function awaitNavRetry(): Promise<void> {
  return new Promise<void>((resolve) => {
    retryWaiter = resolve;
  });
}

export function resetNavProgress(): void {
  navigation++;
  clearThresholdTimer();
  retryWaiter = null;
  phase = "idle";
  listeners.clear();
}

declare global {
  interface Window {
    __allosNavProgress?: true;
  }
}

// Next commits routes through History, including replaceState for the same URL.
// Install before its own wrappers so their native calls reach this observer.
export function installNavProgress(win: Window = window): void {
  if (win.__allosNavProgress) return;
  win.__allosNavProgress = true;
  for (const method of ["pushState", "replaceState"] as const) {
    const original = win.history[method];
    win.history[method] = function (this: History, ...args) {
      original.apply(this, args);
      // State-only entries, such as Back-to-close overlays, are not route commits.
      if (args[2] == null) return;
      const committed = navigation;
      // HistoryUpdater runs in an insertion effect; notify React after its commit.
      queueMicrotask(() => {
        if (navigation === committed) settleNavProgress();
      });
    };
  }
}
