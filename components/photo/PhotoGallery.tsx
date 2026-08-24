"use client";

import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useFocusTrap } from "@/components/useFocusTrap";
import { useResettableState } from "@/components/useResettableState";
import { IconChevronLeft, IconChevronRight, IconX } from "@tabler/icons-react";
import { EmptyState } from "@/components/ui";
import {
  dateGroups,
  filterBySeries,
  lightboxNeighbors,
  selectableDomains,
  type GalleryDomain,
  type GalleryPhoto,
} from "@/lib/photo/gallery-model";

// The BROWSE half of the shared photo core's view pair (#1119 phase 1). Per-
// domain but domain-SELECTABLE: exactly one domain's photos render at a time
// (physique OR skin OR symptom — never co-mingled; the privacy tier separation
// is the point), with a segmented control to switch domains. Only domains that
// actually have photos are offered (#1042-style gating), and a single-domain
// gallery collapses the selector entirely. Within a domain, series chips narrow
// the grid (pose / lesion / episode); "All" shows the whole collection,
// most-recent-first, date-grouped. The grid reads THUMBNAILS; the lightbox loads
// the original on open (still id-and-profile-scoped by the serve route) with
// prev/next paging within the current filtered set.
//
// Sibling of PhotoTimeline over the same series model (#221): the gallery is the
// index, the timeline is the comparison — `renderCompare`/`renderActions` let
// the domain surface wire "jump to compare" and delete without this component
// knowing any domain's routes or actions.

