"use client";

import { useEffect, useState } from "react";
import { IconCode } from "@tabler/icons-react";
import ModalShell from "@/components/ModalShell";
import RawDataViewer from "@/components/RawDataViewer";

// Admin-only raw payload, as ONE LINK PER RUN opening a dialog (#1991 pin 12).
//
// The inline `<details>` version (RawPayloadViewer) put Expand all / Collapse all /
// Copy / Download JSON plus a scrolling object tree INSIDE a history row: an admin
// debugging tool in the primary reading position, taking most of the viewport and
// pushing the actual history below the fold. Same capability, same admin gate, same
// lazy fetch — it just stops being the centrepiece of the page.
//
// The inline viewer stays where it IS the content: Review's inbox card and the
// Imports feed each show one event, with nothing beneath it to bury.
export default function RawPayloadDialog({ id }: { id: number }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<"idle" | "loading" | "loaded" | "error">(
    "idle"
  );
  const [text, setText] = useState("");

  useEffect(() => {
    if (!open || state !== "idle") return;
    let alive = true;
    setState("loading");
    void (async () => {
      try {
        const res = await fetch(`/api/integrations/raw/${id}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.text();
        if (!alive) return;
        setText(body);
        setState("loaded");
      } catch (err) {
        if (!alive) return;
        setText(err instanceof Error ? err.message : String(err));
        setState("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, state, id]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid={`raw-payload-open-${id}`}
        aria-label="View the raw provider payload for this run"
        title="View raw payload"
        className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-brand-600 hover:underline dark:text-slate-400 dark:hover:text-brand-400"
      >
        <IconCode className="h-3.5 w-3.5" stroke={1.75} />
        Raw
      </button>
      {open && (
        <ModalShell title="Raw payload" onClose={() => setOpen(false)}>
          <div className="mt-3">
            {state === "loading" && (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                Loading…
              </p>
            )}
            {state === "error" && (
              <p className="text-sm text-rose-600 dark:text-rose-400">
                Couldn’t load raw payload ({text}).
              </p>
            )}
            {state === "loaded" && (
              <RawDataViewer text={text} downloadName={`sync-payload-${id}`} />
            )}
          </div>
        </ModalShell>
      )}
    </>
  );
}
