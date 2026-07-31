"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { IconUpload } from "@tabler/icons-react";

// The archive picker + streamed upload. A client component because the file never
// goes through a Server Action: a Takeout export is hundreds of megabytes, far past
// the Server Action body limit, so the raw File is streamed to a route handler which
// writes it straight to disk.
//
// Deliberately NOT a <form action={...}>: a multipart form would buffer the whole
// archive in memory on both sides. `body: file` streams it.

interface ImportResult {
  entriesRead: number;
  entriesSkipped: number;
  counts: { inserted: number; updated: number; unchanged: number };
  parsed: {
    bodyMetrics: number;
    samples: number;
    activities: number;
    vitals: number;
  };
  roundTripSkipped: number;
  warnings: string[];
}

export default function TakeoutUpload() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/integrations/fitbit-takeout/import", {
        method: "POST",
        body: file,
        headers: { "content-type": "application/zip" },
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        setError(
          res.status === 413
            ? "That archive is larger than this instance accepts."
            : (body?.error ?? "Import failed.")
        );
        return;
      }
      setResult(body as ImportResult);
      // The import wrote body metrics, sleep and activities — refresh so the
      // "last import" line and any open Trends data reflect it.
      router.refresh();
    } catch {
      setError("Upload failed. Check the file and try again.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div data-testid="takeout-upload" className="space-y-3">
      <input
        ref={inputRef}
        type="file"
        accept=".zip,application/zip"
        data-testid="takeout-file"
        disabled={busy}
        className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-brand-600 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-brand-700 disabled:opacity-60 dark:text-slate-300"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
        }}
      />

      {busy && (
        <p
          data-testid="takeout-busy"
          className="text-sm text-slate-500 dark:text-slate-400"
        >
          <IconUpload className="mr-1 inline h-4 w-4" />
          Uploading and importing — a large archive can take a minute.
        </p>
      )}

      {error && (
        <p
          data-testid="takeout-error"
          className="text-sm text-rose-600 dark:text-rose-400"
        >
          {error}
        </p>
      )}

      {result && (
        <div
          data-testid="takeout-result"
          className="rounded-lg border border-black/10 bg-slate-50 p-3 text-sm dark:border-white/10 dark:bg-ink-900"
        >
          <p className="font-medium text-slate-800 dark:text-slate-100">
            Imported {result.counts.inserted} new records
            {result.counts.updated > 0 && `, updated ${result.counts.updated}`}
            {result.counts.unchanged > 0 &&
              `, ${result.counts.unchanged} already up to date`}
            .
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Read {result.entriesRead} of{" "}
            {result.entriesRead + result.entriesSkipped} files in the archive —
            the rest is sensor data with no home here.
          </p>
          {result.roundTripSkipped > 0 && (
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {result.roundTripSkipped} rows already synced through Health
              Connect were left to that connection.
            </p>
          )}
          {result.warnings.map((w) => (
            <p
              key={w}
              className="mt-1 text-xs text-amber-700 dark:text-amber-400"
            >
              {w}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
