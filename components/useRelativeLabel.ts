"use client";

import { useEffect, useState } from "react";
import { formatRelativeTime } from "@/lib/format-date";

// Callers suppress hydration differences on the text node: server and client
// can straddle a time boundary. Refresh on mount, value changes, and every 30s.
export function useRelativeLabel(value: string): string {
  const [label, setLabel] = useState(() => formatRelativeTime(value));
  useEffect(() => {
    const tick = () => setLabel(formatRelativeTime(value));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [value]);
  return label;
}
