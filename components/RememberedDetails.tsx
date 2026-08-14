"use client";

import { useEffect, useRef, type ReactNode } from "react";
import {
  DISCLOSURES,
  DISCLOSURE_MEMORY_KEY,
  disclosureOpen,
  parseDisclosureMemory,
  rememberDisclosure,
  serializeDisclosureMemory,
  type DisclosureId,
  type DisclosureMemory,
} from "@/lib/disclosure-memory";

// The I/O half of disclosure memory (#2652 behavior 3). Everything that DECIDES
// anything is in lib/disclosure-memory.ts — including WHY this state is per-device
// localStorage and not a `login_settings` row. This file only reads, writes, and
// restores.
//
// PROGRESSIVE ENHANCEMENT, deliberately. The element rendered is a plain native
// `<details>` with its declared default already applied on the server, exactly the
// markup the stateless folds shipped: it opens with JS disabled, browser in-page find
// still auto-expands it, and the keyboard behavior is the platform's. Memory is applied
// AFTER hydration by setting `open` on the real element — never by rendering different
// markup on the client, which would be a hydration mismatch and, worse, would make the
// fold's state depend on a script arriving.
//
// REDUCED MOTION (#2654): restoring is a state assignment, not an animation. There is no
// height transition to miss and both states are legible standing still.
//
// The store is read lazily and cached per tab, and cross-tab writes are picked up via
// the `storage` event so two open tabs on one device do not disagree.

let cached: DisclosureMemory | undefined;

function readMemory(): DisclosureMemory {
  if (cached !== undefined) return cached;
  try {
    cached = parseDisclosureMemory(
      window.localStorage.getItem(DISCLOSURE_MEMORY_KEY)
    );
  } catch {
    // Private-mode / disabled storage: remember nothing, stay interactive.
    cached = {};
  }
  return cached;
}

function writeMemory(next: DisclosureMemory): void {
  cached = next;
  try {
    window.localStorage.setItem(
      DISCLOSURE_MEMORY_KEY,
      serializeDisclosureMemory(next)
    );
  } catch {
    // Persistence is a nicety; the current page keeps working without it.
  }
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
   * An explicit state from the caller. Supplied → it WINS and nothing is remembered
   * for this render (the URL/parent-beats-memory precedence of #2652 §4). Omitted →
   * the declared default renders and memory fills it in after hydration.
   */
  defaultOpen?: boolean;
  className?: string;
  testId?: string;
  /** The `<summary>` contents. Always rendered, so the effective state is visible. */
  summary: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const remembering = defaultOpen === undefined;

  // Re-applied after EVERY render, not just on mount: React owns the `open` attribute it
  // rendered, so a parent re-render would otherwise snap a remembered fold back shut.
  useEffect(() => {
    const el = ref.current;
    if (!el || !remembering) return;
    const want = disclosureOpen(readMemory(), id, { instance });
    if (el.open !== want) el.open = want;
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // An explicit caller state is not memory's to overwrite or to record.
    if (!remembering) return;

    const apply = () => {
      const want = disclosureOpen(readMemory(), id, { instance });
      if (el.open !== want) el.open = want;
    };

    const onToggle = () => {
      writeMemory(rememberDisclosure(readMemory(), id, el.open, instance));
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== DISCLOSURE_MEMORY_KEY) return;
      cached = undefined;
      apply();
    };
    el.addEventListener("toggle", onToggle);
    window.addEventListener("storage", onStorage);
    return () => {
      el.removeEventListener("toggle", onToggle);
      window.removeEventListener("storage", onStorage);
    };
  }, [id, instance, remembering]);

  return (
    <details
      ref={ref}
      className={className}
      data-testid={testId}
      data-disclosure={id}
      open={defaultOpen ?? DISCLOSURES[id].defaultOpen}
    >
      {summary}
      {children}
    </details>
  );
}
