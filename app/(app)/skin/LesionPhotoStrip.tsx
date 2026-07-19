"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import NotesText from "@/components/NotesText";
import { formatRecordDate } from "@/lib/record-format";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import type { DisplayFormatPrefs } from "@/lib/format-date";
import { uploadLesionPhoto, deleteLesionPhoto } from "./actions";
import type { LesionPhotoRow } from "@/lib/skin-photo-write";

// Serial photo strip for ONE lesion (issue #715 ask 2) — the "is this mole changing?"
// payoff. Renders the lesion's dated photos ADJACENTLY (oldest → newest, left to right)
// so two dates sit side by side for direct comparison, with an inline upload. Kept
// deliberately simple: dated thumbnails in a horizontal scroller, no viewer/zoom. New
// photos attach to `lesionId` (the lesion's latest record). SCOPE: the photos are for
// the user's own comparison + their dermatologist — nothing here assesses the lesion.
export default function LesionPhotoStrip({
  lesionId,
  photos,
}: {
  lesionId: number;
  photos: LesionPhotoRow[];
}) {
  const fmt = useFormatPrefs();
  const router = useRouter();
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // Oldest → newest so the comparison reads chronologically.
  const ordered = [...photos].sort((a, b) =>
    a.date === b.date ? a.id - b.id : a.date < b.date ? -1 : 1
  );

  async function handleUpload(formData: FormData) {
    setError(null);
    const res = await uploadLesionPhoto(formData);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    toast("Photo added");
    formRef.current?.reset();
    setOpen(false);
    router.refresh();
  }

  return (
    <div className="space-y-2" data-testid={`lesion-photos-${lesionId}`}>
      {ordered.length > 0 ? (
        <div className="flex gap-3 overflow-x-auto pb-1">
          {ordered.map((p) => (
            <figure
              key={p.id}
              className="min-w-32 shrink-0"
              data-testid={`lesion-photo-${p.id}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/lesion-photo/${p.id}`}
                alt={`Lesion photo from ${formatRecordDate(p.date, "—", fmt)}`}
                className="h-32 w-32 rounded-lg border border-black/10 object-cover dark:border-white/10"
              />
              <figcaption className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                <span className="font-medium">
                  {formatRecordDate(p.date, "—", fmt)}
                </span>
                <NotesText
                  as="span"
                  notes={p.caption}
                  className="ml-1 text-slate-400"
                />
                <form
                  action={async (fd) => {
                    await deleteLesionPhoto(fd);
                    router.refresh();
                  }}
                  className="inline"
                >
                  <input type="hidden" name="photo_id" value={p.id} />
                  <button
                    type="submit"
                    className="ml-1 text-slate-400 underline hover:text-rose-600 dark:hover:text-rose-400"
                    aria-label="Delete photo"
                  >
                    remove
                  </button>
                </form>
              </figcaption>
            </figure>
          ))}
        </div>
      ) : (
        <p className="text-xs text-slate-400">
          No photos yet. Add dated photos to compare this lesion over time.
        </p>
      )}

      {open ? (
        <form
          ref={formRef}
          action={handleUpload}
          className="flex flex-wrap items-end gap-2 rounded-lg border border-black/10 p-2 dark:border-white/10"
          data-testid={`lesion-photo-upload-${lesionId}`}
        >
          <input type="hidden" name="lesion_id" value={lesionId} />
          <div>
            <label className="label text-xs" htmlFor={`lp-date-${lesionId}`}>
              Date
            </label>
            <DateField id={`lp-date-${lesionId}`} name="date" />
          </div>
          <div className="min-w-40 flex-1">
            <label className="label text-xs" htmlFor={`lp-caption-${lesionId}`}>
              Caption
            </label>
            <input
              id={`lp-caption-${lesionId}`}
              name="caption"
              className="input py-1 text-sm"
              placeholder="optional"
            />
          </div>
          <div>
            <label className="label text-xs" htmlFor={`lp-file-${lesionId}`}>
              Photo
            </label>
            <input
              id={`lp-file-${lesionId}`}
              name="photo"
              type="file"
              accept="image/*"
              required
              className="text-sm"
            />
          </div>
          <SubmitButton className="btn py-1 text-sm" pendingLabel="Adding…">
            Add photo
          </SubmitButton>
          {error && (
            <p
              role="alert"
              className="w-full text-sm text-rose-600 dark:text-rose-400"
            >
              {error}
            </p>
          )}
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-xs font-medium text-brand-600 hover:underline dark:text-brand-300"
          data-testid={`add-lesion-photo-${lesionId}`}
        >
          + Add photo
        </button>
      )}
    </div>
  );
}
