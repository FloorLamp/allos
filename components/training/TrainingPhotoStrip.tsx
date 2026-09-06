"use client";

import { useMemo, useState, useTransition } from "react";
import MediaInput from "@/components/media/MediaInput";
import { useToast } from "@/components/Toast";
import PhotoGallery from "@/components/photo/PhotoGallery";
import PhotoDeleteAction, {
  LightboxAction,
} from "@/components/photo/PhotoLightboxActions";
import type { GalleryPhoto } from "@/lib/photo/gallery-model";
import {
  uploadTrainingPhotoAction,
  updateTrainingPhotoCaptionAction,
  deleteTrainingPhotoAction,
} from "@/app/(app)/training/photo-actions";

// One training photo as a surface lists it (#3285 item 3).
export interface TrainingPhotoView {
  id: number;
  date: string;
  caption: string | null;
  // The session's title, or the event's name — what the photo is OF. On an event
  // page this is also the gallery's series chip, so "just the podium shots" and
  // "just the race run's" are one tap apart.
  ownerLabel: string;
}

// The photo strip for a logged SESSION and for an EVENT (#3285 item 3). One
// component for both because it is one domain: the owner it uploads against is the
// only difference, and the event page hands it the union of its own photos and its
// linked sessions'.
//
// Browse only, deliberately. #221's other view (PhotoTimeline's onion-skin compare)
// answers "is this changing over time?" — the right question for a mole or a
// physique, and not one anyone asks of a race. The issue says so in its own words:
// "EXIF-strip, compression, onion-skin not needed here".
//
// The door is <MediaInput>, the one add-media surface (#3286): camera-first on a
// phone, file-first on a desktop, drop or paste either way. Each photo streams from
// /api/training-photo/[id] (`?thumb=1` for the grid), which resolves the photo's owner
// and gates the session on it — this strip mounts cross-profile, so acting-profile
// scoping there would 404 every tile on a household member's page (#1696). Nothing
// here is on a share, printable or export surface.
export default function TrainingPhotoStrip({
  owner,
  photos,
  canWrite,
  subjectProfileId,
}: {
  // Where a NEW photo lands. The gallery may show more than this owner's photos (an
  // event shows its linked sessions' too); uploads always land on the page's subject.
  owner:
    | { kind: "activity"; activityId: number }
    | { kind: "event"; planId: number };
  photos: TrainingPhotoView[];
  canWrite: boolean;
  // The cross-profile write target (#1328): set on a household member's page so each
  // write gates THAT profile. Absent on the acting profile's own page.
  subjectProfileId?: number;
}) {
  const [pending, start] = useTransition();
  const toast = useToast();
  const [caption, setCaption] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [captionDraft, setCaptionDraft] = useState("");
  const [seriesFilter, setSeriesFilter] = useState<string | null>(null);

  const gallery: GalleryPhoto[] = useMemo(
    () =>
      photos.map((p) => ({
        id: p.id,
        date: p.date,
        seriesKey: p.ownerLabel,
        url: `/api/training-photo/${p.id}`,
        thumbUrl: `/api/training-photo/${p.id}?thumb=1`,
        caption: p.caption,
        meta: p.ownerLabel,
      })),
    [photos]
  );

  // Chips come from the photos themselves, and only once there is more than one
  // owner to tell apart — an activity page's photos all share one owner, so a single
  // chip that filters to everything would be dead UI.
  const series = useMemo(() => {
    const seen = new Set(photos.map((p) => p.ownerLabel));
    return seen.size > 1 ? [...seen].map((key) => ({ key, label: key })) : [];
  }, [photos]);

  function ownerFields(fd: FormData) {
    if (owner.kind === "activity")
      fd.set("activity_id", String(owner.activityId));
    else fd.set("plan_id", String(owner.planId));
    if (subjectProfileId != null)
      fd.set("profile_id", String(subjectProfileId));
  }

  // One upload per file so a refusal names the file it refused, and ONE toast for the
  // set. The batch shares the caption on screen: several shots of one finish line are
  // one moment.
  //
  // A DUPLICATE is a success that added nothing: the identical capture is already
  // among this profile's training photos, so the core reuses that row and no tile
  // appears here. The toast says so rather than claiming an add, because "Photo
  // added." over an unchanged strip is the app telling the person something untrue.
  async function onPick(files: File[]): Promise<string | null> {
    const failed: string[] = [];
    let added = 0;
    let duplicates = 0;
    for (const file of files) {
      const fd = new FormData();
      fd.set("photo", file);
      if (caption.trim()) fd.set("caption", caption.trim());
      ownerFields(fd);
      const res = await uploadTrainingPhotoAction(fd);
      if (!res.ok) failed.push(`${file.name}: ${res.error}`);
      else if (res.duplicate) duplicates++;
      else added++;
    }
    if (failed.length === files.length) return failed.join("; ");
    setCaption("");
    const said: string[] = [];
    if (added > 0)
      said.push(added > 1 ? `${added} photos added.` : "Photo added.");
    if (duplicates > 0)
      said.push(
        duplicates > 1
          ? `${duplicates} were already attached elsewhere.`
          : "That photo is already attached elsewhere."
      );
    if (failed.length > 0) said.push(failed.join("; "));
    toast(said.join(" "));
    return null;
  }

  function saveCaption(photoId: number, close: () => void) {
    start(async () => {
      const fd = new FormData();
      fd.set("photo_id", String(photoId));
      fd.set("caption", captionDraft);
      ownerFields(fd);
      const res = await updateTrainingPhotoCaptionAction(fd);
      if (!res.ok) {
        toast(res.error, { tone: "error" });
        return;
      }
      setEditingId(null);
      close();
      toast(captionDraft.trim() ? "Caption updated." : "Caption removed.");
    });
  }

  // A read-only viewer with nothing to look at gets nothing, not an empty block.
  if (photos.length === 0 && !canWrite) return null;

  return (
    <section className="card" data-testid="training-photos">
      <h2 className="font-semibold text-slate-800 dark:text-slate-100">
        Photos
      </h2>
      {gallery.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
          {owner.kind === "event"
            ? "No photos yet. Add the bib, the start line, the podium."
            : "No photos yet."}
        </p>
      ) : (
        <div className="mt-3">
          <PhotoGallery
            domains={[
              {
                key: "training",
                label: "Training",
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
                    htmlFor={`training-photo-caption-${photo.id}`}
                  >
                    Photo caption
                  </label>
                  <input
                    id={`training-photo-caption-${photo.id}`}
                    data-testid={`training-photo-caption-input-${photo.id}`}
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
                    data-testid={`training-photo-caption-save-${photo.id}`}
                  >
                    {pending ? "Saving…" : "Save"}
                  </LightboxAction>
                </form>
              ) : (
                <>
                  <LightboxAction
                    data-testid={`training-photo-edit-${photo.id}`}
                    disabled={pending}
                    onClick={() => {
                      setEditingId(photo.id);
                      setCaptionDraft(photo.caption ?? "");
                    }}
                  >
                    Edit caption
                  </LightboxAction>
                  <PhotoDeleteAction
                    testId={`training-photo-delete-${photo.id}`}
                    close={close}
                    remove={() => {
                      const fd = new FormData();
                      fd.set("photo_id", String(photo.id));
                      ownerFields(fd);
                      return deleteTrainingPhotoAction(fd);
                    }}
                  />
                </>
              )
            }
          />
        </div>
      )}

      {canWrite && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div>
            <label className="label mb-0" htmlFor="training-photo-caption">
              Caption (optional)
            </label>
            <input
              id="training-photo-caption"
              type="text"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="What is this?"
              className="input mt-1 w-48 text-sm"
            />
          </div>
          <MediaInput
            triggerLabel={pending ? "Adding…" : "Add photo"}
            triggerTestId="training-photo-add"
            inputTestId="training-photo-input"
            inputId="training-photo-file-input"
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
    </section>
  );
}
