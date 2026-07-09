"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLockBodyScroll } from "./useLockBodyScroll";

// A dependency-free circular image cropper used by the profile photo pickers
// (Settings → Profile and the Family admin screen). The user drags to pan and
// uses the slider / mouse wheel to zoom; a circular overlay previews exactly how
// the avatar will be masked. On confirm it renders the visible square region to
// a canvas and hands back a cropped image File (never the original), so the
// stored photo is already framed and small.

// Display size of the (square) crop viewport in CSS px. The circle is inscribed.
const VIEWPORT = 256;
// Edge length of the exported image in px — square, masked to a circle on display.
const OUTPUT = 512;
const MAX_ZOOM = 4;

// The upload actions only accept these; keep the output type to one of them. We
// can't import lib/profile-photo (it pulls in node:path) into a client bundle.
const ACCEPTED = new Set(["image/png", "image/jpeg", "image/webp"]);

// Clamp the image top-left so the scaled image always fully covers the viewport
// (no gaps inside the crop circle). Since the base scale is "cover", the scaled
// dimension is always >= VIEWPORT, so min <= 0 = max.
function clampPos(pos: number, scaledDim: number): number {
  const min = VIEWPORT - scaledDim;
  return Math.min(0, Math.max(min, pos));
}

export default function ImageCropper({
  file,
  onCancel,
  onCropped,
}: {
  file: File;
  onCancel: () => void;
  onCropped: (cropped: File) => void;
}) {
  useLockBodyScroll(true);

  const [url, setUrl] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  // zoom + top-left offset kept in one state object so wheel/pan updates that
  // depend on the previous view (e.g. zooming around the center) can be pure
  // functional updates — several wheel ticks in a frame then accumulate instead
  // of collapsing to one.
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const [busy, setBusy] = useState(false);

  // Latest natural size + view, readable synchronously from the deps-free
  // applyZoom and the pointer handlers below (which start gestures from the
  // committed view without re-subscribing on every change).
  const naturalRef = useRef(natural);
  naturalRef.current = natural;
  const viewRef = useRef(view);
  viewRef.current = view;

  // Object URL for the chosen file; revoked on unmount / file change.
  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  // Once the natural dimensions are known, start centered at zoom 1.
  const onImgLoad = useCallback((el: HTMLImageElement) => {
    imgRef.current = el;
    const w = el.naturalWidth;
    const h = el.naturalHeight;
    if (!w || !h) return;
    const base = Math.max(VIEWPORT / w, VIEWPORT / h);
    const scaledW = w * base;
    const scaledH = h * base;
    setNatural({ w, h });
    setView({
      zoom: 1,
      x: (VIEWPORT - scaledW) / 2,
      y: (VIEWPORT - scaledH) / 2,
    });
  }, []);

  const baseScale = natural
    ? Math.max(VIEWPORT / natural.w, VIEWPORT / natural.h)
    : 1;
  const scale = baseScale * view.zoom;
  const scaledW = natural ? natural.w * scale : VIEWPORT;
  const scaledH = natural ? natural.h * scale : VIEWPORT;

  // Re-zoom around the viewport center so the framed subject stays put. `update`
  // maps the current zoom to the desired one (a multiplier for wheel, an
  // absolute value for the slider); resolving it inside the functional update
  // keeps rapid successive calls accumulating. Stable identity (no deps) means
  // the wheel listener below subscribes once.
  const applyZoom = useCallback((update: (currentZoom: number) => number) => {
    setView((prev) => {
      const nat = naturalRef.current;
      if (!nat) return prev;
      const base = Math.max(VIEWPORT / nat.w, VIEWPORT / nat.h);
      const z = Math.min(MAX_ZOOM, Math.max(1, update(prev.zoom)));
      const oldScale = base * prev.zoom;
      const newScale = base * z;
      // Image-space point currently under the viewport center.
      const cx = (VIEWPORT / 2 - prev.x) / oldScale;
      const cy = (VIEWPORT / 2 - prev.y) / oldScale;
      const x = clampPos(VIEWPORT / 2 - cx * newScale, nat.w * newScale);
      const y = clampPos(VIEWPORT / 2 - cy * newScale, nat.h * newScale);
      return { zoom: z, x, y };
    });
  }, []);

  // Pointer gestures: one pointer pans, two pinch-zoom. Positions of every
  // active pointer live in `pointers`; `gesture` holds the frame of reference
  // captured when the current gesture began. Pointer capture keeps events
  // flowing even if a finger/cursor slides off the crop area.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<
    | { mode: "pan"; sx: number; sy: number; px: number; py: number }
    // For pinch we anchor the image point that was under the two-finger
    // midpoint at gesture start, so pinching zooms and pans about the fingers.
    | {
        mode: "pinch";
        startDist: number;
        startZoom: number;
        ix: number;
        iy: number;
      }
    | null
  >(null);

  function baseScaleFor(nat: { w: number; h: number }) {
    return Math.max(VIEWPORT / nat.w, VIEWPORT / nat.h);
  }

  // Begin a pan from the current committed view using the one active pointer.
  function startPan() {
    const [pt] = pointers.current.values();
    if (!pt) return;
    const v = viewRef.current;
    gesture.current = { mode: "pan", sx: pt.x, sy: pt.y, px: v.x, py: v.y };
  }

  // Begin (or re-anchor) a pinch: record the finger distance and the image-space
  // point under their midpoint, frozen at this moment. Re-anchoring on every
  // pointer add/remove keeps a 3rd finger — or lifting one of three — from
  // snapping the view, since the frame of reference always matches the two
  // pointers actually in use.
  function startPinch() {
    const nat = naturalRef.current;
    const el = areaRef.current;
    if (!nat || !el) return;
    const [a, b] = [...pointers.current.values()];
    if (!a || !b) return;
    const rect = el.getBoundingClientRect();
    const midX = (a.x + b.x) / 2 - rect.left;
    const midY = (a.y + b.y) / 2 - rect.top;
    const v = viewRef.current;
    const startScale = baseScaleFor(nat) * v.zoom;
    gesture.current = {
      mode: "pinch",
      // Floor to 1px so a two-finger tap landing on the same spot can't divide
      // by zero (→ NaN view) or snap instantly to max zoom.
      startDist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      startZoom: v.zoom,
      ix: (midX - v.x) / startScale,
      iy: (midY - v.y) / startScale,
    };
  }

  // Point the gesture frame at whatever pointers are down now: 2+ → pinch,
  // 1 → pan, 0 → idle. Called on every pointer down/up so the reference frame
  // never lags the actual fingers.
  function resyncGesture() {
    const n = pointers.current.size;
    if (n >= 2) startPinch();
    else if (n === 1) startPan();
    else gesture.current = null;
  }

  function onPointerDown(e: React.PointerEvent) {
    if (!natural || busy) return;
    // Register the pointer first; capture is best-effort (it throws for
    // synthetic pointers and isn't required for the gesture to work).
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try {
      (e.target as Element).setPointerCapture(e.pointerId);
    } catch {
      // capture unavailable — events still bubble to this element
    }
    resyncGesture();
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g) return;

    if (g.mode === "pan") {
      const dx = e.clientX - g.sx;
      const dy = e.clientY - g.sy;
      setView((prev) => {
        const nat = naturalRef.current;
        if (!nat) return prev;
        const s = baseScaleFor(nat) * prev.zoom;
        return {
          ...prev,
          x: clampPos(g.px + dx, nat.w * s),
          y: clampPos(g.py + dy, nat.h * s),
        };
      });
      return;
    }

    // Pinch: derive zoom from the live finger distance and keep the anchored
    // image point pinned under the moving midpoint. The rect is re-read each
    // move so the anchor stays correct even if the dialog scrolls mid-gesture.
    const el = areaRef.current;
    const nat = naturalRef.current;
    if (!el || !nat) return;
    const [a, b] = [...pointers.current.values()];
    if (!a || !b) return;
    const rect = el.getBoundingClientRect();
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const midX = (a.x + b.x) / 2 - rect.left;
    const midY = (a.y + b.y) / 2 - rect.top;
    const z = Math.min(
      MAX_ZOOM,
      Math.max(1, g.startZoom * (dist / g.startDist))
    );
    const newScale = baseScaleFor(nat) * z;
    setView({
      zoom: z,
      x: clampPos(midX - g.ix * newScale, nat.w * newScale),
      y: clampPos(midY - g.iy * newScale, nat.h * newScale),
    });
  }

  function onPointerUp(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId);
    // Re-anchor to the remaining pointers: 3→2 re-frames the pinch, 2→1 hands
    // off to a fresh pan (no jump), 1→0 ends the gesture.
    resyncGesture();
  }

  // Native, non-passive wheel listener so we can prevent the page from scrolling
  // while zooming over the crop area (React's onWheel is passive in some browsers).
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      applyZoom((z) => z * factor);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [applyZoom]);

  // Esc cancels (capture phase so it doesn't also reach background handlers).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  function confirm() {
    const img = imgRef.current;
    if (!img || !natural || busy) return;
    setBusy(true);
    // Map the visible viewport square back to source-image pixels.
    const srcSize = VIEWPORT / scale;
    const srcX = -view.x / scale;
    const srcY = -view.y / scale;
    const canvas = document.createElement("canvas");
    canvas.width = OUTPUT;
    canvas.height = OUTPUT;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setBusy(false);
      return;
    }
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, srcX, srcY, srcSize, srcSize, 0, 0, OUTPUT, OUTPUT);
    const type = ACCEPTED.has(file.type) ? file.type : "image/jpeg";
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          setBusy(false);
          return;
        }
        const ext =
          type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
        onCropped(new File([blob], `avatar.${ext}`, { type }));
      },
      type,
      0.92
    );
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 sm:p-8 dark:bg-black/70"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Crop photo"
        className="mt-[6vh] w-full max-w-sm rounded-xl bg-white p-4 shadow-xl sm:p-6 dark:bg-ink-900"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">
          Crop photo
        </h2>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Drag to reposition; pinch, scroll, or use the slider to zoom.
        </p>

        <div className="mt-4 flex justify-center">
          <div
            ref={areaRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            style={{ width: VIEWPORT, height: VIEWPORT }}
            className="relative touch-none select-none overflow-hidden rounded-lg bg-slate-100 dark:bg-ink-950"
          >
            {url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={url}
                alt=""
                draggable={false}
                onLoad={(e) => onImgLoad(e.currentTarget)}
                style={{
                  position: "absolute",
                  left: view.x,
                  top: view.y,
                  width: scaledW,
                  height: scaledH,
                  maxWidth: "none",
                  cursor: "grab",
                }}
              />
            )}
            {/* Circular overlay: darken outside the crop circle and draw its ring. */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 rounded-lg"
              style={{
                boxShadow: "0 0 0 9999px rgba(0,0,0,0.45)",
                clipPath: `circle(${VIEWPORT / 2}px at center)`,
              }}
            />
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 rounded-full ring-1 ring-white/70"
            />
          </div>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <span className="text-xs text-slate-400 dark:text-slate-500">−</span>
          <input
            type="range"
            min={1}
            max={MAX_ZOOM}
            step={0.01}
            value={view.zoom}
            disabled={!natural}
            onChange={(e) => {
              const target = Number(e.target.value);
              applyZoom(() => target);
            }}
            className="h-1 flex-1 cursor-pointer accent-brand-600"
            aria-label="Zoom"
          />
          <span className="text-xs text-slate-400 dark:text-slate-500">+</span>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="btn-ghost">
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={!natural || busy}
            className="btn"
          >
            Save photo
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
