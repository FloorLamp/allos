"use client";

import { useMemo, useState } from "react";
import {
  timelineOrder,
  defaultComparePair,
  type GalleryPhoto,
} from "@/lib/photo/gallery-model";

// The COMPARE half of the shared photo core's view pair (#1119 phase 1; #221 —
// PhotoGallery browses, PhotoTimeline compares, both over the same series
// model). Given one series (one pose / one lesion / one episode), renders a
// two-date comparison: side-by-side by default, an ONION-SKIN overlay (photo B
// ghosted over photo A with an opacity slider) on toggle, and a thumbnail strip
// to pick either endpoint. Factual captions only (date + the domain's meta line,
// e.g. the physique weight snapshot) — nothing here scores or measures change.

export default function PhotoTimeline({
  photos,
  emptyHint = "Add at least two photos to compare over time.",
}: {
  photos: GalleryPhoto[];
  emptyHint?: string;
}) {
  const series = useMemo(() => timelineOrder(photos), [photos]);
  const pair = defaultComparePair(series.length);
  const [aIdx, setAIdx] = useState(pair?.a ?? 0);
  const [bIdx, setBIdx] = useState(pair?.b ?? 0);
  const [overlay, setOverlay] = useState(false);
  const [opacity, setOpacity] = useState(0.5);

  if (series.length < 2) {
    return (
      <p className="text-sm text-slate-500 dark:text-slate-400">{emptyHint}</p>
    );
  }
  const a = series[Math.min(aIdx, series.length - 1)];
  const b = series[Math.min(bIdx, series.length - 1)];

  const caption = (p: GalleryPhoto) => (
    <span>
      {p.date}
      {p.meta ? <span className="text-slate-400"> · {p.meta}</span> : null}
    </span>
  );

  return (
    <div className="space-y-3" data-testid="photo-timeline">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-1.5">
          <span className="text-slate-500 dark:text-slate-400">From</span>
          <select
            className="input py-1 text-sm"
            value={aIdx}
            onChange={(e) => setAIdx(Number(e.target.value))}
            data-testid="photo-timeline-a"
          >
            {series.map((p, i) => (
              <option key={p.id} value={i}>
                {p.date}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-slate-500 dark:text-slate-400">To</span>
          <select
            className="input py-1 text-sm"
            value={bIdx}
            onChange={(e) => setBIdx(Number(e.target.value))}
            data-testid="photo-timeline-b"
          >
            {series.map((p, i) => (
              <option key={p.id} value={i}>
                {p.date}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={overlay}
            onChange={(e) => setOverlay(e.target.checked)}
            data-testid="photo-timeline-overlay-toggle"
          />
          Onion-skin overlay
        </label>
        {overlay ? (
          <label className="flex items-center gap-1.5">
            <span className="text-slate-500 dark:text-slate-400">Blend</span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(opacity * 100)}
              onChange={(e) => setOpacity(Number(e.target.value) / 100)}
              data-testid="photo-timeline-opacity"
            />
          </label>
        ) : null}
      </div>

      {overlay ? (
        <figure data-testid="photo-timeline-overlay">
          <div className="relative overflow-hidden rounded-lg bg-black">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={a.url}
              alt={`Photo from ${a.date}`}
              className="w-full object-contain"
            />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={b.url}
              alt={`Photo from ${b.date}`}
              className="absolute inset-0 h-full w-full object-contain"
              style={{ opacity }}
            />
          </div>
          <figcaption className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {caption(a)} → {caption(b)}
          </figcaption>
        </figure>
      ) : (
        <div
          className="grid grid-cols-2 gap-2"
          data-testid="photo-timeline-side"
        >
          {[a, b].map((p, i) => (
            <figure key={i}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={p.url}
                alt={`Photo from ${p.date}`}
                className="w-full rounded-lg object-contain"
              />
              <figcaption className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {caption(p)}
              </figcaption>
            </figure>
          ))}
        </div>
      )}

      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {series.map((p, i) => (
          <button
            key={p.id}
            type="button"
            title={`${p.date} — set compare endpoint`}
            className={`shrink-0 overflow-hidden rounded-md border-2 ${
              i === bIdx
                ? "border-brand-500"
                : i === aIdx
                  ? "border-slate-400"
                  : "border-transparent"
            }`}
            onClick={(e) => (e.shiftKey ? setAIdx(i) : setBIdx(i))}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={p.thumbUrl}
              alt={p.date}
              className="h-16 w-12 object-cover"
            />
          </button>
        ))}
      </div>
    </div>
  );
}
