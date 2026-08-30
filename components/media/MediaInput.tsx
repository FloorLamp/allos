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
import { useHydrated } from "@/components/useHydrated";
import { useCompactViewport } from "@/components/useCompactViewport";
import { useStandaloneDisplayMode } from "@/components/useStandaloneDisplayMode";
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
  mediaStartStage,
  type CameraDialogVariant,
  type CameraKnowledge,
} from "@/lib/photo/camera-fallback";

// THE ONE ADD-MEDIA SURFACE (#3286), over the #1119 pipeline. Every consumer
// that asks a person for image bytes opens THIS — progress photos, lesion and
// symptom capture, and the documents form's own doors — so there is one answer
// to "how do I get a picture in", not one per device the author had in mind.
//
// It puts a face on the #1119 pipeline; it does not reimplement it. EXIF-strip,
// compression and resize are still lib/photo's, client and server, unchanged.
//
// FOUR WAYS IN, all always available: choose a file, drop onto the dialog,
// paste from the clipboard, or use the camera. Device-awareness is ORDERING
// ONLY (lib/photo/camera-fallback's mediaStartStage): a phone-width viewport or
// a session-granted camera opens the viewfinder exactly as before; everywhere
// else the chooser leads. The defect that made this one component was the other
// arrangement — a desktop that had never granted camera opened onto "Camera
// access is blocked for this app" plus padlock instructions, with a green "Open
// camera" as the PRIMARY and file-choose demoted to a helper sentence: the one
// path that could not work was the one being pushed.
//
// SO CAMERA COPY IS ATTACHED TO THE CAMERA OPTION, never to the dialog. The
// recovery instructions render under "Use camera" once an attempt has actually
// failed, and nowhere else (#3071's standard: say what to do, not how
// permissions work).
//
// CAMERA PATH: getUserMedia live preview with an optional low-opacity
// ONION-SKIN ghost of the series' last photo, so you frame identically over
// time. Capture draws to a canvas sized by the pure fitWithin policy — a canvas
// re-encode carries no EXIF, so this path uploads clean and small by
// construction. The front camera mirrors the preview (and un-mirrors the pixels
// at capture, so the saved photo matches reality).
//
// FILE PATH: picked, dropped and pasted files are re-encoded client-side too
// (compressImageBlob), falling back to raw bytes if the browser can't decode
// them — and only for `image/*` bytes, so a consumer whose media is not an
// image hands its file through untouched. The SERVER pipeline strips and
// downscales regardless (never trust the client).
//
// BATCH: a `multiple` consumer takes a whole set in one interaction. Confirm
// lists every file by name and size, so a batch is a list of named things
// rather than a count, and the consumer posts one toast for the set.
//
// FORM CONSUMERS: pass `name` and the one real input carries it, so a
// <form action={...}> submit ships the files with no second field. That is
// UploadForm's donor mechanism (drop → DataTransfer → the real input),
// generalized rather than copied.

export interface MediaInputProps {
  // Button label for the trigger.
  triggerLabel?: string;
  // URL of the series' last photo, ghosted over the live preview. Null = no ghost.
  ghostUrl?: string | null;
  // Extra fields rendered inside the confirm step (pose/date/caption inputs).
  confirmFields?: ReactNode;
  // Called with the confirmed (client-compressed) files. Throw / return an
  // error string to keep the dialog open with the message shown.
  onConfirm: (files: File[]) => Promise<string | null | void>;
  // Open the flow immediately on mount (the FOCUS_PARAM deep-link from the
  // command palette's create action).
  autoOpen?: boolean;
  disabled?: boolean;
  className?: string;
  // Trigger test id, so a consumer's own spec can name ITS button rather than
  // the generic one (several add-media surfaces can share a page).
  triggerTestId?: string;
  // Trigger body, for a consumer whose door is a full-width dashed zone rather
  // than a button (the documents form's). It replaces the icon+label INSIDE the
  // one trigger element; it is not a second trigger.
  triggerContent?: ReactNode;
  // Test id for the one real input, so a spec can setInputFiles on it.
  inputTestId?: string;
  // What the picker accepts. Image-only by default; a consumer accepting other
  // bytes says so, and only the `image/*` ones are re-encoded client-side.
  accept?: string;
  // Take a whole set in one interaction.
  multiple?: boolean;
  // FormData key. Set it and the input becomes the host form's real field.
  name?: string;
  // Re-encode geometry/quality. Defaults are the physique-photo presets; a
  // consumer whose subject is TEXT (a photographed lab report, #1993) passes
  // the document presets instead, because a preset tuned for skin tone is not
  // tuned for something a downstream extraction has to read.
  maxEdge?: number;
  quality?: number;
  // Name given to a camera capture handed back through onConfirm.
  fileName?: string;
}

