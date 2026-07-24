"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { IconArrowRight } from "@tabler/icons-react";
import { loadSyncRows } from "@/app/(app)/data/review-actions";
import type { SyncRowLink } from "@/lib/queries";

// "What this sync wrote" drill-in (issue #1333, deferred part 2 of #1212). Behind a
// <details> so nothing is queried until the user expands it; on first open it calls
// the profile-scoped loadSyncRows action and lists the records the sync inserted/
// updated, each a typed deep link (#285) to the surface that owns it (a timeline day,
// or Results for a lab). Mirrors RawPayloadViewer's lazy on-open fetch + hydration
// catch-up. Rendered only for a successful sync that actually wrote rows; a legacy
// sync (pre-#1333) has no provenance and shows a graceful "not recorded" note.
export default function SyncRowsDrilldown({
  eventId,
  count,
}: {
  eventId: number;
  count: number;
}) {
  const [state, setState] = useState<"idle" | "loading" | "loaded" | "error">(
    "idle"
  );
  const [rows, setRows] = useState<SyncRowLink[]>([]);
  const detailsRef = useRef<HTMLDetailsElement>(null);

  async function load() {
    if (state === "loading" || state === "loaded") return;
    setState("loading");
    try {
      setRows(await loadSyncRows(eventId));
      setState("loaded");
    } catch {
      setState("error");
    }
  }

  // Hydration catch-up: a click can land before React attaches onToggle, opening the
  // native <details> without the fetch firing. If it's already open at mount, load.
  useEffect(() => {
    if (detailsRef.current?.open) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <details
      ref={detailsRef}
      className="mt-1"
      data-testid={`sync-rows-${eventId}`}
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open) void load();
      }}
    >
      <summary className="cursor-pointer text-xs font-medium text-brand-600 hover:underline dark:text-brand-400">
        What this wrote ({count})
      </summary>
      {state === "loading" && (
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Loading…
        </p>
      )}
      {state === "error" && (
        <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">
          Couldn’t load the written records.
        </p>
      )}
      {state === "loaded" && rows.length === 0 && (
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Record-level detail wasn’t captured for this sync.
        </p>
      )}
      {state === "loaded" && rows.length > 0 && (
        <ul
          className="mt-1 space-y-1"
          data-testid={`sync-rows-list-${eventId}`}
        >
          {rows.map((r) => (
            <li key={r.id} className="text-xs">
              {r.deleted ? (
                <span className="text-slate-500 line-through dark:text-slate-400">
                  {r.label}
                  {r.date ? ` · ${r.date}` : ""} (removed)
                </span>
              ) : (
                <Link
                  href={r.href}
                  className="inline-flex items-center gap-1 text-slate-600 hover:text-brand-600 hover:underline dark:text-slate-300 dark:hover:text-brand-400"
                >
                  <span
                    className={`inline-block rounded px-1 py-0.5 text-xs font-medium ${
                      r.disposition === "inserted"
                        ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                        : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                    }`}
                  >
                    {r.disposition === "inserted" ? "new" : "changed"}
                  </span>
                  <span>
                    {r.label}
                    {r.date ? ` · ${r.date}` : ""}
                  </span>
                  <IconArrowRight className="h-3 w-3 shrink-0" />
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
