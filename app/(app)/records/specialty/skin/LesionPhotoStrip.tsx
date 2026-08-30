"use client";

import { useMemo, useState } from "react";
import DateField from "@/components/DateField";
import MediaInput from "@/components/media/MediaInput";
import { useToast } from "@/components/Toast";
import PhotoGallery from "@/components/photo/PhotoGallery";
import PhotoTimeline from "@/components/photo/PhotoTimeline";
import PhotoDeleteAction from "@/components/photo/PhotoLightboxActions";
import SegmentedControl from "@/components/SegmentedControl";
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
  const [date, setDate] = useState("");
  const [caption, setCaption] = useState("");
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

  // One upload per file so a refusal names the file it refused, and ONE toast for
  // the set — a stack of shots of one mole is a single act, not five.
  async function handleUpload(files: File[]): Promise<string | null> {
    const failed: string[] = [];
    for (const file of files) {
      const fd = new FormData();
      fd.set("lesion_id", String(lesionId));
      fd.set("photo", file);
      fd.set("date", date);
      fd.set("caption", caption);
      const res = await uploadLesionPhoto(fd);
      if (!res.ok) failed.push(`${file.name}: ${res.error}`);
    }
    if (failed.length === files.length) return failed.join("; ");
    const added = files.length - failed.length;
    toast(
      failed.length > 0
        ? `Added ${added} of ${files.length}. ${failed.join("; ")}`
        : added > 1
          ? `${added} photos added`
          : "Photo added"
    );
    setDate("");
    setCaption("");
    return null;
  }

  return (
    <div className="space-y-2" data-testid={`lesion-photos-${lesionId}`}>
      {gallery.length > 1 ? (
        <div className="flex justify-end">
          <SegmentedControl
            options={[
              {
                value: "grid",
                label: "Browse",
                testId: `lesion-photo-view-grid-${lesionId}`,
              },
              {
                value: "compare",
                label: "Compare",
                testId: `lesion-photo-view-compare-${lesionId}`,
              },
            ]}
            value={view}
            onChange={setView}
            ariaLabel="Photo view"
          />
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
          renderActions={(photo, { close }) => (
            <PhotoDeleteAction
              close={close}
              testId={`lesion-photo-delete-${photo.id}`}
              remove={() => {
                const formData = new FormData();
                formData.set("photo_id", String(photo.id));
                return deleteLesionPhoto(formData);
              }}
            />
          )}
        />
      ) : (
        <PhotoTimeline
          photos={gallery}
          emptyHint="Add at least two photos to compare this lesion over time."
        />
      )}

      <MediaInput
        triggerLabel="Add photo"
        triggerTestId={`add-lesion-photo-${lesionId}`}
        inputTestId={`lesion-photo-file-${lesionId}`}
        className="text-xs text-link"
        multiple
        onConfirm={handleUpload}
        confirmFields={
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label className="label text-xs" htmlFor={`lp-date-${lesionId}`}>
                Date{" "}
                <span className="normal-case">(blank = photo’s own date)</span>
              </label>
              <DateField
                id={`lp-date-${lesionId}`}
                value={date}
                onChange={setDate}
              />
            </div>
            <div className="min-w-40 flex-1">
              <label
                className="label text-xs"
                htmlFor={`lp-caption-${lesionId}`}
              >
                Caption
              </label>
              <input
                id={`lp-caption-${lesionId}`}
                className="input py-1 text-sm"
                placeholder="optional"
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
              />
            </div>
          </div>
        }
      />
    </div>
  );
}
