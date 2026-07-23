"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  IconVideo,
  IconMicrophone,
  IconTrash,
  IconMapPin,
} from "@tabler/icons-react";
import { useToast } from "@/components/Toast";
import NotesText from "@/components/NotesText";
import { extractPosterFrame } from "@/lib/video/client-poster";

// The shared capture → poster-grid → open-to-play surface of the video core
// (#1224 phase 1) — every video-carrying domain (symptom/episode clips now,
// training form checks now; in-app recording in phase 2) renders THIS instead of
// a bespoke strip, so the privacy note, the poster-first grid (the clip loads only
// on open), and the audio/location affordances can never diverge per domain (the
// #221 one-surface / #1119 one-core philosophy).
//
// Upload-only MVP (#1224): a native file input (accept video+audio, `capture` so a
// phone opens the camera). On pick, a poster frame is extracted CLIENT-side
// (canvas) and submitted alongside; the SERVER re-strips the poster's metadata and
// stores the clip AS-IS. A clip whose bytes carry embedded LOCATION metadata shows
// the visible privacy note (clips recorded in-app in phase 2 won't).

export interface VideoClipView {
  id: number;
  // Primary label (a date for symptom clips, an exercise/title for activity clips).
  label: string;
  caption: string | null;
  kind: string; // "video" | "audio"
  hasLocation: boolean;
  durationSec: number | null;
}

type ActionResult = { ok: true } | { ok: false; error: string };

