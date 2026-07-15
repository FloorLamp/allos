"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { savePublicUrl } from "./server/actions";
import SaveStatus from "@/components/SaveStatus";
import { useSaveStatus } from "@/components/useSaveStatus";

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
  const { pending, savedAt, error, save: runSave } = useSaveStatus();
  // A server-side validation message (a rejected URL). Distinct from the hook's
  // boolean `error` (a thrown/transient save failure) — this carries the reason.
  const [validationError, setValidationError] = useState<string | null>(null);

  function save() {
    const fd = new FormData();
    fd.set("public_url", url);
    runSave(async () => {
      const res = await savePublicUrl(fd);
      if (!res.ok) {
        setValidationError(res.error);
        // Throw so the hook records a failure (error icon, no "saved" chip)
        // rather than treating the rejected value as a successful save.
        throw new Error(res.error);
      }
      // Reflect the normalization (added scheme, stripped trailing slash).
      setUrl(res.url);
      setValidationError(null);
      router.refresh();
    });
  }

  return (
    <div className="card mt-6 max-w-lg space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Public app URL
        </h2>
        <SaveStatus pending={pending} savedAt={savedAt} error={error} />
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-400">
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

      {validationError && (
        <p className="text-sm text-rose-600 dark:text-rose-400">
          {validationError}
        </p>
      )}
    </div>
  );
}