type Picked = { file: File; url: string | null };

type Stage =
  | { kind: "closed" }
  | { kind: "chooser" }
  | { kind: "camera" }
  | { kind: "confirm"; picked: Picked[] };

const CAMERA_KNOWLEDGE_KEY = "allos:camera-knowledge";
const CAMERA_FAILURE_KEY = "allos:camera-failure";

const CAMERA_COPY: Record<CameraDialogVariant, string> = {
  blocked: "Camera access is blocked for this app.",
  "in-use": "The camera is in use. Close other camera apps and try again.",
  "not-found": "No camera is available here.",
  unknown: "Couldn't open the camera.",
};

export default function MediaInput({
  triggerLabel = "Add photo",
  ghostUrl = null,
  confirmFields,
  onConfirm,
  autoOpen = false,
  disabled = false,
  className,
  triggerTestId = "media-input-open",
  triggerContent,
  inputTestId = "media-input-file",
  accept = "image/*",
  multiple = false,
  name,
  maxEdge = PHOTO_MAX_EDGE,
  quality = PHOTO_CLIENT_QUALITY,
  fileName = "photo.jpg",
}: MediaInputProps) {
  const [stage, setStage] = useState<Stage>({ kind: "closed" });
  const [error, setError] = useState<string | null>(null);
  // The camera option's OWN error. It renders beside that option and nowhere
  // else — never as the dialog's opening line (#3286).
  const [cameraError, setCameraError] = useState<CameraDialogVariant | null>(
    null
  );
  const [reloadOffered, setReloadOffered] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [ghostOn, setGhostOn] = useState(true);
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [pending, startTransition] = useTransition();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraKnowledgeRef = useRef<CameraKnowledge>("unknown");
  const permissionStateRef = useRef<PermissionState | null>(null);
  const hydrated = useHydrated();
  const compact = useCompactViewport();
  const standalone = useStandaloneDisplayMode();
  const recoveryPlatform = hydrated
    ? cameraRecoveryPlatform({
        userAgent: navigator.userAgent,
        standalone,
      })
    : "generic";

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const close = useCallback(() => {
    stopStream();
    setStage((s) => {
      if (s.kind === "confirm") revoke(s.picked);
      return { kind: "closed" };
    });
    setError(null);
    setCameraError(null);
    setDragActive(false);
  }, [stopStream]);

  const rememberCamera = useCallback(
    (knowledge: CameraKnowledge, failure?: CameraDialogVariant) => {
      cameraKnowledgeRef.current = knowledge;
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

  // Try the camera. On failure we land on the CHOOSER with the reason attached
  // to the camera option — the file paths sit right there, untouched, which is
  // the whole difference between an option that failed and a dead end.
  const attemptCamera = useCallback(
    async (retry = false) => {
      setError(null);
      const md = navigator.mediaDevices;
      if (!md?.getUserMedia) {
        rememberCamera("failed", "not-found");
        setCameraError("not-found");
        setStage({ kind: "chooser" });
        return;
      }
      try {
        const stream = await md.getUserMedia({
          video: { facingMode: facing },
          audio: false,
        });
        streamRef.current = stream;
        rememberCamera("granted");
        setCameraError(null);
        setStage({ kind: "camera" });
      } catch (cause) {
        const variant = cameraDialogVariant(
          cause instanceof DOMException || cause instanceof Error
            ? cause.name
            : null,
          permissionStateRef.current
        );
        rememberCamera(variant === "blocked" ? "denied" : "failed", variant);
        setCameraError(variant);
        setReloadOffered(retry && variant === "blocked");
        setStage({ kind: "chooser" });
      }
    },
    [facing, rememberCamera]
  );

  const open = useCallback(async () => {
    setError(null);
    const start = mediaStartStage({
      hasGetUserMedia: Boolean(navigator.mediaDevices?.getUserMedia),
      knowledge: cameraKnowledgeRef.current,
      compactViewport: compact,
    });
    if (start === "camera") {
      await attemptCamera();
      return;
    }
    setStage({ kind: "chooser" });
  }, [attemptCamera, compact]);

  // Prime the ordering decision before it is needed. Permissions is best effort
  // (Safari may not expose camera); the remembered last outcome is the portable
  // fallback. A permission change updates the same cache.
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
    } catch {}

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
            if (status.state === "denied") rememberCamera("denied", "blocked");
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

  // FOCUS_PARAM deep-link: open once on mount when asked. It no longer needs a
  // user-activation carve-out — the chooser is a dialog, and its Choose-file
  // button is itself the real tap that opens the native picker (#2182).
  const autoOpened = useRef(false);
  useEffect(() => {
    if (autoOpen && !disabled && !autoOpened.current) {
      autoOpened.current = true;
      void open();
    }
  }, [autoOpen, disabled, open]);

  // Client-side re-encode, image bytes ONLY: a video or audio clip has no
  // canvas decode and must reach its own pipeline byte-for-byte.
  const prepare = useCallback(
    async (files: File[]): Promise<Picked[]> =>
      Promise.all(
        files
          .filter((f) => f.size > 0)
          .map(async (file) => {
            if (!file.type.startsWith("image/")) return { file, url: null };
            const blob = await compressImageBlob(file, maxEdge, quality);
            const out = new File([blob], file.name, {
              type: blob.type || file.type,
            });
            return { file: out, url: URL.createObjectURL(out) };
          })
      ),
    [maxEdge, quality]
  );

  const toConfirm = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      stopStream();
      const picked = await prepare(multiple ? files : files.slice(0, 1));
      if (picked.length === 0) return;
      setStage((s) => {
        if (s.kind === "confirm") revoke(s.picked);
        return { kind: "confirm", picked };
      });
    },
    [prepare, stopStream, multiple]
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
      // The preview is mirrored for a natural selfie feel; capturing
      // un-mirrored pixels would look flipped vs. the framing — mirror the draw
      // to match.
      ctx.translate(width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", quality)
    );
    if (!blob) return;
    stopStream();
    // Already canvas-encoded at policy size, so it does NOT go through
    // prepare() — that would re-compress a frame this component just sized.
    setStage({
      kind: "confirm",
      picked: [
        {
          file: new File([blob], fileName, { type: "image/jpeg" }),
          url: URL.createObjectURL(blob),
        },
      ],
    });
  }, [facing, maxEdge, quality, fileName, stopStream]);

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
      setCameraError(variant);
      setStage({ kind: "chooser" });
    }
  }, [facing, stopStream, rememberCamera]);

  // A drop onto the dialog and a paste into it are the same landing as a pick.
  // preventDefault cancels the browser's own file handling so the DataTransfer
  // we read is exactly what the set becomes (UploadForm's donor mechanism).
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    if (disabled) return;
    void toConfirm(Array.from(e.dataTransfer.files ?? []));
  };

  // Paste is document-scoped because a dialog is what has focus, and a person
  // pressing Ctrl+V over an open add-media dialog has aimed at it clearly
  // enough. It is bound only while the chooser is up, so it can never steal a
  // paste from a caption field on the confirm step.
  useEffect(() => {
    if (stage.kind !== "chooser" || disabled) return;
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length === 0) return;
      e.preventDefault();
      void toConfirm(files);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [stage.kind, disabled, toConfirm]);

  const confirm = useCallback(() => {
    if (stage.kind !== "confirm") return;
    const files = stage.picked.map((p) => p.file);
    // Write the CONFIRMED set back into the one real input, so a `name`
    // consumer's <form> submit carries exactly these bytes — the compressed
    // ones, and the dropped and pasted ones a native picker never held.
    const input = fileInputRef.current;
    if (input) {
      const dt = new DataTransfer();
      files.forEach((f) => dt.items.add(f));
      input.files = dt.files;
    }
    startTransition(async () => {
      try {
        const err = await onConfirm(files);
        if (err) {
          setError(err);
          return;
        }
        close();
      } catch {
        setError(
          files.length > 1
            ? "Couldn't save the photos. Try again."
            : "Couldn't save the photo. Try again."
        );
      }
    });
  }, [stage, onConfirm, close]);

  return (
    <>
      {/* The TRIGGER IS ALSO A DROP TARGET. A person dragging a file at a page
          aims at the affordance they can see, not at a dialog that is not open
          yet — so a drop here opens straight into confirm with the files
          staged. It is the same handler the dialog's own zone uses, so there is
          one drop implementation and it works before and after the open. */}
      <button
        type="button"
        className={className ?? "btn"}
        onClick={() => void open()}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
        disabled={disabled}
        data-drag-active={dragActive ? "" : undefined}
        data-testid={triggerTestId}
      >
        {triggerContent ?? (
          <>
            <IconCamera size={18} aria-hidden />
            {triggerLabel}
          </>
        )}
      </button>

      {/* The ONE real picker, offscreen and always mounted. Every path — picked,
          dropped, pasted, photographed — lands in the same confirm step, and a
          `name` consumer submits this very element as its form field. */}
      <input
        ref={fileInputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        name={name}
        className="sr-only"
        tabIndex={-1}
        disabled={disabled}
        aria-label={`Choose ${multiple ? "files" : "a file"} to add`}
        data-testid={inputTestId}
        onChange={(e) => {
          void toConfirm(Array.from(e.target.files ?? []));
          e.currentTarget.value = "";
        }}
      />

      {stage.kind !== "closed" ? (
        <ModalShell
          title={triggerLabel}
          onClose={close}
          // A RECORDED anatomy exception to the #2774 convergence: this hosts a
          // live camera preview, and a flick-to-dismiss over a viewfinder the
          // user is aiming is a gesture collision, not an affordance. Registered
          // with its reason in lib/__tests__/overlay-motion-chokepoint.test.ts.
          presentation="centered"
        >
          <div className="space-y-3">
            {stage.kind === "chooser" ? (
              <div className="space-y-3" data-testid="media-input-chooser">
                {/* THE PRIMARY, on every device and in every camera state. */}
                <div
                  data-testid="media-input-dropzone"
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (!disabled) setDragActive(true);
                  }}
                  onDragLeave={() => setDragActive(false)}
                  onDrop={handleDrop}
                  className={`rounded-xl transition ${dragActive ? "ring-2 ring-brand-400" : ""}`}
                >
                  <button
                    type="button"
                    className="flex w-full cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed border-black/10 bg-slate-50 p-8 text-sm text-slate-500 transition hover:border-brand-400 hover:bg-brand-50 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500 dark:border-white/10 dark:bg-ink-900 dark:text-slate-400 dark:hover:bg-brand-950"
                    onClick={() => fileInputRef.current?.click()}
                    data-testid="media-input-choose"
                  >
                    <IconUpload className="h-6 w-6" stroke={1.75} aria-hidden />
                    <span>
                      <span className="font-medium text-brand-700 dark:text-brand-300">
                        {multiple ? "Choose files" : "Choose file"}
                      </span>{" "}
                      {/* Drag and paste are desktop gestures; naming them on a
                          phone would be instructions for a device the reader is
                          not holding. */}
                      {compact ? "from this device" : "or drop or paste here"}
                    </span>
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => void attemptCamera(cameraError !== null)}
                    data-testid="media-input-camera"
                  >
                    <IconCamera size={16} aria-hidden /> Use camera
                  </button>
                  {reloadOffered ? (
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => window.location.reload()}
                      data-testid="media-input-camera-reload"
                    >
                      <IconRefresh size={16} aria-hidden /> Reload and retry
                    </button>
                  ) : null}
                </div>

                {/* THE CAMERA OPTION'S OWN ERROR. Nothing here renders until a
                    camera attempt has actually failed, which is why the dialog
                    can no longer open onto permission instructions (#3286). */}
                {cameraError ? (
                  <div
                    className="space-y-2"
                    data-testid="media-input-camera-error"
                  >
                    <p className="text-sm text-slate-600 dark:text-slate-300">
                      {CAMERA_COPY[cameraError]}
                    </p>
                    {cameraError === "blocked" ? (
                      <ol
                        className="list-decimal space-y-1 pl-5 text-sm text-slate-600 dark:text-slate-300"
                        data-testid="media-input-camera-recovery"
                      >
                        {CAMERA_RECOVERY_INSTRUCTIONS[recoveryPlatform].map(
                          (instruction) => (
                            <li key={instruction}>{instruction}</li>
                          )
                        )}
                      </ol>
                    ) : null}
                  </div>
                ) : null}

                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Photos are resized and cleaned of camera metadata (location,
                  device info) before they are stored.
                </p>
              </div>
            ) : null}

            {stage.kind === "camera" ? (
              <>
                <div className="relative overflow-hidden rounded-lg bg-black">
                  <video
                    ref={videoRef}
                    playsInline
                    muted
                    className={`max-h-[60vh] w-full object-contain ${facing === "user" ? "-scale-x-100" : ""}`}
                    data-testid="media-input-video"
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
                      data-testid="media-input-ghost"
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
                      setStage({ kind: "chooser" });
                    }}
                    data-testid="media-input-use-file"
                  >
                    <IconUpload size={16} aria-hidden /> Choose a file instead
                  </button>
                </div>
              </>
            ) : null}

            {stage.kind === "confirm" ? (
              <div className="space-y-3">
                {/* PER-FILE, so a batch is a list of named things rather than a
                    count. A file with no image preview (a clip) still gets its
                    own row. */}
                <ul className="space-y-2" data-testid="media-input-selected">
                  {stage.picked.map((p, i) => (
                    <li
                      key={`${p.file.name}-${i}`}
                      className="space-y-1"
                      data-testid={`media-input-selected-${i}`}
                    >
                      {p.url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={p.url}
                          alt={`Preview of ${p.file.name}`}
                          className="max-h-[40vh] w-full rounded-lg object-contain"
                          data-testid={`media-input-preview-${i}`}
                        />
                      ) : null}
                      <span className="flex justify-between gap-3 text-sm text-slate-600 dark:text-slate-300">
                        <span className="truncate">{p.file.name}</span>
                        <span className="shrink-0 tabular-nums text-slate-500 dark:text-slate-400">
                          {formatSize(p.file.size)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
                {confirmFields}
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="btn"
                    onClick={confirm}
                    disabled={pending}
                    data-testid="media-input-submit"
                  >
                    {pending
                      ? "Saving…"
                      : stage.picked.length > 1
                        ? `Add ${stage.picked.length} files`
                        : "Add file"}
                  </button>
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={pending}
                    onClick={() => {
                      revoke(stage.picked);
                      setError(null);
                      setStage({ kind: "chooser" });
                    }}
                    data-testid="media-input-retake"
                  >
                    Start over
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

function revoke(picked: Picked[]) {
  picked.forEach((p) => p.url && URL.revokeObjectURL(p.url));
}

// Compact human size for the selected-files list (bytes → KB/MB, one decimal).
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}