function formatDuration(sec: number | null): string | null {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return null;
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

export default function VideoClipGrid({
  clips,
  serveBase,
  canWrite,
  testid = "video-clip-grid",
  emptyText = "No clips yet.",
  addLabel = "Add clip",
  onUpload,
  onDelete,
  onEditCaption,
}: {
  clips: VideoClipView[];
  // Serve-route base, e.g. "/api/symptom-video" — the clip streams from
  // `${serveBase}/${id}` (Range), the poster from `${serveBase}/${id}?poster=1`.
  serveBase: string;
  canWrite: boolean;
  testid?: string;
  emptyText?: string;
  addLabel?: string;
  onUpload: (
    file: File,
    poster: Blob | null,
    caption: string
  ) => Promise<ActionResult>;
  onDelete: (id: number) => Promise<ActionResult>;
  onEditCaption: (id: number, caption: string) => Promise<ActionResult>;
}) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [caption, setCaption] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [captionDraft, setCaptionDraft] = useState("");

  function onPick(file: File | undefined) {
    if (!file) return;
    start(async () => {
      // Best-effort client poster; the upload proceeds posterless on failure.
      let poster: Blob | null = null;
      try {
        poster = await extractPosterFrame(file);
      } catch {
        poster = null;
      }
      const res = await onUpload(file, poster, caption.trim());
      if (fileRef.current) fileRef.current.value = "";
      if (!res.ok) {
        toast(res.error, { tone: "error" });
        return;
      }
      setCaption("");
      toast("Clip attached.");
      router.refresh();
    });
  }

  function saveCaption(id: number) {
    start(async () => {
      const res = await onEditCaption(id, captionDraft);
      if (!res.ok) {
        toast(res.error, { tone: "error" });
        return;
      }
      setEditingId(null);
      toast(captionDraft.trim() ? "Caption updated." : "Caption removed.");
      router.refresh();
    });
  }

  function remove(id: number) {
    start(async () => {
      const res = await onDelete(id);
      if (!res.ok) {
        toast(res.error, { tone: "error" });
        return;
      }
      if (openId === id) setOpenId(null);
      router.refresh();
    });
  }

  return (
    <div data-testid={testid}>
      {clips.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {emptyText}
        </p>
      ) : (
        <div className="flex flex-wrap gap-3">
          {clips.map((c) => {
            const isAudio = c.kind === "audio";
            const isOpen = openId === c.id;
            const dur = formatDuration(c.durationSec);
            return (
              <figure
                key={c.id}
                data-testid={`video-clip-item-${c.id}`}
                className="w-44 shrink-0"
              >
                {isOpen ? (
                  isAudio ? (
                    <audio
                      controls
                      autoPlay
                      src={`${serveBase}/${c.id}`}
                      data-testid={`video-clip-player-${c.id}`}
                      className="w-full"
                    />
                  ) : (
                    // The <video> (and its bytes) load ONLY here, on open.
                    <video
                      controls
                      autoPlay
                      playsInline
                      poster={`${serveBase}/${c.id}?poster=1`}
                      src={`${serveBase}/${c.id}`}
                      data-testid={`video-clip-player-${c.id}`}
                      className="h-32 w-full rounded-lg border border-black/10 bg-black object-contain dark:border-white/10"
                    />
                  )
                ) : (
                  <button
                    type="button"
                    onClick={() => setOpenId(c.id)}
                    data-testid={`video-clip-open-${c.id}`}
                    aria-label={`Play clip ${c.label}`}
                    className="relative block h-32 w-full overflow-hidden rounded-lg border border-black/10 bg-slate-100 dark:border-white/10 dark:bg-ink-800"
                  >
                    {isAudio ? (
                      <span className="flex h-full w-full items-center justify-center text-slate-500 dark:text-slate-400">
                        <IconMicrophone size={28} stroke={1.5} aria-hidden />
                      </span>
                    ) : (
                      <>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={`${serveBase}/${c.id}?poster=1`}
                          alt={c.caption ?? `Clip ${c.label}`}
                          className="h-full w-full object-cover"
                          onError={(e) => {
                            // No poster (audio, or an undecodable frame) — hide the
                            // broken image so the play glyph shows through.
                            e.currentTarget.style.visibility = "hidden";
                          }}
                        />
                        <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
                          <span className="rounded-full bg-black/50 p-2 text-white">
                            <IconVideo size={20} stroke={1.75} aria-hidden />
                          </span>
                        </span>
                      </>
                    )}
                    {dur && (
                      <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1 text-xs font-medium tabular-nums text-white">
                        {dur}
                      </span>
                    )}
                  </button>
                )}

                <figcaption className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
                  <div className="flex items-center justify-between gap-1">
                    <span className="truncate">{c.label}</span>
                    {canWrite && (
                      <span className="flex shrink-0 items-center gap-0.5">
                        <button
                          type="button"
                          aria-label="Edit clip caption"
                          title="Edit caption"
                          data-testid={`video-clip-edit-${c.id}`}
                          disabled={pending}
                          onClick={() => {
                            setEditingId(c.id);
                            setCaptionDraft(c.caption ?? "");
                          }}
                          className="tap-target rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 disabled:opacity-50 dark:hover:bg-ink-800 dark:hover:text-slate-200"
                        >
                          <span aria-hidden>✎</span>
                        </button>
                        <button
                          type="button"
                          aria-label="Delete clip"
                          title="Delete clip"
                          data-testid={`video-clip-delete-${c.id}`}
                          disabled={pending}
                          onClick={() => remove(c.id)}
                          className="tap-target rounded p-1 text-slate-400 transition hover:bg-rose-50 hover:text-rose-500 disabled:opacity-50 dark:hover:bg-rose-950/30"
                        >
                          <IconTrash className="h-3.5 w-3.5" stroke={1.75} />
                        </button>
                      </span>
                    )}
                  </div>

                  {c.hasLocation && (
                    <p
                      data-testid={`video-clip-location-${c.id}`}
                      className="mt-1 flex items-start gap-1 text-xs leading-tight text-amber-600 dark:text-amber-400"
                    >
                      <IconMapPin
                        className="mt-px h-3 w-3 shrink-0"
                        stroke={1.75}
                        aria-hidden
                      />
                      <span>
                        This clip contains location metadata. Clips recorded
                        in-app won&rsquo;t.
                      </span>
                    </p>
                  )}

                  {editingId === c.id ? (
                    <form
                      className="mt-1.5 space-y-1.5"
                      onSubmit={(e) => {
                        e.preventDefault();
                        saveCaption(c.id);
                      }}
                    >
                      <label
                        className="sr-only"
                        htmlFor={`clip-caption-${c.id}`}
                      >
                        Clip caption
                      </label>
                      <input
                        id={`clip-caption-${c.id}`}
                        data-testid={`video-clip-caption-input-${c.id}`}
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
                      notes={c.caption}
                      className="mt-1 text-slate-600 dark:text-slate-300"
                    />
                  )}
                </figcaption>
              </figure>
            );
          })}
        </div>
      )}

      {canWrite && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="video/*,audio/*"
            capture="environment"
            data-testid="video-clip-input"
            className="hidden"
            onChange={(e) => onPick(e.target.files?.[0])}
          />
          <div>
            <label className="label mb-0" htmlFor={`${testid}-caption`}>
              Caption (optional)
            </label>
            <input
              id={`${testid}-caption`}
              type="text"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="What does this show?"
              className="input mt-1 h-9 w-48 text-sm"
            />
          </div>
          <button
            type="button"
            data-testid="video-clip-add"
            disabled={pending}
            onClick={() => fileRef.current?.click()}
            className="btn-ghost btn-sm"
          >
            <IconVideo className="mr-1 inline h-3.5 w-3.5" stroke={1.75} />
            {pending ? "Adding…" : addLabel}
          </button>
        </div>
      )}
    </div>
  );
}
