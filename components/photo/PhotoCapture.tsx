"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { IconCamera, IconRefresh, IconUpload } from "@tabler/icons-react";
import ModalShell from "@/components/ModalShell";
import { compressImageBlob } from "@/lib/photo/client-compress";
import {
  fitWithin,
  PHOTO_MAX_EDGE,
  PHOTO_CLIENT_QUALITY,
} from "@/lib/photo/policy";

// The shared in-app capture surface of the photo core (#1119 phase 1) — every
// photo domain (physique now; skin/symptom in phase 3; video in #1224 rides the
// same shell) opens THIS component instead of a bare file input.
//
//   - Camera path: getUserMedia live preview with an optional low-opacity
//     ONION-SKIN ghost of the series' last photo, so you frame identically over
//     time. Capture draws to a canvas sized by the pure fitWithin policy — a
//     canvas re-encode carries no EXIF, so this path uploads clean + small by
//     construction. Front camera mirrors the preview (and un-mirrors the pixels
//     at capture, so the saved photo matches reality).
//   - Native fallback: when getUserMedia is unavailable/denied (PWA-safe, CI,
//     older devices) a file input takes over; the picked file is re-encoded
//     client-side too (compressImageBlob), falling back to raw bytes if the
//     browser can't decode them. The SERVER pipeline strips + downscales
//     regardless (never trust the client).
//
// Both paths land in the same confirm/retake step, whose domain-specific fields
// (pose picker, date, caption) the consumer renders via `confirmFields`. Submit
// hands a `File` back through `onConfirm` — the consumer builds its FormData and
// calls its own gated Server Action.

export interface PhotoCaptureProps {
  // Button label for the trigger.
  triggerLabel?: string;
  // URL of the series' last photo, ghosted over the live preview. Null = no ghost.
  ghostUrl?: string | null;
  // Extra fields rendered inside the confirm step (pose/date/caption inputs).
  confirmFields?: ReactNode;
  // Called with the captured/picked (client-compressed) file on confirm. Throw /
  // return an error string to keep the modal open with the message shown.
  onConfirm: (file: File) => Promise<string | null | void>;
  // Open the capture flow immediately on mount (the FOCUS_PARAM deep-link from
  // the command palette's create action).
  autoOpen?: boolean;
  disabled?: boolean;
  className?: string;
}

type Stage =
  | { kind: "closed" }
  | { kind: "camera" }
  | { kind: "fallback" }
  | { kind: "confirm"; blob: Blob; url: string };

