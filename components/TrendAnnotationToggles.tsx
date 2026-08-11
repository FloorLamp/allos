"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import AnnotationToggleBar from "./AnnotationToggleBar";
import { useLatestRef } from "./useLatestRef";
import type { AnnotationKind } from "@/lib/trend-annotations";
import {
  TREND_ANNOTATION_VISIBILITY_KEY,
  defaultAnnotationVisibility,
  parseAnnotationVisibility,
  serializeAnnotationVisibility,
  type AnnotationVisibility,
} from "@/lib/trend-annotation-visibility";

const ANNOTATION_VISIBILITY_CHANGED = "allos:annotation-visibility-changed";
const DEFAULT_VISIBILITY_SNAPSHOT = serializeAnnotationVisibility(
  defaultAnnotationVisibility()
);
let visibilitySnapshot: string | undefined;

function readVisibilitySnapshot(): string {
  if (visibilitySnapshot !== undefined) return visibilitySnapshot;
  try {
    visibilitySnapshot =
      window.localStorage.getItem(TREND_ANNOTATION_VISIBILITY_KEY) ??
      DEFAULT_VISIBILITY_SNAPSHOT;
  } catch {
    visibilitySnapshot = DEFAULT_VISIBILITY_SNAPSHOT;
  }
  return visibilitySnapshot;
}

function serverVisibilitySnapshot(): string {
  return DEFAULT_VISIBILITY_SNAPSHOT;
}

function subscribeVisibility(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== TREND_ANNOTATION_VISIBILITY_KEY) return;
    visibilitySnapshot = event.newValue ?? DEFAULT_VISIBILITY_SNAPSHOT;
    onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(ANNOTATION_VISIBILITY_CHANGED, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(ANNOTATION_VISIBILITY_CHANGED, onChange);
  };
}

const subscribeInactive = () => () => {};

function publishVisibility(next: AnnotationVisibility): void {
  const raw = serializeAnnotationVisibility(next);
  visibilitySnapshot = raw;
  try {
    window.localStorage.setItem(TREND_ANNOTATION_VISIBILITY_KEY, raw);
  } catch {
    // Keep the current page interactive even when persistence is unavailable.
  }
  window.dispatchEvent(new Event(ANNOTATION_VISIBILITY_CHANGED));
}

// The Trends hub's event-annotation / protocol-window toggles, HOISTED (issue
// #1493 A).
//
// WHAT WAS WRONG. Every chart host owned its own copy of the toggle state and
// rendered its own "Events · Medications · Appointments · Situations · Protocols"
// pill row directly above its charts. At 390px that row wraps to two lines and
// costs ~60px of STANDING chrome — on the body census chart stack and again inside
// the compare block — for a control that is touched about once a session. It is
// the same finding #1485 F made about the range pills, one level down: what has to
// be visible is the chart's context, and these toggles are a control, not a label.
//
// WHAT THIS IS. One state model for the page, shared by every chart host on it, with
// the pill row rendered ONCE — inside the context bar's EXPANDED controls, beside
// the range pills and the tab strip, where it costs nothing until asked for. Not a
// second annotation state that has to be kept in sync with the charts': the hosts
// stop holding their own and read this one, so "no fork" is structural rather than
// a convention.
//
// PROVIDER-OPTIONAL, ON PURPOSE. The same chart hosts render on surfaces that have
// no context bar to hoist into (the biomarker detail page). `useAnnotationToggles`
// therefore falls back to LOCAL state and tells its caller (`hoisted: false`) to
// render its own bar, exactly as before. A host needs no knowledge of which surface
// it is on, and no `hidden`/`sm:hidden` pair of hand-mirrored bars exists anywhere.
//
// The toggles are display state, not window state, so they stay OUT of the
// collapsed context LABEL (lib/trends-context.ts): the label answers "which tab,
// which window", and a filter that hides a marker does not change what the charts
// are OF. Nothing here touches the URL. Visibility is a per-device preference in
// localStorage, shared by the provider and provider-less detail charts.

