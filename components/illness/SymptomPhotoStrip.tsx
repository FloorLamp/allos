"use client";

import { useMemo, useState, useTransition } from "react";
import MediaInput from "@/components/media/MediaInput";
import { useToast } from "@/components/Toast";
import PhotoGallery from "@/components/photo/PhotoGallery";
import PhotoTimeline from "@/components/photo/PhotoTimeline";
import PhotoDeleteAction from "@/components/photo/PhotoLightboxActions";
import { LightboxAction } from "@/components/photo/PhotoLightboxActions";
import SegmentedControl from "@/components/SegmentedControl";
import { filterBySeries, type GalleryPhoto } from "@/lib/photo/gallery-model";
import {
  uploadSymptomPhotoAction,
  deleteSymptomPhotoAction,
  updateSymptomPhotoCaptionAction,
} from "@/app/(app)/medical/episodes/actions";

export interface SymptomPhotoView {
  id: number;
  date: string;
  symptom: string | null;
  // The display label of the symptom this photo documents (#1093), or null for a
  // whole-day photo. Shown as the photo's meta line so two same-day symptoms read
  // apart, and used as the gallery's series filter.
  symptomLabel: string | null;
  caption: string | null;
}

export interface PhotoSymptomOption {
  key: string;
  label: string;
}

