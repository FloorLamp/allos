"use client";

import { useEffect, useRef, useState } from "react";
import RawDataViewer from "@/components/RawDataViewer";

// Admin-only lazy viewer for a sync event's captured raw provider payload (issue
// #9). Rendered behind a <details> so nothing is fetched until the admin expands
// it; on first open it GETs the profile-scoped, admin-gated raw route and hands the
// loaded body to the shared RawDataViewer (#1318) — a collapsible JSON/XML tree with
// copy — instead of a flat <pre>. Only mounted when `isAdmin && ev.raw_ref` (see
// ReviewInbox), so the affordance never appears for members.
export default function RawPayloadViewer({ id }: { id: number }) {
  const [state, setState] = useState<"idle" | "loading" | "loaded" | "error">(
    "idle"
  );
  const [text, setText] = useState("");
  const detailsRef = useRef<HTMLDetailsElement>(null);

  async function load() {
    if (state === "loading" || state === "loaded") return;
    setState("loading");
    try {
      const res = await fetch(`/api/integrations/raw/${id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setText(await res.text());
      setState("loaded");
    } catch (err) {
      setText(err instanceof Error ? err.message : String(err));
      setState("error");
    }
  }

  // Hydration catch-up: a click can land BEFORE React attaches onToggle (a fast
  // test runner, or a real user on a slow connection while the page is still
  // hydrating). The native <details> opens without React ever seeing the toggle,
  // so the fetch never fires and the panel sits open and empty forever. If the
  // element is already open when this component mounts, run the load it missed.
  useEffect(() => {
    if (detailsRef.current?.open) void load();
    // Mount-only catch-up; load() self-guards against re-entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <details
      ref={detailsRef}
      className="mt-1 w-full"
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open) void load();
      }}
    >
      <summary className="cursor-pointer text-xs font-medium text-brand-600 hover:underline dark:text-brand-400">
        View raw
      </summary>
      {state === "loading" && (
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Loading…
        </p>
      )}
      {state === "error" && (
        <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">
          Couldn’t load raw payload ({text}).
        </p>
      )}
      {state === "loaded" && <RawDataViewer text={text} />}
    </details>
  );
}