interface AnnotationToggleContext {
  enabled: Record<AnnotationKind, boolean>;
  toggle: (kind: AnnotationKind) => void;
  present: AnnotationKind[];
  register: (kinds: AnnotationKind[]) => void;
}

const Ctx = createContext<AnnotationToggleContext | null>(null);

function usePersistedVisibility(
  active = true
): [AnnotationVisibility, (kind: AnnotationKind) => void] {
  const raw = useSyncExternalStore(
    active ? subscribeVisibility : subscribeInactive,
    active ? readVisibilitySnapshot : serverVisibilitySnapshot,
    serverVisibilitySnapshot
  );
  const enabled = useMemo(() => parseAnnotationVisibility(raw), [raw]);
  const toggle = useCallback((kind: AnnotationKind) => {
    // Read the store at the interaction boundary so two rapid toggles compose even
    // before React has rendered the first external-store notification.
    const current = parseAnnotationVisibility(readVisibilitySnapshot());
    publishVisibility({ ...current, [kind]: !current[kind] });
  }, []);

  return [enabled, toggle];
}

/** A stable, order-independent identity for a kind set, so registration can be an
 *  effect without re-firing on every render's fresh array. */
function kindsKey(kinds: readonly AnnotationKind[]): string {
  return [...kinds].sort().join(",");
}

// Wraps the whole hub — the context bar AND the tab panel — so the control and the
// charts it governs share one state. `children` is mostly server-rendered content
// passed straight through.
export function TrendAnnotationProvider({ children }: { children: ReactNode }) {
  const [enabled, toggle] = usePersistedVisibility();
  // Which kinds actually have markers on this page's charts. Empty until a host
  // registers, which is what keeps the control off a tab that has no annotated
  // chart (Overview, Nutrition) instead of showing dead pills there.
  const [present, setPresent] = useState<AnnotationKind[]>([]);

  const register = useCallback((kinds: AnnotationKind[]) => {
    setPresent((prev) => (kindsKey(prev) === kindsKey(kinds) ? prev : kinds));
  }, []);

  const value = useMemo(
    () => ({ enabled, toggle, present, register }),
    [enabled, toggle, present, register]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * The toggle row, rendered where the page wants it (the context bar's expanded
 * controls). Renders nothing until a chart host on the page has registered the
 * kinds it actually has markers for — a toggle for a kind with no markers is dead
 * weight, which is the rule AnnotationToggleBar already enforced per-host.
 */
export function TrendAnnotationControls() {
  const ctx = useContext(Ctx);
  if (!ctx || ctx.present.length === 0) return null;
  return (
    <div data-testid="trend-annotation-controls">
      <AnnotationToggleBar
        kinds={ctx.present}
        enabled={ctx.enabled}
        onToggle={ctx.toggle}
      />
    </div>
  );
}

/**
 * What a chart host calls. Give it the kinds present in ITS marker set; get back
 * the enabled map to filter with, the toggle handler, and whether the pill row is
 * being rendered for it elsewhere.
 *
 *   hoisted === true  → a provider owns the control; render charts only.
 *   hoisted === false → no provider on this surface; render your own bar with the
 *                       returned state (the pre-#1493 behavior, unchanged).
 */
export function useAnnotationToggles(present: AnnotationKind[]): {
  enabled: Record<AnnotationKind, boolean>;
  onToggle: (kind: AnnotationKind) => void;
  hoisted: boolean;
} {
  const ctx = useContext(Ctx);
  const [local, onToggleLocal] = usePersistedVisibility(ctx == null);
  // The effect fires on a CHANGE of kind set, not on every render's fresh array —
  // hence the sorted key in the deps. The array itself rides a ref so the pills keep
  // the host's DISPLAY order (annotationKindsPresent sorts them by kind, not
  // alphabetically) rather than the key's sort.
  const key = kindsKey(present);
  const register = ctx?.register;
  const presentRef = useLatestRef(present);
  useEffect(() => {
    register?.(presentRef.current);
  }, [register, key, presentRef]);

  if (ctx) {
    return { enabled: ctx.enabled, onToggle: ctx.toggle, hoisted: true };
  }
  return { enabled: local, onToggle: onToggleLocal, hoisted: false };
}
