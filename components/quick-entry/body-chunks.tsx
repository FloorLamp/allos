"use client";

import { Component, type ReactNode } from "react";
import dynamic from "next/dynamic";

// ── THE BODY CHUNKS, AND THE TWO QUIET STATES AROUND THEM ────────────────────
//
// One subject in three parts, which is why they are one module: WHAT the quick-entry
// overlay loads on demand (`loadBodies`), what it prints while a chunk is still in
// flight (`QUICK_ENTRY_LOADING`), and what it prints when one never arrives
// (`BodyBoundary` and the `QuickEntryError` it renders, whose Retry asks for a fresh
// attempt — `loadBodies(attempt + 1)` and a remount key, so the whole recovery story
// is here). `QUIET_STATE_CLASS` is the paragraph voice those two states speak in, and
// the host's other standing paragraphs — the as-of line, the unavailable line — speak
// it too.
//
// Split out of components/QuickEntryProvider.tsx, which is the host's state machine
// and is over the 1,500-line rule: this is a self-contained subject that machine only
// consumes, and moving it changes nothing about what loads or when.

export const QUIET_STATE_CLASS = "text-sm text-slate-500 dark:text-slate-400";

// The sheet's cold-open paragraph, in ONE place: the Suspense fallback below and the
// body's own loading branch are the same wait, and they must not be able to differ —
// `quick-entry-loading` is the testid every spec waits on.
export const QUICK_ENTRY_LOADING = (
  <p data-testid="quick-entry-loading" className={QUIET_STATE_CLASS}>
    Loading…
  </p>
);

export function QuickEntryError({ onRetry }: { onRetry: () => void }) {
  return (
    <div data-testid="quick-entry-error">
      <p role="alert" className={QUIET_STATE_CLASS}>
        Couldn&apos;t open that form.
      </p>
      <button
        type="button"
        data-testid="quick-entry-retry"
        onClick={onRetry}
        className="btn-ghost mt-2"
      >
        Retry
      </button>
    </div>
  );
}

// The newest bodies load ON DEMAND (#1525/#1633/#1892). This host is mounted on every
// route, and its promise is that it COSTS NOTHING until opened — a promise about
// JavaScript as much as about queries. The forms it already carried are small and
// shared with pages the shell links to anyway; the upload form and the practice list
// each drag in machinery (the file/camera inputs and the toast lifecycle, the
// practice button's modal and date field) that no page-load should pay for. Both are
// only rendered AFTER `loadQuickEntry` resolves, so the chunk fetch overlaps a round
// trip that was already happening and costs nothing perceptible.
export function loadBodies(attempt: number) {
  return {
    attempt,
    UploadForm: dynamic(() => import("../UploadForm")),
    QuickPracticeList: dynamic(() => import("./QuickPracticeList")),
    QuickCyclePanel: dynamic(() => import("./QuickCyclePanel")),
    MoodForm: dynamic(() => import("../mood/MoodForm")),
    StoolTypeControl: dynamic(() => import("../stool/StoolTypeControl")),
    QuickSubstanceList: dynamic(() => import("./QuickSubstanceList")),
    QuickSymptomPanel: dynamic(() => import("./QuickSymptomPanel")),
    IntakeItemForm: dynamic(async () => {
      const [{ default: IntakeItemForm }, { addIntakeItem }] =
        await Promise.all([
          import("../IntakeItemForm"),
          import("@/app/(app)/nutrition/intake-actions"),
        ]);
      return function QuickEntryIntakeItemForm(
        props: Omit<React.ComponentProps<typeof IntakeItemForm>, "action">
      ) {
        return <IntakeItemForm {...props} action={addIntakeItem} />;
      };
    }),
  };
}

export type Bodies = ReturnType<typeof loadBodies>;

export class BodyBoundary extends Component<
  { children: ReactNode; onRetry: () => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <QuickEntryError onRetry={this.props.onRetry} />;
  }
}