export default function PhotoCapture({
  triggerLabel = "Add photo",
  ghostUrl = null,
  confirmFields,
  onConfirm,
  autoOpen = false,
  disabled = false,
  className,
}: PhotoCaptureProps) {
  const [stage, setStage] = useState<Stage>({ kind: "closed" });
  const [error, setError] = useState<string | null>(null);
  const [ghostOn, setGhostOn] = useState(true);
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [pending, startTransition] = useTransition();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const close = useCallback(() => {
    stopStream();
    setStage((s) => {
      if (s.kind === "confirm") URL.revokeObjectURL(s.url);
      return { kind: "closed" };
    });
    setError(null);
  }, [stopStream]);

  // Open: try the camera; fall back to the file input when it's missing/denied.
  const open = useCallback(async () => {
    setError(null);
    const md =
      typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (!md?.getUserMedia) {
      setStage({ kind: "fallback" });
      return;
    }
    try {
      const stream = await md.getUserMedia({
        video: { facingMode: facing },
        audio: false,
      });
      streamRef.current = stream;
      setStage({ kind: "camera" });
    } catch {
      setStage({ kind: "fallback" });
    }
  }, [facing]);

  // Attach the stream once the <video> exists.
  useEffect(() => {
    if (stage.kind === "camera" && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
      videoRef.current.play().catch(() => {});
    }
  }, [stage.kind]);

  useEffect(() => stopStream, [stopStream]); // unmount cleanup

  // FOCUS_PARAM deep-link: open once on mount when asked.
  const autoOpened = useRef(false);
  useEffect(() => {
    if (autoOpen && !disabled && !autoOpened.current) {
      autoOpened.current = true;
      void open();
    }
  }, [autoOpen, disabled, open]);

  const toConfirm = useCallback(
    (blob: Blob) => {
      stopStream();
      setStage({ kind: "confirm", blob, url: URL.createObjectURL(blob) });
    },
    [stopStream]
  );

  const capture = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const { width, height } = fitWithin(
      video.videoWidth,
      video.videoHeight,
      PHOTO_MAX_EDGE
    );
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (facing === "user") {
      // The preview is mirrored for a natural selfie feel; capture un-mirrored
      // pixels would look flipped vs. the framing — mirror the draw to match.
      ctx.translate(width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", PHOTO_CLIENT_QUALITY)
    );
    if (blob) toConfirm(blob);
  }, [facing, toConfirm]);

  const onFilePicked = useCallback(
    async (file: File | null) => {
      if (!file || file.size === 0) return;
      const compressed = await compressImageBlob(file);
      toConfirm(compressed);
    },
    [toConfirm]
  );

  const switchCamera = useCallback(async () => {
    const next = facing === "environment" ? "user" : "environment";
    setFacing(next);
    stopStream();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: next },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch(() => {});
      }
    } catch {
      setStage({ kind: "fallback" });
    }
  }, [facing, stopStream]);

  const confirm = useCallback(() => {
    if (stage.kind !== "confirm") return;
    const file = new File([stage.blob], "photo.jpg", { type: "image/jpeg" });
    startTransition(async () => {
      try {
        const err = await onConfirm(file);
        if (err) {
          setError(err);
          return;
        }
        close();
      } catch {
        setError("Couldn't save the photo. Try again.");
      }
    });
  }, [stage, onConfirm, close]);

  return (
    <>
      <button
        type="button"
        className={className ?? "btn"}
        onClick={open}
        disabled={disabled}
        data-testid="photo-capture-open"
      >
        <IconCamera size={18} aria-hidden />
        {triggerLabel}
      </button>

      {stage.kind !== "closed" ? (
        <ModalShell title={triggerLabel} onClose={close}>
          <div className="space-y-3">
            {stage.kind === "camera" ? (
              <>
                <div className="relative overflow-hidden rounded-lg bg-black">
                  <video
                    ref={videoRef}
                    playsInline
                    muted
                    className={`max-h-[60vh] w-full object-contain ${facing === "user" ? "-scale-x-100" : ""}`}
                    data-testid="photo-capture-video"
                  />
                  {ghostUrl && ghostOn ? (
                    // The onion-skin ghost: the series' last photo at low
                    // opacity so this frame lines up with the previous one.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={ghostUrl}
                      alt=""
                      aria-hidden
                      className="pointer-events-none absolute inset-0 h-full w-full object-contain opacity-40"
                      data-testid="photo-capture-ghost"
                    />
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" className="btn" onClick={capture}>
                    <IconCamera size={18} aria-hidden /> Capture
                  </button>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={switchCamera}
                  >
                    <IconRefresh size={16} aria-hidden /> Switch camera
                  </button>
                  {ghostUrl ? (
                    <label className="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-300">
                      <input
                        type="checkbox"
                        checked={ghostOn}
                        onChange={(e) => setGhostOn(e.target.checked)}
                      />
                      Overlay last photo
                    </label>
                  ) : null}
                  <button
                    type="button"
                    className="btn-ghost ml-auto"
                    onClick={() => {
                      stopStream();
                      setStage({ kind: "fallback" });
                    }}
                  >
                    <IconUpload size={16} aria-hidden /> Upload a file instead
                  </button>
                </div>
              </>
            ) : null}

            {stage.kind === "fallback" ? (
              <div className="space-y-2">
                <p className="text-sm text-slate-600 dark:text-slate-300">
                  Choose a photo to add. It's resized and cleaned of camera
                  metadata (location, device info) before it's stored.
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="block text-sm"
                  data-testid="photo-capture-file"
                  onChange={(e) =>
                    void onFilePicked(e.target.files?.[0] ?? null)
                  }
                />
              </div>
            ) : null}

            {stage.kind === "confirm" ? (
              <div className="space-y-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={stage.url}
                  alt="Captured photo preview"
                  className="max-h-[50vh] w-full rounded-lg object-contain"
                  data-testid="photo-capture-preview"
                />
                {confirmFields}
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="btn"
                    onClick={confirm}
                    disabled={pending}
                    data-testid="photo-capture-submit"
                  >
                    {pending ? "Saving…" : "Use photo"}
                  </button>
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={pending}
                    onClick={() => {
                      URL.revokeObjectURL(stage.url);
                      setError(null);
                      void open(); // re-decides camera vs fallback
                    }}
                    data-testid="photo-capture-retake"
                  >
                    Retake
                  </button>
                </div>
              </div>
            ) : null}

            {error ? (
              <p
                className="text-sm text-rose-600 dark:text-rose-400"
                role="alert"
              >
                {error}
              </p>
            ) : null}
          </div>
        </ModalShell>
      ) : null}
    </>
  );
}