export default function PhotoGallery({
  domains,
  seriesFilter,
  onSeriesFilterChange,
  renderActions,
}: {
  domains: GalleryDomain[];
  // Controlled series filter for the ACTIVE domain (lets a page's pose tabs and
  // the gallery share one state). Uncontrolled when omitted.
  seriesFilter?: string | null;
  onSeriesFilterChange?: (key: string | null) => void;
  // Domain-owned lightbox actions for a photo (delete button, compare link…).
  // `close` lets an action dismiss the lightbox — a domain edit that changes the
  // photo's SERIES or DATE re-sorts the filtered set under the open index, so the
  // honest move is to return to the grid rather than page a stale position.
  renderActions?: (
    photo: GalleryPhoto,
    helpers: { close: () => void }
  ) => ReactNode;
}) {
  const usable = useMemo(() => selectableDomains(domains), [domains]);
  const [domainKey, setDomainKey] = useState<string | null>(
    usable[0]?.key ?? null
  );
  const domain = usable.find((d) => d.key === domainKey) ?? usable[0] ?? null;

  const [internalSeries, setInternalSeries] = useState<string | null>(null);
  const series = seriesFilter !== undefined ? seriesFilter : internalSeries;
  const setSeries = useCallback(
    (key: string | null) => {
      setInternalSeries(key);
      onSeriesFilterChange?.(key);
    },
    [onSeriesFilterChange]
  );

  const filtered = useMemo(
    () => (domain ? filterBySeries(domain.photos, series) : []),
    [domain, series]
  );
  const groups = useMemo(() => dateGroups(filtered), [filtered]);
  // Lightbox paging follows the visible (grid) order.
  const flat = useMemo(() => groups.flatMap((g) => g.photos), [groups]);

  // A filter/domain change — or a photo count change (e.g. a delete refreshed
  // the props) — invalidates the open index in the same render.
  const lightboxKey = `${domainKey ?? ""}\0${series ?? ""}\0${flat.length}`;
  const [lightbox, setLightbox] = useResettableState<number | null>(
    null,
    lightboxKey
  );

  // A RECORDED EXCEPTION TO THE DIALOG-HOST CONVERGENCE (#3405) — see
  // docs/internals/overlays.md. The lightbox below is a full-bleed media viewer:
  // a black ground with the original `object-contain` to the viewport edges and
  // its own prev/next paging. The converged host renders a titled card on an
  // opaque `bg-surface` with padding and a scroll owner, which is the wrong shape
  // for looking at a photograph, and the sheet's swipe-down dismissal would
  // arbitrate against the horizontal paging the viewer reaches for first.
  //
  // AN EXCEPTION FROM THE HOST IS NOT AN EXCEPTION FROM BEING USABLE. A recorded
  // exception is about PRESENTATION; it never buys a surface out of the
  // accessibility floor. So everything a modal owes a keyboard user still comes
  // from the shared hook: initial focus, the Tab trap, capture-phase Escape and
  // focus restored to the thumbnail that opened it.
  //
  // That is not a tidy-up. This used to answer Escape on the panel's own
  // `onKeyDown`, which fires only once focus is already inside — and nothing put
  // it there, so Escape did nothing at all unless the viewer happened to Tab
  // first. The hand-rolled presentation had quietly taken the keyboard exit with
  // it, which is exactly what an exception must not be allowed to do.
  const lightboxRef = useRef<HTMLDivElement>(null);
  const closeLightbox = useCallback(() => setLightbox(null), [setLightbox]);
  useFocusTrap({
    panelRef: lightboxRef,
    onClose: closeLightbox,
    active: lightbox != null,
  });

  if (!domain) {
    // The shared "nothing here yet" panel rather than a bare line of grey text
    // (#2536, #2615 item 4). `compact` because this sits under a page that already
    // carries its own heading and capture control — the destination the copy would
    // otherwise name is the button directly above it.
    return (
      <EmptyState
        compact
        testId="photo-gallery-empty"
        message="No photos yet."
      />
    );
  }

  const open = lightbox != null ? flat[lightbox] : null;
  const neighbors =
    lightbox != null ? lightboxNeighbors(lightbox, flat.length) : null;

  return (
    <div className="space-y-3" data-testid="photo-gallery">
      {usable.length > 1 ? (
        <div
          className="flex flex-wrap gap-1"
          role="tablist"
          aria-label="Photo domain"
        >
          {usable.map((d) => (
            <button
              key={d.key}
              type="button"
              role="tab"
              aria-selected={d.key === domain.key}
              className="chip chip-filter"
              onClick={() => {
                setDomainKey(d.key);
                setSeries(null);
              }}
              data-testid={`photo-gallery-domain-${d.key}`}
            >
              {d.label}
            </button>
          ))}
        </div>
      ) : null}

      {domain.series.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {[{ key: null as string | null, label: "All" }, ...domain.series].map(
            (s) => (
              <button
                key={s.key ?? "__all"}
                type="button"
                aria-pressed={series === s.key}
                className="chip chip-filter chip-sm"
                onClick={() => setSeries(s.key)}
                data-testid={`photo-gallery-series-${s.key ?? "all"}`}
              >
                {s.label}
              </button>
            )
          )}
        </div>
      ) : null}

      {groups.length === 0 ? (
        <p
          className="text-sm text-slate-500 dark:text-slate-400"
          data-testid="photo-gallery-empty"
        >
          No photos here yet.
        </p>
      ) : (
        groups.map((g) => (
          <section key={g.date}>
            <h3 className="section-label mb-1.5">{g.date}</h3>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
              {g.photos.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="group relative aspect-3/4 overflow-hidden rounded-lg bg-black/5 dark:bg-white/5"
                  onClick={() => setLightbox(flat.indexOf(p))}
                  data-testid={`photo-gallery-item-${p.id}`}
                >
                  {/* Grid reads the THUMBNAIL — the original loads on lightbox open. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={p.thumbUrl}
                    alt={p.caption ?? `Photo from ${p.date}`}
                    loading="lazy"
                    className="h-full w-full object-cover transition group-hover:scale-105"
                  />
                </button>
              ))}
            </div>
          </section>
        ))
      )}

      {open ? (
        <div
          ref={lightboxRef}
          className="fixed inset-0 z-50 flex flex-col bg-black/90 p-3"
          role="dialog"
          aria-modal="true"
          aria-label={`Photo from ${open.date}`}
          data-testid="photo-lightbox"
          onKeyDown={(e) => {
            // Escape is the shared hook's, on the capture phase (above). The
            // arrows stay here: paging is this surface's own vocabulary.
            if (e.key === "ArrowLeft" && neighbors?.prev != null)
              setLightbox(neighbors.prev);
            if (e.key === "ArrowRight" && neighbors?.next != null)
              setLightbox(neighbors.next);
          }}
        >
          <div className="flex items-center justify-end">
            <button
              type="button"
              className="rounded-full p-2 text-white/80 hover:bg-ink-750 hover:text-white"
              onClick={() => setLightbox(null)}
              aria-label="Close"
              title="Close"
              data-testid="photo-lightbox-close"
            >
              <IconX size={22} aria-hidden />
            </button>
          </div>
          <div className="relative flex min-h-0 flex-1 items-center justify-center">
            {neighbors?.prev != null ? (
              <button
                type="button"
                className="absolute left-0 z-10 rounded-full p-2 text-white/80 hover:bg-ink-750 hover:text-white"
                onClick={() => setLightbox(neighbors.prev)}
                aria-label="Previous photo"
                title="Previous photo"
                data-testid="photo-lightbox-prev"
              >
                <IconChevronLeft size={26} aria-hidden />
              </button>
            ) : null}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={open.url}
              alt={open.caption ?? `Photo from ${open.date}`}
              className="max-h-full max-w-full object-contain"
              data-testid="photo-lightbox-image"
            />
            {neighbors?.next != null ? (
              <button
                type="button"
                className="absolute right-0 z-10 rounded-full p-2 text-white/80 hover:bg-ink-750 hover:text-white"
                onClick={() => setLightbox(neighbors.next)}
                aria-label="Next photo"
                title="Next photo"
                data-testid="photo-lightbox-next"
              >
                <IconChevronRight size={26} aria-hidden />
              </button>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 text-sm text-white/90">
            <div>
              <span className="font-medium">{open.date}</span>
              {open.meta ? (
                <span className="text-white/60"> · {open.meta}</span>
              ) : null}
              {open.caption ? (
                <div className="wrap-break-word text-white/70">
                  {open.caption}
                </div>
              ) : null}
            </div>
            {renderActions ? (
              <div className="flex items-center gap-2">
                {renderActions(open, { close: () => setLightbox(null) })}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
