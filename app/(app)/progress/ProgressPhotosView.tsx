"use client";

import { useMemo, useState } from "react";
import PhotoCapture from "@/components/photo/PhotoCapture";
import PhotoGallery from "@/components/photo/PhotoGallery";
import PhotoTimeline from "@/components/photo/PhotoTimeline";
import DateField from "@/components/DateField";
import ModalShell from "@/components/ModalShell";
import { useConfirm } from "@/components/ConfirmDialog";
import {
  filterBySeries,
  timelineOrder,
  type GalleryPhoto,
} from "@/lib/photo/gallery-model";
import {
  PROGRESS_POSES,
  POSE_LABELS,
  type ProgressPose,
} from "@/lib/progress-photos";
import {
  uploadProgressPhoto,
  deleteProgressPhoto,
  updateProgressPhoto,
} from "./actions";

// Client shell of /progress (#1119 phase 2): one pose state shared by the
// capture ghost, the gallery's series filter, and the compare timeline — so
// "every front lines up with the last front" without three pose pickers
// drifting apart. Browse (grid) and Compare (timeline) are the two sibling
// views over the same series (#221).

type ProgressGalleryPhoto = GalleryPhoto & { pose: string };

export default function ProgressPhotosView({
  photos,
  readOnly,
  autoCapture = false,
}: {
  photos: ProgressGalleryPhoto[];
  readOnly: boolean;
  autoCapture?: boolean;
}) {
  const confirm = useConfirm();
  const [pose, setPose] = useState<ProgressPose>("front");
  const [seriesFilter, setSeriesFilter] = useState<string | null>(null);
  const [view, setView] = useState<"grid" | "compare">("grid");
  const [notice, setNotice] = useState<string | null>(null);
  const [date, setDate] = useState("");
  const [caption, setCaption] = useState("");
  // Metadata correction (#1934). The image BYTES are immutable content; date, pose and
  // caption are the three things a human gets wrong, so they are editable in place —
  // delete-and-re-upload would throw away the original file, its content hash, and its
  // place in the series.
  const [editing, setEditing] = useState<ProgressGalleryPhoto | null>(null);
  const [editPose, setEditPose] = useState<ProgressPose>("front");
  const [editDate, setEditDate] = useState("");
  const [editCaption, setEditCaption] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  function openEdit(photo: ProgressGalleryPhoto) {
    setEditing(photo);
    setEditPose((photo.pose as ProgressPose) ?? "front");
    setEditDate(photo.date);
    setEditCaption(photo.caption ?? "");
    setEditError(null);
  }

  function closeEdit() {
    setEditing(null);
    setEditError(null);
  }

  // The onion-skin ghost: the LATEST photo of the pose being captured.
  const ghostUrl = useMemo(() => {
    const series = timelineOrder(filterBySeries(photos, pose));
    return series.length ? series[series.length - 1].url : null;
  }, [photos, pose]);

  // Compare reads the pose the user is looking at (series filter, else the
  // capture pose).
  const comparePose = (seriesFilter as ProgressPose | null) ?? pose;
  const compareSeries = useMemo(
    () => filterBySeries(photos, comparePose),
    [photos, comparePose]
  );

  const confirmFields = (
    <div className="flex flex-wrap items-end gap-2">
      <div>
        <label className="label" htmlFor="progress-pose">
          Pose
        </label>
        <select
          id="progress-pose"
          className="input py-1.5 text-sm"
          value={pose}
          onChange={(e) => setPose(e.target.value as ProgressPose)}
          data-testid="progress-pose-select"
        >
          {PROGRESS_POSES.map((p) => (
            <option key={p} value={p}>
              {POSE_LABELS[p]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="progress-date">
          Date <span className="normal-case">(blank = photo’s own date)</span>
        </label>
        <DateField
          id="progress-date"
          value={date}
          onChange={setDate}
          data-testid="progress-date-field"
        />
      </div>
      <div className="min-w-40 flex-1">
        <label className="label" htmlFor="progress-caption">
          Caption
        </label>
        <input
          id="progress-caption"
          className="input py-1.5 text-sm"
          placeholder="optional"
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          data-testid="progress-caption-input"
        />
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {!readOnly ? (
          <PhotoCapture
            triggerLabel="Add photo"
            autoOpen={autoCapture}
            ghostUrl={ghostUrl}
            confirmFields={confirmFields}
            onConfirm={async (file) => {
              const fd = new FormData();
              fd.set("photo", file);
              fd.set("pose", pose);
              fd.set("date", date);
              fd.set("caption", caption);
              const res = await uploadProgressPhoto(fd);
              if (!res.ok) return res.error;
              setNotice(null);
              setDate("");
              setCaption("");
              return null;
            }}
          />
        ) : null}
        <div className="ml-auto flex gap-1" role="tablist" aria-label="View">
          {(["grid", "compare"] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                view === v
                  ? "bg-brand-600 text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-ink-800 dark:text-slate-300 dark:hover:bg-ink-750"
              }`}
              onClick={() => setView(v)}
              data-testid={`progress-view-${v}`}
            >
              {v === "grid" ? "Browse" : "Compare"}
            </button>
          ))}
        </div>
      </div>

      {notice ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">{notice}</p>
      ) : null}

      {view === "grid" ? (
        <PhotoGallery
          domains={[
            {
              key: "progress",
              label: "Progress",
              photos,
              series: PROGRESS_POSES.map((p) => ({
                key: p,
                label: POSE_LABELS[p],
              })),
            },
          ]}
          seriesFilter={seriesFilter}
          onSeriesFilterChange={(key) => {
            setSeriesFilter(key);
            if (key) setPose(key as ProgressPose);
          }}
          renderActions={(photo, { close }) => (
            <div className="flex items-center gap-2">
              {/* Compare is a READ affordance — available to every grant. */}
              <button
                type="button"
                className="rounded-lg bg-white/10 px-3 py-1.5 text-sm font-medium text-white hover:bg-white/20"
                onClick={() => setView("compare")}
                data-testid="photo-lightbox-compare"
              >
                Compare series
              </button>
              {!readOnly ? (
                <button
                  type="button"
                  className="rounded-lg bg-white/10 px-3 py-1.5 text-sm font-medium text-white hover:bg-white/20"
                  data-testid="photo-lightbox-edit"
                  onClick={() => {
                    // Leave the lightbox first: a pose or date change re-sorts the
                    // filtered set, so the open index would no longer mean this photo.
                    close();
                    openEdit(
                      photos.find((p) => p.id === photo.id) ??
                        (photo as ProgressGalleryPhoto)
                    );
                  }}
                >
                  Edit details
                </button>
              ) : null}
              {!readOnly ? (
                <button
                  type="button"
                  className="rounded-lg bg-rose-600/80 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-600"
                  data-testid="photo-lightbox-delete"
                  onClick={async () => {
                    const ok = await confirm({
                      title: "Delete this photo?",
                      message:
                        "This progress photo will be permanently removed.",
                      confirmLabel: "Delete photo",
                      danger: true,
                    });
                    if (!ok) return;
                    const fd = new FormData();
                    fd.set("photo_id", String(photo.id));
                    const res = await deleteProgressPhoto(fd);
                    setNotice(res.ok ? "Photo deleted." : res.error);
                  }}
                >
                  Delete
                </button>
              ) : null}
            </div>
          )}
        />
      ) : (
        <section className="space-y-2">
          <div className="flex flex-wrap gap-1">
            {PROGRESS_POSES.map((p) => (
              <button
                key={p}
                type="button"
                className={`rounded-full px-3 py-1 text-xs font-medium ${
                  comparePose === p
                    ? "bg-brand-100 text-brand-800 dark:bg-brand-900/50 dark:text-brand-200"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-ink-800 dark:text-slate-300 dark:hover:bg-ink-750"
                }`}
                onClick={() => {
                  setSeriesFilter(p);
                  setPose(p);
                }}
                data-testid={`progress-compare-pose-${p}`}
              >
                {POSE_LABELS[p]}
              </button>
            ))}
          </div>
          <PhotoTimeline
            photos={compareSeries}
            emptyHint={`Add at least two ${POSE_LABELS[comparePose]} photos to compare over time.`}
          />
        </section>
      )}

      {editing ? (
        <ModalShell
          title="Edit photo details"
          onClose={closeEdit}
          className="w-full max-w-md rounded-xl bg-white p-4 shadow-xl outline-none sm:p-5 dark:bg-ink-900"
        >
          <div data-testid="progress-edit-modal" className="mt-4 space-y-3">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              The image itself never changes — only how it&rsquo;s filed.
            </p>
            <div>
              <label className="label" htmlFor="progress-edit-pose">
                Pose
              </label>
              <select
                id="progress-edit-pose"
                className="input py-1.5 text-sm"
                value={editPose}
                onChange={(e) => setEditPose(e.target.value as ProgressPose)}
                data-testid="progress-edit-pose"
              >
                {PROGRESS_POSES.map((p) => (
                  <option key={p} value={p}>
                    {POSE_LABELS[p]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="progress-edit-date">
                Date
              </label>
              <DateField
                id="progress-edit-date"
                value={editDate}
                onChange={setEditDate}
                data-testid="progress-edit-date"
              />
            </div>
            <div>
              <label className="label" htmlFor="progress-edit-caption">
                Caption
              </label>
              <input
                id="progress-edit-caption"
                className="input py-1.5 text-sm"
                placeholder="optional"
                value={editCaption}
                onChange={(e) => setEditCaption(e.target.value)}
                data-testid="progress-edit-caption"
              />
            </div>
            {editError ? (
              <p
                data-testid="progress-edit-error"
                className="text-sm text-rose-600 dark:text-rose-400"
              >
                {editError}
              </p>
            ) : null}
          </div>
          <div className="mt-4 flex justify-end gap-2 border-t border-black/10 pt-3 dark:border-white/10">
            <button
              type="button"
              className="btn-ghost"
              onClick={closeEdit}
              data-testid="progress-edit-cancel"
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn"
              disabled={savingEdit}
              data-testid="progress-edit-save"
              onClick={async () => {
                setSavingEdit(true);
                const fd = new FormData();
                fd.set("photo_id", String(editing.id));
                fd.set("pose", editPose);
                fd.set("date", editDate);
                fd.set("caption", editCaption);
                const res = await updateProgressPhoto(fd);
                setSavingEdit(false);
                if (!res.ok) {
                  setEditError(res.error);
                  return;
                }
                // Follow the correction: the series the user is looking at is the
                // one this photo now belongs to.
                setSeriesFilter(editPose);
                setPose(editPose);
                setNotice("Photo details updated.");
                closeEdit();
              }}
            >
              {savingEdit ? "Saving…" : "Save details"}
            </button>
          </div>
        </ModalShell>
      ) : null}
    </div>
  );
}
