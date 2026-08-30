"use client";

import { useState, useTransition } from "react";
import { IconVideo, IconMicrophone, IconMapPin } from "@tabler/icons-react";
import MediaInput from "@/components/media/MediaInput";
import OverflowMenu, {
  MENU_ITEM,
  MENU_ITEM_DANGER,
} from "@/components/OverflowMenu";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import NotesText from "@/components/NotesText";
import { extractPosterFrame } from "@/lib/video/client-poster";

// The shared capture → poster-grid → open-to-play surface of the video core
// (#1224 phase 1) — every video-carrying domain (symptom/episode clips and
// activity media; in-app recording in phase 2) renders THIS instead of
// a bespoke strip, so the privacy note, the poster-first grid (the clip loads only
// on open), and the audio/location affordances can never diverge per domain (the
// #221 one-surface / #1119 one-core philosophy).
//
// Upload-only MVP (#1224): the door is <MediaInput>, the one add-media surface
// (#3286) — choose, drop or paste, on every device. It offers NO camera here, and
// that is derived rather than configured: MediaInput's viewfinder captures a canvas
// frame, which is a still, so it is a way in only where images are wanted. In-app
// recording is #1224 phase 2. MediaInput hands `video/*` and `audio/*` bytes
// through untouched — its client re-encode is image-only — so the clip reaches this
// pipeline byte-for-byte. On pick, a poster frame is extracted CLIENT-side (canvas)
// and submitted alongside; the SERVER re-strips the poster's metadata and stores the
// clip AS-IS. A clip whose bytes carry embedded LOCATION metadata shows the visible
// privacy note (clips recorded in-app in phase 2 won't).

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
  showAdd = true,
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
  // Whether the ADD affordance (file picker + caption + button) renders. Split out
  // of `canWrite` by #1457: the training tenant's Training Log card now shows clips
  // read/playback-style with per-clip edit + delete (so it still needs `canWrite`)
  // while the "add" entry point lives in the activity editor. Defaults to today's
  // behavior so the symptom/episode tenant is untouched.
  showAdd?: boolean;
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
  const toast = useToast();
  const confirm = useConfirm();
  const [openId, setOpenId] = useState<number | null>(null);
  const [caption, setCaption] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [captionDraft, setCaptionDraft] = useState("");
  const [menuOpenId, setMenuOpenId] = useState<number | null>(null);

  // One upload per clip so a refusal names the clip it refused, and ONE toast for
  // the set. Returning a string keeps the dialog open with the reason, which is
  // how a whole-batch refusal stays on screen next to the files it is about.
  async function onPick(files: File[]): Promise<string | null> {
    const failed: string[] = [];
    for (const file of files) {
      // Best-effort client poster; the upload proceeds posterless on failure.
      let poster: Blob | null = null;
      try {
        poster = await extractPosterFrame(file);
      } catch {
        poster = null;
      }
      const res = await onUpload(file, poster, caption.trim());
      if (!res.ok) failed.push(`${file.name}: ${res.error}`);
    }
    if (failed.length === files.length) return failed.join("; ");
    const added = files.length - failed.length;
    setCaption("");
    toast(
      failed.length > 0
        ? `Attached ${added} of ${files.length}. ${failed.join("; ")}`
        : added > 1
          ? `${added} clips attached.`
          : "Clip attached."
    );
    return null;
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
                      <span className="absolute bottom-1 right-1 rounded-sm bg-black/60 px-1 text-xs font-medium tabular-nums text-white">
                        {dur}
                      </span>
                    )}
                  </button>
                )}

                <figcaption className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
                  <div className="flex items-center justify-between gap-1">
                    <span className="truncate">{c.label}</span>
                    {canWrite && (
                      <OverflowMenu
                        kind="Clip"
                        itemName={c.caption || c.label}
                        open={menuOpenId === c.id}
                        onOpenChange={(open) =>
                          setMenuOpenId(open ? c.id : null)
                        }
                      >
                        {({ close }) => (
                          <>
                            <button
                              type="button"
                              role="menuitem"
                              disabled={pending}
                              onClick={() => {
                                setEditingId(c.id);
                                setCaptionDraft(c.caption ?? "");
                                close();
                              }}
                              className={MENU_ITEM}
                            >
                              Edit caption
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              disabled={pending}
                              onClick={async () => {
                                const ok = await confirm({
                                  title: "Delete clip?",
                                  message:
                                    "This clip will be permanently deleted.",
                                  confirmLabel: "Delete",
                                  danger: true,
                                });
                                if (!ok) return;
                                remove(c.id);
                              }}
                              className={MENU_ITEM_DANGER}
                            >
                              Delete clip
                            </button>
                          </>
                        )}
                      </OverflowMenu>
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
                    // A <div>, not a <form> (#1457): this grid now also renders
                    // INSIDE the activity editor's own <form>, and a nested form is
                    // invalid HTML. Enter still saves, via the key handler below.
                    <div className="mt-1.5 space-y-1.5">
                      <label
                        className="sr-only"
                        htmlFor={`clip-caption-${c.id}`}
                      >
                        Clip caption
                      </label>
                      <input
                        id={`clip-caption-${c.id}`}
                        data-testid={`video-clip-caption-input-${c.id}`}
                        className="input w-full px-2 text-xs"
                        value={captionDraft}
                        onChange={(e) => setCaptionDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            saveCaption(c.id);
                          }
                        }}
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
                          type="button"
                          className="btn px-2 py-1 text-xs"
                          disabled={pending}
                          onClick={() => saveCaption(c.id)}
                        >
                          {pending ? "Saving…" : "Save"}
                        </button>
                      </div>
                    </div>
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

      {canWrite && showAdd && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
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
              className="input mt-1 w-48 text-sm"
            />
          </div>
          <MediaInput
            triggerLabel={pending ? "Adding…" : addLabel}
            triggerTestId="video-clip-add"
            inputTestId="video-clip-input"
            className="btn-ghost btn-sm"
            accept="video/*,audio/*"
            multiple
            disabled={pending}
            onConfirm={onPick}
          />
        </div>
      )}
    </div>
  );
}
