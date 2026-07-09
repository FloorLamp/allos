"use client";

import { useState } from "react";

// Admin-only lazy viewer for a sync event's captured raw provider payload (issue
// #9). Rendered behind a <details> so nothing is fetched until the admin expands
// it; on first open it GETs the profile-scoped, admin-gated raw route and shows the
// pretty JSON. Only mounted when `isAdmin && ev.raw_ref` (see ReviewInbox), so the
// affordance never appears for members.
export default function RawPayloadViewer({ id }: { id: number }) {
  const [state, setState] = useState<"idle" | "loading" | "loaded" | "error">(
    "idle"
  );
  const [text, setText] = useState("");

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

  return (
    <details
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
      {state === "loaded" && (
        <pre className="mt-1 max-h-96 overflow-auto rounded-lg bg-slate-900/95 p-3 text-xs leading-relaxed text-slate-100 dark:bg-black/60">
          {text}
        </pre>
      )}
    </details>
  );
}
