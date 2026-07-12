"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { savePublicUrl } from "./server/actions";
import SaveStatus from "@/components/SaveStatus";

// The externally reachable base URL of the app — one shared setting consumed by
// everything that hands a URL to a third party (Telegram webhook, Strava OAuth
// callback, Health Connect ingest endpoint). Empty is fine for private setups.
export default function PublicUrlSettings({
  publicUrl,
}: {
  publicUrl: string;
}) {
  const router = useRouter();
  const [url, setUrl] = useState(publicUrl);
  const [pending, startTransition] = useTransition();
  const [savedAt, setSavedAt] = useState(0);
  const [error, setError] = useState<string | null>(null);

  function save() {
    const fd = new FormData();
    fd.set("public_url", url);
    startTransition(async () => {
      const res = await savePublicUrl(fd);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // Reflect the normalization (added scheme, stripped trailing slash).
      setUrl(res.url);
      setError(null);
      setSavedAt(Date.now());
      router.refresh();
    });
  }

  return (
    <div className="card mt-6 max-w-lg space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Public app URL
        </h2>
        <SaveStatus pending={pending} savedAt={savedAt} />
      </div>

      <p className="text-xs text-slate-400 dark:text-slate-500">
        Where this app is reachable from the internet (e.g. via a reverse proxy
        or tunnel). Used by integrations that call back in — the Telegram
        webhook, the Strava OAuth callback, and the Health Connect ingest
        endpoint. Leave empty if the app isn&apos;t public; Telegram button taps
        then work via polling instead.
      </p>

      <div className="flex items-end gap-2">
        <div className="flex-1">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://your-app.example.com"
            className="input"
          />
        </div>
        <button type="button" onClick={save} disabled={pending} className="btn">
          Save
        </button>
      </div>

      {error && (
        <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>
      )}
    </div>
  );
}
