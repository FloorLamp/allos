"use client";

import { useCallback, useSyncExternalStore, type ReactNode } from "react";
import {
  DISCLOSURES,
  DISCLOSURE_KEY_ATTR,
  DISCLOSURE_MEMORY_KEY,
  disclosureKey,
  disclosureOpen,
  parseDisclosureMemory,
  rememberDisclosure,
  serializeDisclosureMemory,
  type DisclosureId,
  type DisclosureMemory,
} from "@/lib/disclosure-memory";

// The I/O half of disclosure memory (#2652 behavior 3). Everything that DECIDES anything
// is in lib/disclosure-memory.ts — including WHY this state is per-device localStorage
// and not a `login_settings` row. This file only reads, writes and subscribes.
//
// The element rendered is a plain native `<details>`: it opens with JS disabled, browser
// in-page find still auto-expands it, and the keyboard behavior is the platform's. The
// server renders the DECLARED DEFAULT, so the markup is the same one the stateless folds
// shipped; memory takes over after hydration.
//
// STORE-BACKED, NOT IMPERATIVE, and that is a bug fix rather than a style choice. An
// earlier version set `open` on the element from an effect. A `<details>` fires `toggle`
// ASYNCHRONOUSLY, so any re-render landing between the user's click and that event saw
// memory still holding the old value and snapped the fold shut under them. Here the same
// `useSyncExternalStore` snapshot drives the `open` prop AND is written by `onToggle`, so
// React's idea of the state and the stored one cannot get out of order. (Same shape as
// components/TrendAnnotationToggles.tsx.)
//
// REDUCED MOTION (#2654): restoring is a state, not a transition. Nothing here animates,
// and both states are legible standing still.

const MEMORY_CHANGED = "allos:disclosure-memory-changed";
const EMPTY = "{}";
let snapshot: string | undefined;

function readSnapshot(): string {
  if (snapshot !== undefined) return snapshot;
  try {
    snapshot = window.localStorage.getItem(DISCLOSURE_MEMORY_KEY) ?? EMPTY;
  } catch {
    // Private-mode / disabled storage: remember nothing, stay interactive.
    snapshot = EMPTY;
  }
  return snapshot;
}

// Before hydration there is no device to read, so every fold takes its declared default.
function serverSnapshot(): string {
  return EMPTY;
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== DISCLOSURE_MEMORY_KEY) return;
    // Another tab on this device wrote; adopt it so two tabs do not disagree.
    snapshot = event.newValue ?? EMPTY;
    onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(MEMORY_CHANGED, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(MEMORY_CHANGED, onChange);
  };
}

function publish(next: DisclosureMemory): void {
  const raw = serializeDisclosureMemory(next);
  if (raw === snapshot) return;
  snapshot = raw;
  try {
    window.localStorage.setItem(DISCLOSURE_MEMORY_KEY, raw);
  } catch {
    // Persistence is a nicety; the page stays interactive without it.
  }
  window.dispatchEvent(new Event(MEMORY_CHANGED));
}

export default function RememberedDetails({
  id,
  instance,
  defaultOpen,
  className,
  testId,
  summary,
  children,
}: {
  id: DisclosureId;
  /** Distinguishes one instance of an instanced disclosure from another. */
  instance?: string;
  /**
   * An explicit state from the caller. Supplied → it WINS and nothing is remembered for
   * this fold (the URL/parent-beats-memory precedence of #2652 §4). Omitted → the
   * declared default renders and memory fills it in after hydration.
   */
  defaultOpen?: boolean;
  className?: string;
  testId?: string;
  /** The `<summary>` element. Always rendered, so the effective state stays visible. */
  summary: ReactNode;
  children: ReactNode;
}) {
  const remembering = defaultOpen === undefined;
  const raw = useSyncExternalStore(subscribe, readSnapshot, serverSnapshot);
  const open = remembering
    ? disclosureOpen(parseDisclosureMemory(raw), id, { instance })
    : defaultOpen;

  const onToggle = useCallback(
    (event: React.SyntheticEvent<HTMLDetailsElement>) => {
      if (!remembering) return;
      publish(
        rememberDisclosure(
          parseDisclosureMemory(readSnapshot()),
          id,
          event.currentTarget.open,
          instance
        )
      );
    },
    [id, instance, remembering]
  );

  return (
    <details
      className={className}
      data-testid={testId}
      data-disclosure={id}
      // The stored key, for DISCLOSURE_BOOT_SCRIPT to match on before first paint. Only
      // present when this fold is actually remembering — a caller-controlled fold must
      // stay invisible to the restore.
      {...(remembering
        ? { [DISCLOSURE_KEY_ATTR]: disclosureKey(id, instance) }
        : {})}
      open={open ?? DISCLOSURES[id].defaultOpen}
      onToggle={onToggle}
    >
      {summary}
      {children}
    </details>
  );
}
