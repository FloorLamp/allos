"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import PhotoCapture from "@/components/photo/PhotoCapture";
import PhotoGallery from "@/components/photo/PhotoGallery";
import PhotoTimeline from "@/components/photo/PhotoTimeline";
import DateField from "@/components/DateField";
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
import { uploadProgressPhoto, deleteProgressPhoto } from "./actions";

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
  const router = useRouter();
  const [pose, setPose] = useState<ProgressPose>("front");
  const [seriesFilter, setSeriesFilter] = useState<string | null>(null);
  const [view, setView] = useState<"grid" | "compare">("grid");
  const [notice, setNotice] = useState<string | null>(null);
  const [date, setDate] = useState("");
  const [caption, setCaption] = useState("");

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
              router.refresh();
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
          renderActions={(photo) => (
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
                  className="rounded-lg bg-rose-600/80 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-600"
                  data-testid="photo-lightbox-delete"
                  onClick={async () => {
                    if (!window.confirm("Delete this photo?")) return;
                    const fd = new FormData();
                    fd.set("photo_id", String(photo.id));
                    const res = await deleteProgressPhoto(fd);
                    setNotice(res.ok ? "Photo deleted." : res.error);
                    router.refresh();
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
    </div>
  );
}
