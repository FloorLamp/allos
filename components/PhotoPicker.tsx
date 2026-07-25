"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import ImageCropper from "./ImageCropper";
import type { PhotoResult } from "@/app/(app)/settings/photo-actions";

// The pick → crop → upload (and remove) controls shared by both avatar surfaces:
// Settings → Profile and the Family admin rows. It owns the whole client-side
// lifecycle — file input, opening the cropper, uploading the cropped result,
// resetting the input, and its own pending/error state — so the two call sites
// only supply the profile-specific actions and a refresh callback. The two
// surfaces differ only in density, selected via `variant`.

// ONE file-input affordance, in two sizes (issue #1450 cluster C). Both variants
// style the `file:` button as a real button; they differ only in scale. The
// compact variant previously filled it grey (`file:bg-slate-200`), which on the
// Family admin rows read as the raw native "Choose File | No file chosen" control
// sitting beside Settings → Profile's proper button — two treatments for the same
// action. Sharing the brand fill makes "pick a photo" look like the same thing
// wherever it appears, and any future upload surface inherits it.
//
// min-w-0 max-w-full (#1063) applies to BOTH: a native file input has a wide
// intrinsic size ("Choose File · <name>") that otherwise forces its card past a
// phone viewport; capping it lets the control truncate instead. The compact
// variant was missing min-w-0.
const FILE_INPUT_BASE =
  "block min-w-0 max-w-full text-slate-600 file:cursor-pointer file:rounded-md file:border-0 file:bg-brand-600 file:font-medium file:text-white hover:file:bg-brand-700 dark:text-slate-300";
const INPUT_CLASS: Record<Variant, string> = {
  default: `${FILE_INPUT_BASE} text-sm file:mr-3 file:px-3 file:py-1.5 file:text-sm`,
  compact: `${FILE_INPUT_BASE} text-xs file:mr-2 file:px-2 file:py-1 file:text-xs`,
};
const REMOVE_CLASS: Record<Variant, string> = {
  default: "btn-ghost shrink-0",
  compact:
    "text-xs font-medium text-rose-600 hover:underline dark:text-rose-400",
};

type Variant = "default" | "compact";

export default function PhotoPicker({
  hasPhoto,
  onUpload,
  onRemove,
  onDone,
  variant = "default",
  disabled = false,
  onBusyChange,
}: {
  hasPhoto: boolean;
  // Run the upload/remove server action for the target profile; the parent owns
  // which profile that is (active profile vs. an admin-selected one).
  onUpload: (file: File) => Promise<PhotoResult>;
  onRemove: () => Promise<PhotoResult>;
  // Called after a successful upload/remove so the parent can revalidate/refresh.
  onDone: () => void;
  variant?: Variant;
  // Lets a parent disable the controls while it's busy with unrelated work.
  disabled?: boolean;
  // Reports whether an upload/remove is in flight, so a parent can block its own
  // conflicting actions (e.g. deleting the profile) for the duration.
  onBusyChange?: (busy: boolean) => void;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [cropFile, setCropFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const busy = pending || disabled;
  // While the cropper is open, treat the picker as occupied so Remove can't race
  // a crop that's about to upload.
  const locked = busy || cropFile != null;

  useEffect(() => {
    onBusyChange?.(pending);
  }, [pending, onBusyChange]);

  function resetInput() {
    if (fileRef.current) fileRef.current.value = "";
  }

  function upload(file: File) {
    setError(null);
    start(async () => {
      const r = await onUpload(file);
      if (r.ok) onDone();
      else setError(r.error);
    });
  }

  function remove() {
    setError(null);
    start(async () => {
      const r = await onRemove();
      if (r.ok) onDone();
      else setError(r.error);
    });
  }

  return (
    <div className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          disabled={locked}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) {
              setError(null);
              setCropFile(f);
            }
          }}
          className={INPUT_CLASS[variant]}
        />
        {hasPhoto && (
          <button
            type="button"
            onClick={remove}
            disabled={locked}
            className={REMOVE_CLASS[variant]}
          >
            Remove photo
          </button>
        )}
      </div>
      {error && (
        <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>
      )}
      {cropFile && (
        <ImageCropper
          file={cropFile}
          onCancel={() => {
            setCropFile(null);
            resetInput();
          }}
          onCropped={(cropped) => {
            setCropFile(null);
            resetInput();
            upload(cropped);
          }}
        />
      )}
    </div>
  );
}
