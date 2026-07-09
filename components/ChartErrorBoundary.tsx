"use client";

import { Component, type ReactNode } from "react";

// Containment for the code-split chart bundles. The chart components are loaded
// via next/dynamic (React.lazy), and a lazy chunk that fails to fetch — the
// browser going offline right after page load is the common case — REJECTS the
// import promise, which throws to the nearest error boundary. Without this local
// boundary that was the ROUTE error boundary, so a missing chart chunk replaced
// the whole page ("Something went wrong"), unmounting unrelated UI like the
// body-metrics quick-log form mid-interaction (the offline-queue e2e caught it).
// Charts are progressive enhancement; losing one must never take the page down.
//
// Self-healing: when the browser comes back online, the boundary resets and the
// lazy import retries (webpack re-requests a failed chunk on the next render).
export default class ChartErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  private onOnline = () => {
    if (this.state.failed) this.setState({ failed: false });
  };

  componentDidMount() {
    window.addEventListener("online", this.onOnline);
  }

  componentWillUnmount() {
    window.removeEventListener("online", this.onOnline);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

// The shared failure fallback: fills the chart's box like ChartLoading, but says
// what actually happened. Rendered only when the chunk fetch failed (offline /
// flaky network); the boundary swaps back automatically on reconnect.
export function ChartUnavailable({
  heightClass = "h-64",
}: {
  heightClass?: string;
}) {
  return (
    <div
      className={`flex ${heightClass} w-full items-center justify-center text-sm text-slate-400 dark:text-slate-500`}
    >
      Chart unavailable — it will load when you&apos;re back online.
    </div>
  );
}
