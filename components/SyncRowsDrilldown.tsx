"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { IconArrowRight } from "@tabler/icons-react";
import { loadSyncRows } from "@/app/(app)/data/review-actions";
import { drilldownRemainderLabel } from "@/lib/integrations/sync-history-days";
import type { SyncRowLink } from "@/lib/queries";

// "What this sync wrote" drill-in (issue #1333, deferred part 2 of #1212). Behind a
// <details> so nothing is queried until the user expands it; on first open it calls
// the profile-scoped loadSyncRows action and lists the records the sync inserted/
// updated, each a typed deep link (#285) to the surface that owns it (a timeline day,
// or Results for a lab). Mirrors RawPayloadViewer's lazy on-open fetch + hydration
// catch-up. Rendered ONLY for an event that actually RECORDED provenance (#1771):
// the caller resolves that with one indexed existence check (eventsWithProvenance)
// and omits the expander entirely otherwise, so there is no apologetic empty state
// left to reach. That covers both a legitimately provenance-less provider — Weather
// writes cells of a GLOBAL location-keyed forecast cache, which name no user record
// (#1212's scoping decision) — and genuine pre-#1333 legacy events. A chunked import
// that failed after earlier chunks committed still drills in: those chunks recorded
// their rows.
export default function SyncRowsDrilldown({
  eventId,
  count,
  remainder = 0,
}: {
  eventId: number;
  // Records this drill-in will actually LIST — never the run's split total (#1991).
  count: number;
  // Records the run also wrote that carry no openable identity (minute-grain rows
  // with no row id, and the other targets recordSyncRows deliberately skips). Named
  // rather than hidden: the count used to include them, so a partial list looked
  // complete and overstated by 10× on a Health Connect push.
  remainder?: number;
}) {
  const [state, setState] = useState<"idle" | "loading" | "loaded" | "error">(
    "idle"
  );
  const [rows, setRows] = useState<SyncRowLink[]>([]);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const remainderLabel = drilldownRemainderLabel(remainder);
  // Once the list is loaded, the label states what is actually THERE. The passed
  // count is the promise the caller resolved before opening; the loaded rows are the
  // truth, and the two must never disagree in front of the reader (#1991).
  const shown = state === "loaded" ? rows.length : count;

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
        What this wrote — {shown} {shown === 1 ? "record" : "records"}
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
      {remainderLabel && (
        <p
          className="mt-1 text-xs text-slate-500 dark:text-slate-400"
          data-testid={`sync-rows-remainder-${eventId}`}
        >
          {remainderLabel}
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