// The dated symptom-photo strip on the episode page (issue #859 item 4), rebuilt on the
// shared photo core in #1844 (phase 3). The door is <MediaInput>, the one add-media
// surface (#3286): camera-first on a phone, file-first on a desktop, and a drop or a
// paste either way — this strip used to own a bare `capture="environment"` file input,
// which is exactly the mobile-shaped-only door that issue was filed about. Browse
// (PhotoGallery) and Compare (PhotoTimeline) are the two sibling views over one series
// (#221) — and here the series is the SYMPTOM, so "is the rash spreading?" is two dates
// side by side instead of two thumbnails the eye has to hold. Each photo streams from
// the session-scoped serve route (/api/symptom-photo/[id], `?thumb=1` for the grid);
// nothing here is on the share/print surface (the PHI default-exclude). Upload, caption
// edit, and delete answer from typed outcomes.
export default function SymptomPhotoStrip({
  photos,
  uploadDate,
  symptomOptions = [],
  canWrite,
  profileId,
}: {
  photos: SymptomPhotoView[];
  uploadDate: string;
  // The symptoms logged on the upload date (#1093) — a new photo can be TAGGED to one so
  // it binds to that specific symptom log. Empty ⇒ only the "Whole day" option shows.
  symptomOptions?: PhotoSymptomOption[];
  canWrite: boolean;
  // The cross-profile write target (issue #879) — set on a household member's episode
  // page so each photo write gates on THAT profile (requireProfileWriteAccess). Absent
  // on the acting profile's own page.
  profileId?: number;
}) {
  const [pending, start] = useTransition();
  const toast = useToast();
  const [caption, setCaption] = useState("");
  const [photoSymptom, setPhotoSymptom] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [captionDraft, setCaptionDraft] = useState("");
  const [view, setView] = useState<"grid" | "compare">("grid");
  const [seriesFilter, setSeriesFilter] = useState<string | null>(null);

  const gallery: GalleryPhoto[] = useMemo(
    () =>
      photos.map((p) => ({
        id: p.id,
        date: p.date,
        // The symptom is the series: a whole-day photo belongs to none.
        seriesKey: p.symptom,
        url: `/api/symptom-photo/${p.id}`,
        thumbUrl: `/api/symptom-photo/${p.id}?thumb=1`,
        caption: p.caption,
        meta: p.symptomLabel,
      })),
    [photos]
  );
  // The series chips come from the photos THEMSELVES, not from the upload picker:
  // `symptomOptions` lists what is logged on the upload date (and is empty for a
  // read-only viewer), while the strip shows the whole episode window. A chip for a
  // symptom with no photos would filter to nothing.
  const series = useMemo(() => {
    const seen = new Map<string, string>();
    for (const p of photos) {
      if (p.symptom && !seen.has(p.symptom))
        seen.set(p.symptom, p.symptomLabel ?? p.symptom);
    }
    return [...seen].map(([key, label]) => ({ key, label }));
  }, [photos]);
  const compareSeries = useMemo(
    () => filterBySeries(gallery, seriesFilter),
    [gallery, seriesFilter]
  );

  // One upload per file so a refusal names the file it refused, and ONE toast for
  // the set. The whole batch shares the caption and symptom tag on screen: they
  // describe the moment, and several shots of one rash are one moment.
  async function onPick(files: File[]): Promise<string | null> {
    const failed: string[] = [];
    for (const file of files) {
      const fd = new FormData();
      fd.set("photo", file);
      fd.set("date", uploadDate);
      if (caption.trim()) fd.set("caption", caption.trim());
      if (photoSymptom) fd.set("symptom", photoSymptom);
      if (profileId != null) fd.set("profileId", String(profileId));
      const res = await uploadSymptomPhotoAction(fd);
      if (!res.ok) failed.push(`${file.name}: ${res.error}`);
    }
    if (failed.length === files.length) return failed.join("; ");
    const added = files.length - failed.length;
    setCaption("");
    setPhotoSymptom("");
    toast(
      failed.length > 0
        ? `Attached ${added} of ${files.length}. ${failed.join("; ")}`
        : added > 1
          ? `${added} photos attached.`
          : "Photo attached."
    );
    return null;
  }

  function saveCaption(photoId: number, close: () => void) {
    start(async () => {
      const fd = new FormData();
      fd.set("photoId", String(photoId));
      fd.set("caption", captionDraft);
      if (profileId != null) fd.set("profileId", String(profileId));
      const res = await updateSymptomPhotoCaptionAction(fd);
      if (!res.ok) {
        toast(res.error, { tone: "error" });
        return;
      }
      setEditingId(null);
      // The caption is what the lightbox is showing, so leave it: the refreshed
      // props are the honest copy.
      close();
      toast(captionDraft.trim() ? "Caption updated." : "Caption removed.");
    });
  }

  return (
    <div data-testid="symptom-photo-strip">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          Progress photos
        </h3>
        {gallery.length > 1 ? (
          <SegmentedControl
            options={[
              {
                value: "grid",
                label: "Browse",
                testId: "symptom-photo-view-grid",
              },
              {
                value: "compare",
                label: "Compare",
                testId: "symptom-photo-view-compare",
              },
            ]}
            value={view}
            onChange={setView}
            ariaLabel="Photo view"
          />
        ) : null}
      </div>

      {gallery.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          No photos yet. Add one to track visible changes such as a rash or
          swelling.
        </p>
      ) : view === "grid" ? (
        <PhotoGallery
          domains={[
            {
              key: "symptom",
              label: "Symptom",
              photos: gallery,
              series,
            },
          ]}
          seriesFilter={seriesFilter}
          onSeriesFilterChange={setSeriesFilter}
          renderActions={(photo, { close }) =>
            !canWrite ? null : editingId === photo.id ? (
              <form
                className="flex items-center gap-1.5"
                onSubmit={(event) => {
                  event.preventDefault();
                  saveCaption(photo.id, close);
                }}
              >
                <label
                  className="sr-only"
                  htmlFor={`photo-caption-${photo.id}`}
                >
                  Photo caption
                </label>
                <input
                  id={`photo-caption-${photo.id}`}
                  data-testid={`symptom-photo-caption-input-${photo.id}`}
                  className="input w-48 px-2 text-xs text-slate-900 dark:text-slate-100"
                  value={captionDraft}
                  onChange={(event) => setCaptionDraft(event.target.value)}
                  maxLength={500}
                  autoFocus
                />
                <LightboxAction onClick={() => setEditingId(null)}>
                  Cancel
                </LightboxAction>
                <LightboxAction
                  type="submit"
                  disabled={pending}
                  data-testid={`symptom-photo-caption-save-${photo.id}`}
                >
                  {pending ? "Saving…" : "Save"}
                </LightboxAction>
              </form>
            ) : (
              <>
                <LightboxAction
                  data-testid={`symptom-photo-edit-${photo.id}`}
                  disabled={pending}
                  onClick={() => {
                    setEditingId(photo.id);
                    setCaptionDraft(photo.caption ?? "");
                  }}
                >
                  Edit caption
                </LightboxAction>
                <PhotoDeleteAction
                  testId={`symptom-photo-delete-${photo.id}`}
                  close={close}
                  remove={() => {
                    const formData = new FormData();
                    formData.set("photoId", String(photo.id));
                    if (profileId != null)
                      formData.set("profileId", String(profileId));
                    return deleteSymptomPhotoAction(formData);
                  }}
                />
              </>
            )
          }
        />
      ) : (
        <PhotoTimeline
          photos={compareSeries}
          emptyHint="Add at least two photos to compare how this looked over time."
        />
      )}

      {canWrite && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          {symptomOptions.length > 0 && (
            <div>
              <label className="label mb-0" htmlFor="episode-photo-symptom">
                Symptom (optional)
              </label>
              <select
                id="episode-photo-symptom"
                data-testid="symptom-photo-symptom-select"
                value={photoSymptom}
                onChange={(e) => setPhotoSymptom(e.target.value)}
                className="input mt-1 w-40 text-sm"
              >
                <option value="">Whole day</option>
                {symptomOptions.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="label mb-0" htmlFor="episode-photo-caption">
              Caption (optional)
            </label>
            <input
              id="episode-photo-caption"
              type="text"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="What changed?"
              className="input mt-1 w-48 text-sm"
            />
          </div>
          <MediaInput
            triggerLabel={pending ? "Adding…" : "Add photo"}
            triggerTestId="symptom-photo-add"
            inputTestId="symptom-photo-input"
            inputId="episode-symptom-photo-input"
            className="btn-ghost btn-sm"
            multiple
            disabled={pending}
            onConfirm={onPick}
          />
          <p className="w-full text-xs text-slate-400">
            Photos are resized and cleaned of camera metadata (location, device)
            when stored, and never appear in a share link or printout.
          </p>
        </div>
      )}
    </div>
  );
}
