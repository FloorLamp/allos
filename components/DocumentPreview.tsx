"use client";

import { useEffect, useRef, useState } from "react";
import { IconExternalLink, IconFileOff } from "@tabler/icons-react";

// The inline preview of an uploaded document on the import-detail page. A large PDF
// iframe or image that, when it fails to load or the content is unrenderable, swaps
// to a compact "Preview unavailable — Open original ↗" state instead of leaving a
// dead blank frame (#1340). onError fires reliably for images (a broken/absent
// stored file) and on a network error for the iframe; a rendered-but-blank PDF
// isn't catchable, so the Open-original link in the card header stays the backstop.
export default function DocumentPreview({
  src,
  isPdf,
  filename,
}: {
  src: string;
  isPdf: boolean;
  filename: string;
}) {
  const [failed, setFailed] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  // The image can error BEFORE React hydrates and attaches onError — the SSR'd
  // <img> starts loading immediately, and a fast 404 fires its error event while
  // the handler isn't wired yet. On mount, catch that already-failed state
  // (`complete` but zero natural size) so the fallback still shows.
  useEffect(() => {
    const el = imgRef.current;
    if (el && el.complete && el.naturalWidth === 0) setFailed(true);
  }, []);

  if (failed) {
    return (
      <div
        data-testid="preview-unavailable"
        className="flex flex-wrap items-center gap-2 rounded-lg border border-black/10 bg-slate-50 px-3 py-4 text-sm text-slate-500 dark:border-white/10 dark:bg-ink-900 dark:text-slate-400"
      >
        <IconFileOff className="h-4 w-4 shrink-0" />
        <span>Preview unavailable.</span>
        <a
          href={src}
          target="_blank"
          rel="noopener"
          className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline dark:text-brand-400"
        >
          Open original <IconExternalLink className="h-4 w-4" />
        </a>
      </div>
    );
  }

  if (isPdf) {
    return (
      <iframe
        src={src}
        title={filename}
        onError={() => setFailed(true)}
        className="h-[80vh] w-full rounded-lg border border-black/10 dark:border-white/10"
      />
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={imgRef}
      src={src}
      alt={filename}
      onError={() => setFailed(true)}
      className="mx-auto max-h-[80vh] rounded-lg border border-black/10 dark:border-white/10"
    />
  );
}
