"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { IconChevronLeft, IconChevronRight, IconX } from "@tabler/icons-react";
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
  renderActions?: (photo: GalleryPhoto) => ReactNode;
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

  const [lightbox, setLightbox] = useState<number | null>(null);
  useEffect(() => {
    // A filter/domain change — or a photo count change (e.g. a delete refreshed
    // the props) — invalidates the open index.
    setLightbox(null);
  }, [domainKey, series, flat.length]);

  if (!domain) {
    return (
      <p
        className="text-sm text-slate-500 dark:text-slate-400"
        data-testid="photo-gallery-empty"
      >
        No photos yet.
      </p>
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
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                d.key === domain.key
                  ? "bg-brand-600 text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-ink-800 dark:text-slate-300 dark:hover:bg-ink-750"
              }`}
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
                className={`rounded-full px-3 py-1 text-xs font-medium ${
                  series === s.key
                    ? "bg-brand-100 text-brand-800 dark:bg-brand-900/50 dark:text-brand-200"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-ink-800 dark:text-slate-300 dark:hover:bg-ink-750"
                }`}
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
                  className="group relative aspect-[3/4] overflow-hidden rounded-lg bg-black/5 dark:bg-white/5"
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
          className="fixed inset-0 z-50 flex flex-col bg-black/90 p-3"
          role="dialog"
          aria-modal="true"
          aria-label={`Photo from ${open.date}`}
          data-testid="photo-lightbox"
          onKeyDown={(e) => {
            if (e.key === "Escape") setLightbox(null);
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
                <div className="break-words text-white/70">{open.caption}</div>
              ) : null}
            </div>
            {renderActions ? (
              <div className="flex items-center gap-2">
                {renderActions(open)}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
