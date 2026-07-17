"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { IconCamera, IconTrash } from "@tabler/icons-react";
import { useToast } from "@/components/Toast";
import {
  uploadSymptomPhotoAction,
  deleteSymptomPhotoAction,
} from "@/app/(app)/medical/episodes/actions";

export interface SymptomPhotoView {
  id: number;
  date: string;
  symptom: string | null;
  caption: string | null;
}

// The dated symptom-photo strip on the episode page (issue #859 item 4). Camera-first
// on mobile (the file input carries `accept="image/*" capture="environment"`, so a
// phone opens the rear camera). Each photo streams from the session-scoped serve route
// (/api/symptom-photo/[id]); nothing here is on the share/print surface (the PHI
// default-exclude). Upload + delete answer from the action's typed outcome.
export default function SymptomPhotoStrip({
  photos,
  uploadDate,
  canWrite,
  profileId,
}: {
  photos: SymptomPhotoView[];
  uploadDate: string;
  canWrite: boolean;
  // The cross-profile write target (issue #879) — set on a household member's episode
  // page so the upload/delete gate on THAT profile (requireProfileWriteAccess). Absent on
  // the acting profile's own page.
  profileId?: number;
}) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [caption, setCaption] = useState("");

  function onPick(file: File | undefined) {
    if (!file) return;
    start(async () => {
      const fd = new FormData();
      fd.set("photo", file);
      fd.set("date", uploadDate);
      if (caption.trim()) fd.set("caption", caption.trim());
      if (profileId != null) fd.set("profileId", String(profileId));
      const res = await uploadSymptomPhotoAction(fd);
      if (fileRef.current) fileRef.current.value = "";
      if (!res.ok) {
        toast(res.error, { tone: "error" });
        return;
      }
      setCaption("");
      toast("Photo attached.");
      router.refresh();
    });
  }

  return (
    <div className="mt-5" data-testid="symptom-photo-strip">
      <div className="mb-2 section-label">Photos</div>
      {photos.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          No photos yet. Add one to track how a rash or swelling changes over
          the days.
        </p>
      ) : (
        <div className="flex flex-wrap gap-3">
          {photos.map((p) => (
            <figure
              key={p.id}
              data-testid={`symptom-photo-${p.id}`}
              className="w-28 shrink-0"
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
                  className="h-28 w-28 rounded-lg border border-black/10 object-cover dark:border-white/10"
                />
              </a>
              <figcaption className="mt-1 flex items-center justify-between gap-1 text-xs text-slate-500 dark:text-slate-400">
                <span className="truncate">{p.date}</span>
                {canWrite && (
                  <button
                    type="button"
                    aria-label="Delete photo"
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
                    className="text-slate-400 hover:text-rose-500 disabled:opacity-50"
                  >
                    <IconTrash className="h-3.5 w-3.5" stroke={1.75} />
                  </button>
                )}
                {p.caption && <span className="sr-only">{p.caption}</span>}
              </figcaption>
            </figure>
          ))}
        </div>
      )}

      {canWrite && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            data-testid="symptom-photo-input"
            className="hidden"
            onChange={(e) => onPick(e.target.files?.[0])}
          />
          <input
            type="text"
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder="Optional caption"
            className="input h-9 w-48 text-sm"
          />
          <button
            type="button"
            data-testid="symptom-photo-add"
            disabled={pending}
            onClick={() => fileRef.current?.click()}
            className="badge cursor-pointer border border-black/10 bg-transparent text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-white/15 dark:text-slate-300 dark:hover:bg-ink-850"
          >
            <IconCamera className="mr-1 inline h-3.5 w-3.5" stroke={1.75} />
            {pending ? "Adding…" : "Add photo"}
          </button>
        </div>
      )}
    </div>
  );
}
