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
import {
  CAMERA_RECOVERY_INSTRUCTIONS,
  cameraDialogVariant,
  cameraRecoveryPlatform,
  cameraStartDecision,
  type CameraDialogVariant,
  type CameraKnowledge,
  type CameraRecoveryPlatform,
} from "@/lib/photo/camera-fallback";

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
  // Trigger test id, so a consumer's own spec can name ITS capture button rather
  // than the generic one (several capture surfaces can share a page).
  triggerTestId?: string;
  // Re-encode geometry/quality. Defaults are the physique-photo presets; a
  // consumer whose subject is TEXT (a photographed lab report, #1993) passes the
  // document presets instead, because a preset tuned for skin tone is not tuned
  // for something a downstream extraction has to read.
  maxEdge?: number;
  quality?: number;
  // Name given to the file handed back through onConfirm.
  fileName?: string;
}

type Stage =
  | { kind: "closed" }
  | { kind: "camera" }
  | {
      kind: "fallback";
      variant: CameraDialogVariant;
      reloadOffered?: boolean;
    }
  | { kind: "confirm"; blob: Blob; url: string };

const CAMERA_KNOWLEDGE_KEY = "allos:camera-knowledge";
const CAMERA_FAILURE_KEY = "allos:camera-failure";

export default function PhotoCapture({
  triggerLabel = "Add photo",
  ghostUrl = null,
  confirmFields,
  onConfirm,
  autoOpen = false,
  disabled = false,
  className,
  triggerTestId = "photo-capture-open",
  maxEdge = PHOTO_MAX_EDGE,
  quality = PHOTO_CLIENT_QUALITY,
  fileName = "photo.jpg",
}: PhotoCaptureProps) {
  const [stage, setStage] = useState<Stage>({ kind: "closed" });
  const [error, setError] = useState<string | null>(null);
  const [ghostOn, setGhostOn] = useState(true);
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [pending, startTransition] = useTransition();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraKnowledgeRef = useRef<CameraKnowledge>("unknown");
  const lastFailureRef = useRef<CameraDialogVariant>("unknown");
  const permissionStateRef = useRef<PermissionState | null>(null);
  const [recoveryPlatform, setRecoveryPlatform] =
    useState<CameraRecoveryPlatform>("generic");

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

  const rememberCamera = useCallback(
    (knowledge: CameraKnowledge, failure?: CameraDialogVariant) => {
      cameraKnowledgeRef.current = knowledge;
      if (failure) lastFailureRef.current = failure;
      try {
        sessionStorage.setItem(CAMERA_KNOWLEDGE_KEY, knowledge);
        if (failure) sessionStorage.setItem(CAMERA_FAILURE_KEY, failure);
      } catch {
        // Storage can be unavailable in private contexts; the in-memory session
        // still prevents every capture from paying the first-failure tax.
      }
    },
    []
  );

  const attemptCamera = useCallback(
    async (retry = false) => {
      setError(null);
      const md = navigator.mediaDevices;
      if (!md?.getUserMedia) {
        rememberCamera("failed", "not-found");
        setStage({ kind: "fallback", variant: "not-found" });
        return;
      }
      try {
        const stream = await md.getUserMedia({
          video: { facingMode: facing },
          audio: false,
        });
        streamRef.current = stream;
        rememberCamera("granted");
        setStage({ kind: "camera" });
      } catch (cause) {
        const variant = cameraDialogVariant(
          cause instanceof DOMException || cause instanceof Error
            ? cause.name
            : null,
          permissionStateRef.current
        );
        rememberCamera(variant === "blocked" ? "denied" : "failed", variant);
        setStage({
          kind: "fallback",
          variant,
          reloadOffered: retry && variant === "blocked",
        });
      }
    },
    [facing, rememberCamera]
  );

  // A real tap may synchronously open the native picker for a known fallback.
  // autoOpen deliberately cannot: it has no transient user activation, so it
  // always opens the dialog and waits for one (#2182 follow-up).
  const open = useCallback(
    async (userInitiated: boolean) => {
      setError(null);
      const hasGetUserMedia = Boolean(navigator.mediaDevices?.getUserMedia);
      const decision = cameraStartDecision({
        userInitiated,
        hasGetUserMedia,
        knowledge: cameraKnowledgeRef.current,
      });
      if (decision === "direct-picker") {
        fileInputRef.current?.click();
        return;
      }
      if (decision === "show-fallback") {
        const variant = !hasGetUserMedia
          ? "not-found"
          : cameraKnowledgeRef.current === "denied"
            ? "blocked"
            : lastFailureRef.current;
        setStage({ kind: "fallback", variant });
        return;
      }
      await attemptCamera();
    },
    [attemptCamera]
  );

  // Prime the synchronous tap decision before it is needed. Permissions is best
  // effort (Safari may not expose camera); the remembered last outcome is the
  // portable fallback. A permission change updates the same cache.
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(CAMERA_KNOWLEDGE_KEY);
      if (
        stored === "unknown" ||
        stored === "granted" ||
        stored === "denied" ||
        stored === "failed"
      ) {
        cameraKnowledgeRef.current = stored;
      }
      const failure = sessionStorage.getItem(CAMERA_FAILURE_KEY);
      if (
        failure === "blocked" ||
        failure === "not-found" ||
        failure === "in-use" ||
        failure === "unknown"
      ) {
        lastFailureRef.current = failure;
      }
    } catch {}

    setRecoveryPlatform(
      cameraRecoveryPlatform({
        userAgent: navigator.userAgent,
        standalone: window.matchMedia("(display-mode: standalone)").matches,
      })
    );

    let disposed = false;
    let permission: PermissionStatus | null = null;
    const permissions = navigator.permissions;
    if (permissions?.query) {
      void permissions
        .query({ name: "camera" as PermissionName })
        .then((status) => {
          if (disposed) return;
          permission = status;
          const update = () => {
            permissionStateRef.current = status.state;
            if (status.state === "granted") rememberCamera("granted");
            if (status.state === "denied") {
              rememberCamera("denied", "blocked");
              setStage((current) =>
                current.kind === "fallback" && current.variant === "unknown"
                  ? { kind: "fallback", variant: "blocked" }
                  : current
              );
            }
          };
          update();
          status.onchange = update;
        })
        .catch(() => {});
    }
    return () => {
      disposed = true;
      if (permission) permission.onchange = null;
    };
  }, [rememberCamera]);

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
      void open(false);
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
      maxEdge
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
      canvas.toBlob(resolve, "image/jpeg", quality)
    );
    if (blob) toConfirm(blob);
  }, [facing, toConfirm, maxEdge, quality]);

  const onFilePicked = useCallback(
    async (file: File | null) => {
      if (!file || file.size === 0) return;
      const compressed = await compressImageBlob(file, maxEdge, quality);
      toConfirm(compressed);
    },
    [toConfirm, maxEdge, quality]
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
    } catch (cause) {
      const variant = cameraDialogVariant(
        cause instanceof DOMException || cause instanceof Error
          ? cause.name
          : null,
        permissionStateRef.current
      );
      rememberCamera(variant === "blocked" ? "denied" : "failed", variant);
      setStage({ kind: "fallback", variant });
    }
  }, [facing, stopStream, rememberCamera]);

  const confirm = useCallback(() => {
    if (stage.kind !== "confirm") return;
    const file = new File([stage.blob], fileName, { type: "image/jpeg" });
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
  }, [stage, onConfirm, close, fileName]);

  return (
    <>
      <button
        type="button"
        className={className ?? "btn"}
        onClick={() => void open(true)}
        disabled={disabled}
        data-testid={triggerTestId}
      >
        <IconCamera size={18} aria-hidden />
        {triggerLabel}
      </button>

      {/* Always mounted so a known fallback can click it synchronously inside the
          original user gesture. Native input chrome never becomes visible. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        data-testid="photo-capture-file"
        onChange={(e) => {
          void onFilePicked(e.target.files?.[0] ?? null);
          e.currentTarget.value = "";
        }}
      />

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
                      setStage({ kind: "fallback", variant: "unknown" });
                    }}
                  >
                    <IconUpload size={16} aria-hidden /> Upload a file instead
                  </button>
                </div>
              </>
            ) : null}

            {stage.kind === "fallback" ? (
              <div className="space-y-3" data-testid="photo-capture-fallback">
                {stage.variant === "blocked" ? (
                  <div
                    className="space-y-2"
                    data-testid="photo-capture-blocked-guidance"
                  >
                    <p className="font-medium text-slate-800 dark:text-slate-100">
                      Camera access is blocked for this app
                    </p>
                    <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-600 dark:text-slate-300">
                      {CAMERA_RECOVERY_INSTRUCTIONS[recoveryPlatform].map(
                        (instruction) => (
                          <li key={instruction}>{instruction}</li>
                        )
                      )}
                    </ol>
                  </div>
                ) : stage.variant === "in-use" ? (
                  <p className="text-sm text-slate-600 dark:text-slate-300">
                    The camera is in use. Close other camera apps and try again.
                  </p>
                ) : stage.variant === "not-found" ? (
                  <p className="text-sm text-slate-600 dark:text-slate-300">
                    A live camera is not available here. You can use the device
                    camera picker instead.
                  </p>
                ) : (
                  <p className="text-sm text-slate-600 dark:text-slate-300">
                    The live camera could not open. You can try again or use the
                    device camera picker.
                  </p>
                )}

                <div className="flex flex-wrap gap-2">
                  {stage.variant !== "not-found" ? (
                    stage.reloadOffered ? (
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => window.location.reload()}
                        data-testid="photo-capture-reload-retry"
                      >
                        <IconRefresh size={16} aria-hidden /> Reload and retry
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => void attemptCamera(true)}
                        data-testid="photo-capture-camera-retry"
                      >
                        <IconRefresh size={16} aria-hidden /> Try again
                      </button>
                    )
                  ) : null}
                  <button
                    type="button"
                    className="btn"
                    onClick={() => fileInputRef.current?.click()}
                    data-testid="photo-capture-picker-open"
                  >
                    <IconCamera size={18} aria-hidden /> Open camera
                  </button>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Choose a photo to add. It is resized and cleaned of camera
                  metadata (location, device info) before it is stored.
                </p>
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
                      void open(true); // re-decides camera vs known fallback
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
