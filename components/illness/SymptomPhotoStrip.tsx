"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { IconCamera, IconPencil, IconTrash } from "@tabler/icons-react";
import { useToast } from "@/components/Toast";
import NotesText from "@/components/NotesText";
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
  // whole-day photo. Shown as a chip so two same-day symptoms' photos read apart.
  symptomLabel: string | null;
  caption: string | null;
}

export interface PhotoSymptomOption {
  key: string;
  label: string;
}

// The dated symptom-photo strip on the episode page (issue #859 item 4). Camera-first
// on mobile (the file input carries `accept="image/*" capture="environment"`, so a
// phone opens the rear camera). Each photo streams from the session-scoped serve route
// (/api/symptom-photo/[id]); nothing here is on the share/print surface (the PHI
// default-exclude). Upload, caption edit, and delete answer from typed outcomes.
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
  const router = useRouter();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [caption, setCaption] = useState("");
  const [photoSymptom, setPhotoSymptom] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [captionDraft, setCaptionDraft] = useState("");

  function onPick(file: File | undefined) {
    if (!file) return;
    start(async () => {
      const fd = new FormData();
      fd.set("photo", file);
      fd.set("date", uploadDate);
      if (caption.trim()) fd.set("caption", caption.trim());
      if (photoSymptom) fd.set("symptom", photoSymptom);
      if (profileId != null) fd.set("profileId", String(profileId));
      const res = await uploadSymptomPhotoAction(fd);
      if (fileRef.current) fileRef.current.value = "";
      if (!res.ok) {
        toast(res.error, { tone: "error" });
        return;
      }
      setCaption("");
      setPhotoSymptom("");
      toast("Photo attached.");
      router.refresh();
    });
  }

  function saveCaption(photoId: number) {
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
      toast(captionDraft.trim() ? "Caption updated." : "Caption removed.");
      router.refresh();
    });
  }

  return (
    <div data-testid="symptom-photo-strip">
      <h3 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
        Progress photos
      </h3>
      {photos.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          No photos yet. Add one to track visible changes such as a rash or
          swelling.
        </p>
      ) : (
        <div className="flex flex-wrap gap-3">
          {photos.map((p) => (
            <figure
              key={p.id}
              data-testid={`symptom-photo-${p.id}`}
              className="w-36 shrink-0"
            >
              <a
                href={`/api/symptom-photo/${p.id}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/symptom-photo/${p.id}`}
                  alt={p.caption ?? `Symptom photo ${p.date}`}
                  className="h-28 w-full rounded-lg border border-black/10 object-cover dark:border-white/10"
                />
              </a>
              <figcaption className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
                {p.symptomLabel && (
                  <span
                    data-testid={`symptom-photo-symptom-${p.id}`}
                    className="mb-1 inline-block rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600 dark:bg-ink-800 dark:text-slate-300"
                  >
                    {p.symptomLabel}
                  </span>
                )}
                <div className="flex items-center justify-between gap-1">
                  <span className="truncate">{p.date}</span>
                  {canWrite && (
                    <span className="flex shrink-0 items-center gap-0.5">
                      <button
                        type="button"
                        aria-label="Edit photo caption"
                        title="Edit caption"
                        data-testid={`symptom-photo-edit-${p.id}`}
                        disabled={pending}
                        onClick={() => {
                          setEditingId(p.id);
                          setCaptionDraft(p.caption ?? "");
                        }}
                        className="tap-target rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 disabled:opacity-50 dark:hover:bg-ink-800 dark:hover:text-slate-200"
                      >
                        <IconPencil className="h-3.5 w-3.5" stroke={1.75} />
                      </button>
                      <button
                        type="button"
                        aria-label="Delete photo"
                        title="Delete photo"
                        data-testid={`symptom-photo-delete-${p.id}`}
                        disabled={pending}
                        onClick={() =>
                          start(async () => {
                            const fd = new FormData();
                            fd.set("photoId", String(p.id));
                            if (profileId != null)
                              fd.set("profileId", String(profileId));
                            const res = await deleteSymptomPhotoAction(fd);
                            if (!res.ok) {
                              toast(res.error, { tone: "error" });
                              return;
                            }
                            router.refresh();
                          })
                        }
                        className="tap-target rounded p-1 text-slate-400 transition hover:bg-rose-50 hover:text-rose-500 disabled:opacity-50 dark:hover:bg-rose-950/30"
                      >
                        <IconTrash className="h-3.5 w-3.5" stroke={1.75} />
                      </button>
                    </span>
                  )}
                </div>
                {editingId === p.id ? (
                  <form
                    className="mt-1.5 space-y-1.5"
                    onSubmit={(e) => {
                      e.preventDefault();
                      saveCaption(p.id);
                    }}
                  >
                    <label
                      className="sr-only"
                      htmlFor={`photo-caption-${p.id}`}
                    >
                      Photo caption
                    </label>
                    <input
                      id={`photo-caption-${p.id}`}
                      data-testid={`symptom-photo-caption-input-${p.id}`}
                      className="input h-8 w-full px-2 text-xs"
                      value={captionDraft}
                      onChange={(e) => setCaptionDraft(e.target.value)}
                      maxLength={500}
                      autoFocus
                    />
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        className="btn-ghost px-2 py-1 text-xs"
                        onClick={() => setEditingId(null)}
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        className="btn px-2 py-1 text-xs"
                        disabled={pending}
                      >
                        {pending ? "Saving…" : "Save"}
                      </button>
                    </div>
                  </form>
                ) : (
                  <NotesText
                    as="p"
                    notes={p.caption}
                    className="mt-1 text-slate-600 dark:text-slate-300"
                  />
                )}
              </figcaption>
            </figure>
          ))}
        </div>
      )}

      {canWrite && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <input
            ref={fileRef}
            id="episode-symptom-photo-input"
            type="file"
            accept="image/*"
            capture="environment"
            data-testid="symptom-photo-input"
            className="hidden"
            onChange={(e) => onPick(e.target.files?.[0])}
          />
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
                className="input mt-1 h-9 w-40 text-sm"
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
              className="input mt-1 h-9 w-48 text-sm"
            />
          </div>
          <button
            type="button"
            data-testid="symptom-photo-add"
            disabled={pending}
            onClick={() => fileRef.current?.click()}
            className="btn-ghost btn-sm"
          >
            <IconCamera className="mr-1 inline h-3.5 w-3.5" stroke={1.75} />
            {pending ? "Adding…" : "Add photo"}
          </button>
        </div>
      )}
    </div>
  );
}
