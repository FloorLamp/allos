"use client";

import { useState } from "react";
import { IconDownload } from "@tabler/icons-react";

// The "Export all my data" download plus its media opt-in (#1846).
//
// Photos and clips (progress / lesion / symptom photos, symptom / activity clips)
// are the strictest privacy tier: excluded from share links, the emergency card,
// and — by default — this ZIP. That default is right, but it used to be the ONLY
// setting, so a year of serial mole photos had no way out of the app except one
// authenticated file fetch at a time. This checkbox is the whole opt-in: it flips
// the download to `?media=1`, which is read PER REQUEST and stored nowhere, so
// including media is always a fresh, deliberate choice rather than a preference
// that quietly persists into the next export.
//
// A client component only because the href depends on the checkbox; the download
// itself is still a plain GET whose route re-checks the session and scopes strictly
// to the active profile. `children` carries the sibling download links (the FHIR
// passport), which stay server-rendered — they take no media and need no state.
export default function ExportAllDownload({
  children,
}: {
  children?: React.ReactNode;
}) {
  const [includeMedia, setIncludeMedia] = useState(false);
  return (
    <div className="mt-4 space-y-3">
      <label className="flex items-start gap-2 text-sm text-slate-600 dark:text-slate-300">
        <input
          type="checkbox"
          data-testid="export-media-toggle"
          className="mt-0.5 h-4 w-4 accent-brand-600"
          checked={includeMedia}
          onChange={(e) => setIncludeMedia(e.target.checked)}
        />
        <span>
          <span className="font-medium text-slate-700 dark:text-slate-200">
            Include photo &amp; video files
          </span>
          <span className="mt-0.5 block text-slate-500 dark:text-slate-400">
            Progress, lesion and symptom photos plus symptom and form-check
            clips, with an index of their dates and captions. Off by default —
            these are the most sensitive files in your record, and turning it on
            makes the download much larger.
          </span>
        </span>
      </label>
      <div className="flex flex-wrap gap-3">
        <a
          href={includeMedia ? "/api/export/full?media=1" : "/api/export/full"}
          download
          data-testid="export-all-link"
          className="btn"
        >
          <IconDownload className="h-4 w-4" />
          Export all my data (.zip)
        </a>
        {children}
      </div>
    </div>
  );
}
