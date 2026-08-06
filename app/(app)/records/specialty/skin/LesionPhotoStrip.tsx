"use client";

import { useMemo, useRef, useState } from "react";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import PhotoGallery from "@/components/photo/PhotoGallery";
import PhotoTimeline from "@/components/photo/PhotoTimeline";
import type { GalleryPhoto } from "@/lib/photo/gallery-model";
import { uploadLesionPhoto, deleteLesionPhoto } from "./actions";
import type { LesionPhotoRow } from "@/lib/skin-photo-write";

// Serial photo strip for ONE lesion (issue #715 ask 2) — the "is this mole changing?"
// payoff, rebuilt on the shared photo core in #1844 (phase 3). The lesion IS the series,
// so the two sibling views over it (#221) are exactly the two questions a user has:
// Browse (PhotoGallery — dated thumbnails, lightbox, delete) and Compare (PhotoTimeline
// — two dates side by side or onion-skinned, which is what "changing?" actually needs
// and the hand-rolled scroller could never do). The grid reads the ingest thumbnail;
// the lightbox loads the full image.
//
// SCOPE: the photos are for the user's own comparison + their dermatologist — nothing
// here assesses the lesion, and no caption is ever generated.
export default function LesionPhotoStrip({
  lesionId,
  photos,
}: {
  lesionId: number;
  photos: LesionPhotoRow[];
}) {
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"grid" | "compare">("grid");

  const gallery: GalleryPhoto[] = useMemo(
    () =>
      photos.map((p) => ({
        id: p.id,
        date: p.date,
        // One lesion is one series: there is nothing to sub-filter within it.
        seriesKey: null,
        url: `/api/lesion-photo/${p.id}`,
        thumbUrl: `/api/lesion-photo/${p.id}?thumb=1`,
        caption: p.caption,
        meta: null,
      })),
    [photos]
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
  }

  return (
    <div className="space-y-2" data-testid={`lesion-photos-${lesionId}`}>
      {gallery.length > 1 ? (
        <div
          className="flex justify-end gap-1"
          role="tablist"
          aria-label="Photo view"
        >
          {(["grid", "compare"] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium ${
                view === v
                  ? "bg-brand-600 text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-ink-800 dark:text-slate-300 dark:hover:bg-ink-750"
              }`}
              onClick={() => setView(v)}
              data-testid={`lesion-photo-view-${v}-${lesionId}`}
            >
              {v === "grid" ? "Browse" : "Compare"}
            </button>
          ))}
        </div>
      ) : null}

      {gallery.length === 0 ? (
        <p className="text-xs text-slate-400">
          No photos yet. Add dated photos to compare this lesion over time.
        </p>
      ) : view === "grid" ? (
        <PhotoGallery
          domains={[
            { key: "skin", label: "Skin", photos: gallery, series: [] },
          ]}
          renderActions={(photo) => (
            <form
              action={async (fd) => {
                await deleteLesionPhoto(fd);
              }}
            >
              <input type="hidden" name="photo_id" value={photo.id} />
              <button
                type="submit"
                className="rounded-lg bg-rose-600/80 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-600"
                data-testid={`lesion-photo-delete-${photo.id}`}
              >
                Delete photo
              </button>
            </form>
          )}
        />
      ) : (
        <PhotoTimeline
          photos={gallery}
          emptyHint="Add at least two photos to compare this lesion over time."
        />
      )}

      {open ? (
        <form
          ref={formRef}
          action={handleUpload}
          className="flex flex-wrap items-end gap-2 border-t border-black/5 pt-3 dark:border-white/5"
          data-testid={`lesion-photo-upload-${lesionId}`}
        >
          <input type="hidden" name="lesion_id" value={lesionId} />
          <div>
            <label className="label text-xs" htmlFor={`lp-date-${lesionId}`}>
              Date{" "}
              <span className="normal-case">(blank = photo’s own date)</span>
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
          <p className="w-full text-xs text-slate-400">
            Photos are resized and cleaned of camera metadata (location, device)
            when stored.
          </p>
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
